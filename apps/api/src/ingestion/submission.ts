// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story-submission orchestration (WS-F.1.4a, SPEC §14.1/§23.2). Guard order
// after route-level auth + zod validation:
//
//   1. per-account submission rate limit (429 + Retry-After)
//   2. account-age + spam-pattern + URL-safety pre-checks (403)
//   3. URL normalization (400 on malformed/unsupported)
//   4. evidence-card claim-reference existence (400)
//   5. exact-URL duplicate (409 + the existing story id — WS-F.1.3b; the
//      duplicate shape is identical whether or not the requester could see
//      the existing story: no visibility oracle)
//   6. transactional story + thread-shell creation (unique-index race-safe)
//   7. synchronous near-duplicate check on the LOCAL text (the submitter is
//      informed via similar_story_ids; link stories get the second, fetched-
//      text pass in the async pipeline)
//   8. `content.submitted` emission — stored durably, then published
//      DETACHED so pipeline latency never delays the 201 (WS-F.1.4c).
import { randomUUID } from 'node:crypto';
import {
  type ContentSubmittedEvent,
  canonicalizeBcp47,
  contentSubmittedEventSchema,
  DEFAULT_TRACKER_DENYLIST,
  evidenceAddedEventSchema,
  normalizeUrl,
  type StoryCreateRequest,
  TOPIC_REGISTRY,
  type TrackerDenylist,
} from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import { accountRef } from '../identity/crypto.js';
import type { IdentityServices } from '../identity/services.js';
import { findNearDuplicates, signatureStory } from './dedup.js';
import { submissionText } from './pipeline.js';
import { evaluatePrechecks, titleHash } from './prechecks.js';
import type { IngestionServices } from './services.js';
import type { StoryRecord } from './stores.js';

export type SubmissionRejection =
  | { status: 429; code: 'rate_limited'; message: string; retryAfterSec: number }
  | { status: 403; code: string; message: string }
  | { status: 400; code: string; message: string }
  | { status: 409; code: 'duplicate_story'; message: string; existingStoryId: string };

export type SubmissionOutcome =
  | {
      ok: true;
      story: StoryRecord;
      threadId: string;
      similarStoryIds: string[];
      reviewFlags: Array<'near_duplicate' | 'syndicated_copy_candidate'>;
    }
  | { ok: false; rejection: SubmissionRejection };

/** The per-type metadata payload extracted from the validated request. */
function metadataOf(request: StoryCreateRequest): StoryRecord['submissionMetadata'] {
  switch (request.submission_type) {
    case 'link':
      return { submission_type: 'link', url: request.url, reason: request.reason };
    case 'original_brief':
      return {
        submission_type: 'original_brief',
        body: request.body,
        ...(request.personal_experience_disclosure !== undefined
          ? { personal_experience_disclosure: request.personal_experience_disclosure }
          : {}),
      };
    case 'question':
      return {
        submission_type: 'question',
        question: request.question,
        ...(request.context !== undefined ? { context: request.context } : {}),
      };
    case 'evidence_card':
      return {
        submission_type: 'evidence_card',
        citation_url_or_ref: request.citation_url_or_ref,
        claim_id: request.claim_id,
        relevance_note: request.relevance_note,
      };
    case 'local_update':
      return {
        submission_type: 'local_update',
        location_scope: request.location_scope,
        ...(request.time_reference !== undefined ? { time_reference: request.time_reference } : {}),
        source_or_experience_disclosure: request.source_or_experience_disclosure,
      };
    case 'live_thread':
      return {
        submission_type: 'live_thread',
        event_description: request.event_description,
        time_reference: request.time_reference,
        moderation_mode: request.moderation_mode,
      };
  }
}

/** A generic, NON-IDENTIFYING rejection for a duplicate URL whose existing
 *  story is hidden — leaks neither the id nor the existence of the hidden
 *  discussion (WS-F.1.4f). The shape matches the other 403 holds so the
 *  client cannot distinguish this case. */
function hiddenDuplicateRejection(): SubmissionRejection {
  return {
    status: 403,
    code: 'held_for_review',
    message: 'This submission could not be accepted.',
  };
}

/** Merge the configured extra tracker params into the shared denylist. */
export function effectiveTrackerDenylist(extra: readonly string[]): TrackerDenylist {
  if (extra.length === 0) return DEFAULT_TRACKER_DENYLIST;
  return {
    exact: new Set([...DEFAULT_TRACKER_DENYLIST.exact, ...extra.map((p) => p.toLowerCase())]),
    prefixes: DEFAULT_TRACKER_DENYLIST.prefixes,
  };
}

export async function submitStory(
  ingestion: IngestionServices,
  events: EventPipelineServices,
  identity: IdentityServices,
  userId: string,
  request: StoryCreateRequest,
): Promise<SubmissionOutcome> {
  const config = ingestion.config();
  const nowMs = ingestion.now();

  // 1. Rate limit (per-account sliding windows; non-reversible key, §19.1).
  const decision = await ingestion.submissionLimiter.hit(
    accountRef(identity.config.masterSecret, userId),
    { perHour: config.submissionPerHour, perDay: config.submissionPerDay },
    nowMs,
  );
  if (!decision.allowed) {
    return {
      ok: false,
      rejection: {
        status: 429,
        code: 'rate_limited',
        message: 'Submission rate limit reached',
        retryAfterSec: decision.retryAfterSec,
      },
    };
  }

  // 2. URL normalization first (the canonical domain feeds the pre-checks).
  let canonicalUrl: string | null = null;
  let canonicalDomain: string | null = null;
  if (request.submission_type === 'link') {
    const normalized = normalizeUrl(
      request.url,
      effectiveTrackerDenylist(config.extraTrackerParams),
    );
    if (!normalized.ok) {
      return {
        ok: false,
        rejection: {
          status: 400,
          code: 'invalid_url',
          message: `URL rejected: ${normalized.reason}`,
        },
      };
    }
    canonicalUrl = normalized.canonicalUrl;
    canonicalDomain = normalized.canonicalDomain;
  }

  // 3. Pre-checks (WS-F.1.4c): account age, spam title pattern, URL safety.
  const user = await identity.store.getUser(userId);
  if (!user) {
    return {
      ok: false,
      rejection: { status: 403, code: 'forbidden', message: 'Account unavailable' },
    };
  }
  const hash = titleHash(request.title);
  const windowStart = new Date(nowMs - config.duplicateTitleWindowMinutes * 60_000).toISOString();
  const rejection = evaluatePrechecks({
    accountCreatedAtIso: user.createdAt,
    nowMs,
    minAccountAgeMinutes: config.minAccountAgeMinutes,
    duplicateTitleCount: await ingestion.stories.countByTitleHashSince(hash, windowStart),
    duplicateTitleLimit: config.duplicateTitleLimit,
    canonicalDomain,
    urlVerdict: canonicalDomain !== null ? await ingestion.urlSafety.check(canonicalDomain) : null,
  });
  if (rejection !== null) {
    ingestion.metrics.increment(`prechecks.${rejection.code}`);
    if (rejection.code === 'url_safety_unavailable_hold') {
      // Fail toward caution (WS-F.1.4c): hold for review, do not publish.
      await ingestion.reviewQueue.insert({
        kind: 'url_safety_hold',
        storyId: null,
        context: { canonical_url: canonicalUrl, submitted_by: userId },
        status: 'pending',
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        notBefore: null,
      });
      return {
        ok: false,
        rejection: {
          status: 403,
          code: 'held_for_review',
          message: 'Link checks are temporarily unavailable; the submission is held for review',
        },
      };
    }
    const messages: Record<string, string> = {
      account_too_new: `New accounts can submit after a short waiting period (${
        rejection.code === 'account_too_new' ? rejection.waitMinutes : 0
      } minutes remaining)`,
      duplicate_title_spam: 'Identical titles were submitted too many times recently',
      malicious_url: 'This link matches a known malware or phishing domain',
    };
    return {
      ok: false,
      rejection: {
        status: rejection.code === 'account_too_new' ? 403 : 403,
        code: rejection.code,
        message: messages[rejection.code] ?? 'Submission rejected by safety pre-checks',
      },
    };
  }

  // 4. Evidence cards must reference an EXISTING claim (WS-F.1.4b).
  if (request.submission_type === 'evidence_card') {
    const claim = await ingestion.claims.getById(request.claim_id);
    if (claim === null) {
      return {
        ok: false,
        rejection: {
          status: 400,
          code: 'unknown_claim',
          message: 'The referenced claim_id does not exist',
        },
      };
    }
  }

  // 5. Exact-URL duplicate (WS-F.1.3b): index lookup, then the create path's
  //    unique-index outcome closes the concurrent race.
  if (canonicalUrl !== null) {
    const existing = await ingestion.stories.getByCanonicalUrl(canonicalUrl);
    if (existing !== null) {
      ingestion.metrics.increment('dedup.exact_url_409');
      // A takedown-/safety-hidden duplicate must NOT have its id (or its
      // existence) revealed — that would leak a non-visible discussion and
      // confirm a hidden story exists for the URL. Return a generic,
      // non-identifying rejection instead (WS-F.1.4f privacy posture).
      if (existing.hiddenState !== null) {
        ingestion.metrics.increment('dedup.exact_url_hidden');
        return { ok: false, rejection: hiddenDuplicateRejection() };
      }
      ingestion.log('ingestion.duplicate_url', {
        existing_story_id: existing.storyId,
        submitted_by: userId,
      });
      return {
        ok: false,
        rejection: {
          status: 409,
          code: 'duplicate_story',
          message: 'This link has already been submitted — join the existing discussion',
          existingStoryId: existing.storyId,
        },
      };
    }
  }

  // 6. Transactional create (story + thread shell, WS-F.1.4d).
  const storyId = randomUUID();
  const threadId = randomUUID();
  const created = await ingestion.stories.createWithThread(
    {
      storyId,
      canonicalUrl,
      title: request.title,
      titleHash: hash,
      submittedBy: userId,
      sourceId: null,
      language: request.language !== undefined ? canonicalizeBcp47(request.language) : null,
      topicIds: [...request.topic_ids],
      locationScope: request.location_scope ?? null,
      sensitivityLabels: [...(request.sensitivity_labels ?? ['none'])],
      lifecycleState: 'submitted',
      submissionType: request.submission_type,
      submissionMetadata: metadataOf(request),
      excerpt: null,
      publisher: null,
      author: null,
      publishedAt: null,
      mediaType: null,
      extractionState: 'pending',
      hiddenState: null,
    },
    threadId,
  );
  if (!created.ok) {
    // Same hidden-duplicate guard on the concurrent-race outcome: re-fetch the
    // winning story and withhold its id if it is hidden.
    const racedExisting = await ingestion.stories.getById(created.existingStoryId);
    if (racedExisting !== null && racedExisting.hiddenState !== null) {
      ingestion.metrics.increment('dedup.exact_url_hidden');
      return { ok: false, rejection: hiddenDuplicateRejection() };
    }
    return {
      ok: false,
      rejection: {
        status: 409,
        code: 'duplicate_story',
        message: 'This link has already been submitted — join the existing discussion',
        existingStoryId: created.existingStoryId,
      },
    };
  }
  ingestion.metrics.increment(`submissions.${request.submission_type}`);

  // 6b. Evidence-card submissions create the actual EvidenceCard row in the
  //     same request (WS-F.2.5a), then emit `evidence.added` so the
  //     `ingestion-embeddings` consumer generates the card's vector
  //     (WS-F.3.2c) — durable insert now, publication DETACHED so embedding
  //     latency never delays the 201 (crash recovery = checkpoint replay,
  //     the content.submitted pattern).
  if (request.submission_type === 'evidence_card') {
    // Resolve a WEB citation to an in-app source so the §14.3 evidence-type
    // frequency populates (WS-F.2.1a); a non-web citation (book, filing,
    // dataset id) stays source-less — "user-experience evidence" (WS-F.2.5a).
    let evidenceSourceId: string | null = null;
    const citation = normalizeUrl(
      request.citation_url_or_ref,
      effectiveTrackerDenylist(config.extraTrackerParams),
    );
    if (citation.ok) {
      const citationSource = await ingestion.sources.upsertByDomain(citation.canonicalDomain, {
        name: citation.canonicalDomain,
      });
      evidenceSourceId = citationSource.sourceId;
    }
    const card = await ingestion.evidence.insert({
      evidenceId: randomUUID(),
      claimId: request.claim_id,
      sourceId: evidenceSourceId,
      submittedBy: userId,
      // The §14.1 evidence-card submission carries no relationship
      // direction; `contextualizes` is the NEUTRAL default (asserting
      // `supports` would fabricate a stance). WS-G's evidence flows attach
      // explicit typed relationships.
      evidenceType: 'contextualizes',
      citationUrlOrRef: request.citation_url_or_ref,
      relevanceNote: request.relevance_note,
      verificationState: 'unverified',
      independenceGroupId: null,
      storyId: created.story.storyId,
    });
    // Bump the source's §14.3 evidence-type frequency by the card's
    // relationship type (the field that was otherwise never populated).
    if (evidenceSourceId !== null) {
      await ingestion.sources.recordObservation(evidenceSourceId, {
        evidenceType: 'contextualizes',
      });
    }
    // Attribute the material-update signal to the discussion the CLAIM lives
    // in: the ingestion-signals consumer resolves thread_id → story → freshness
    // /lifecycle, so evidence added to an existing claim must advance the story
    // CONTAINING that claim, not the new evidence-card shell. A story-less
    // (cross-story) claim falls back to the shell thread.
    const referencedClaim = await ingestion.claims.getById(request.claim_id);
    let evidenceThreadId = created.thread.threadId;
    if (referencedClaim?.storyId != null) {
      const claimThread = await ingestion.stories.getThreadByStoryId(referencedClaim.storyId);
      if (claimThread !== null) evidenceThreadId = claimThread.threadId;
    }
    // The WS-E `evidence.added` event carries the MATERIAL taxonomy (what the
    // evidence IS), distinct from the card's RELATIONSHIP type; a §14.1
    // submission gives no material classification, so `other` is the honest
    // default (the governed classifier is the WS-K seam).
    const evidenceEvent = evidenceAddedEventSchema.parse({
      event_id: randomUUID(),
      event_type: 'evidence.added',
      timestamp: created.story.createdAt,
      schema_version: '1',
      evidence_id: card.evidenceId,
      claim_id: card.claimId,
      thread_id: evidenceThreadId,
      user_id: userId,
      evidence_type: 'other',
      source_id: evidenceSourceId,
      contribution_id: null,
      privacy_classification: 'public',
      retention_tier: 'public_contribution',
    });
    const evidenceRegistryEntry = TOPIC_REGISTRY['evidence.added'];
    await events.eventStore.insertMany([
      {
        eventId: evidenceEvent.event_id,
        eventType: evidenceEvent.event_type,
        topic: evidenceEvent.event_type,
        timestamp: evidenceEvent.timestamp,
        privacyClassification: evidenceRegistryEntry.privacy_classification,
        retentionTier: evidenceRegistryEntry.retention_tier,
        payload: evidenceEvent as unknown as Record<string, unknown>,
        ownerUserId: userId,
        purgeAfter: null,
      },
    ]);
    ingestion.trackBackground(events.router.publish(evidenceEvent));
  }

  // 7. SYNC near-duplicate pass on the locally available text (WS-F.1.3c):
  //    informs the submitter immediately; link stories re-check post-fetch.
  const localText = submissionText(created.story);
  const { signature, bands } = await signatureStory(
    ingestion.signatures,
    created.story.storyId,
    localText,
    'submitted',
  );
  const similar = await findNearDuplicates(
    ingestion.signatures,
    created.story.storyId,
    signature,
    bands,
    config.nearDuplicateThreshold,
    5,
  );
  const reviewFlags: Array<'near_duplicate' | 'syndicated_copy_candidate'> = [];
  if (similar.length > 0) {
    reviewFlags.push('near_duplicate');
    await ingestion.reviewQueue.insert({
      kind: 'near_duplicate',
      storyId: created.story.storyId,
      context: {
        similar: similar.map((s) => ({ story_id: s.storyId, estimate: s.estimatedJaccard })),
        text_source: 'submitted',
      },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      notBefore: null,
    });
    ingestion.metrics.increment('dedup.flagged_near_duplicate_sync');
  }

  // 8. Emit content.submitted: durable insert NOW; publication (which runs
  //    the extraction pipeline in-process) is detached so the 201 returns
  //    within the pre-check latency budget. Crash between insert and publish
  //    is recovered by the durable consumer's checkpoint replay at boot.
  const event: ContentSubmittedEvent = contentSubmittedEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'content.submitted',
    timestamp: created.story.createdAt,
    schema_version: '1',
    story_id: created.story.storyId,
    submitted_by: userId,
    submission_type: created.story.submissionType,
    canonical_url: created.story.canonicalUrl,
    topic_ids: created.story.topicIds,
    privacy_classification: 'public',
    retention_tier: 'public_contribution',
  });
  const registryEntry = TOPIC_REGISTRY['content.submitted'];
  await events.eventStore.insertMany([
    {
      eventId: event.event_id,
      eventType: event.event_type,
      topic: event.event_type,
      timestamp: event.timestamp,
      privacyClassification: registryEntry.privacy_classification,
      retentionTier: registryEntry.retention_tier,
      payload: event as unknown as Record<string, unknown>,
      ownerUserId: userId,
      purgeAfter: null,
    },
  ]);
  ingestion.trackBackground(events.router.publish(event));

  return {
    ok: true,
    story: created.story,
    threadId: created.thread.threadId,
    similarStoryIds: similar.map((s) => s.storyId),
    reviewFlags,
  };
}
