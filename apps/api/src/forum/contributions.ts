// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contribution creation/edit/removal service (WS-G.3.1/3.2, SPEC §23.2/§15.1
// /§15.5).  The CREATE guard chain, in order:
//
//   1. per-account sliding-window rate limit (10/min default; 429 +
//      Retry-After; keyed by a non-reversible account ref — never an IP),
//   2. thread existence + visibility (hidden story → 404, no oracle;
//      restricted-room thread → 404 to non-members; archived conversation or
//      restricted thread-safety → 409/403 typed),
//   3. client_draft_id dedup (idempotent create: the existing row returns),
//   4. per-type cross-record validation (WS-G.1.2b: answer→question parent,
//      same-thread parent + ≤10 depth, synthesis branch roots, known claims,
//      lens belongs to the thread's room, attachments owned + scanned),
//   5. safety pre-checks (WS-J.2.6 seam) — flagged content persists as
//      under_review (default-hidden, §18.4) and enters the review queue,
//   6. transactional insert (atomically with the evidence card for evidence
//      contributions, WS-G.3.2),
//   7. durable event emission: contribution.created (+ evidence.added), the
//      WS-E scoring mapping below, accusation + low-info classification —
//      events carry ids/types/flags ONLY, never body text.
//
// Body text is stored verbatim (raw Markdown-lite); sanitization is
// exclusively render-time (WS-G.4).  Logs and metrics carry ids and counts
// only — no UGC text, no PII.
import { randomUUID } from 'node:crypto';
import { classifyAccusationV0, classifyLowInfoReplyV0 } from '@licio/invariants';
import {
  type Citation,
  CONTRIBUTION_BODY_LIMITS,
  type ContributionCreate,
  type ContributionMetadata,
  type ContributionType,
  type ContributionUpdate,
  contributionCreatedEventSchema,
  type EventContributionType,
  evidenceAddedEventSchema,
  MAX_CONTRIBUTION_DEPTH,
  TOPIC_REGISTRY,
} from '@licio/shared';
import { type SlidingWindowStore, slidingWindowRetryAfterMs } from '../events/ingest-limiter.js';
import type { EventPipelineServices } from '../events/services.js';
import type { NewStoredEvent } from '../events/stores.js';
import { getIdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { ForumServices } from './services.js';
import type { ContributionRecord, ForumEvidenceCardInput } from './stores.js';
import { maybeDeepenConversation } from './transitions.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Per-account contribution rate limiter (per-call limits — runtime tunable). */
export class ContributionRateLimiter {
  readonly #store: SlidingWindowStore;

  constructor(store: SlidingWindowStore) {
    this.#store = store;
  }

  async hit(
    accountRef: string,
    limits: { perMinute: number; perHour: number },
    now: number,
  ): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const minuteKey = `contrib:${accountRef}:m`;
    const hourKey = `contrib:${accountRef}:h`;
    const minuteCount = await this.#store.hit(minuteKey, now, MINUTE_MS);
    const hourCount = await this.#store.hit(hourKey, now, HOUR_MS);
    const violated: Array<{ key: string; windowMs: number; count: number; limit: number }> = [];
    if (minuteCount > limits.perMinute) {
      violated.push({
        key: minuteKey,
        windowMs: MINUTE_MS,
        count: minuteCount,
        limit: limits.perMinute,
      });
    }
    if (hourCount > limits.perHour) {
      violated.push({ key: hourKey, windowMs: HOUR_MS, count: hourCount, limit: limits.perHour });
    }
    if (violated.length === 0) return { allowed: true, retryAfterSec: 0 };
    const retryAfterMs = await slidingWindowRetryAfterMs(this.#store, now, violated);
    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1_000) };
  }
}

/** WS-G forum types → the WS-E scoring taxonomy (the emission boundary).
 *  `moderation_concern → flag` and `meta_discussion → low_info_reply` both
 *  carry ZERO constructive weight (§5.3: volume, not participation — and
 *  never negative).  `answer`/`local_context`/`direct_experience` fold into
 *  their closest scoring semantics. */
export const FORUM_TO_EVENT_TYPE: Readonly<Record<ContributionType, EventContributionType>> = {
  question: 'question',
  answer: 'explanation',
  evidence: 'evidence',
  correction: 'correction',
  synthesis: 'synthesis',
  counterexample: 'counterexample',
  explanation: 'explanation',
  local_context: 'experience',
  direct_experience: 'experience',
  moderation_concern: 'flag',
  meta_discussion: 'low_info_reply',
};

export type ContributionRejection =
  | { status: 404; code: 'not_found'; message: string }
  | { status: 403; code: 'thread_restricted'; message: string }
  | { status: 409; code: 'thread_archived'; message: string }
  | { status: 422; code: string; message: string }
  | { status: 429; code: 'rate_limited'; message: string; retryAfterSec: number };

export type ContributionCreateOutcome =
  | {
      ok: true;
      contribution: ContributionRecord;
      evidenceCardId: string | null;
      deduplicated: boolean;
    }
  | { ok: false; rejection: ContributionRejection };

interface ServiceBundle {
  forum: ForumServices;
  ingestion: IngestionServices;
  events: EventPipelineServices;
}

/** Assemble the canonical metadata object from a flat create request. */
export function metadataFromRequest(
  request: ContributionCreate,
  evidenceCardId: string | null,
): ContributionMetadata {
  const metadata: ContributionMetadata = {};
  if (request.lens_id !== undefined) metadata.lens_id = request.lens_id;
  if (request.attachment_ids !== undefined && request.attachment_ids.length > 0) {
    metadata.attachment_ids = [...request.attachment_ids];
  }
  switch (request.type) {
    case 'evidence':
      if (request.evidence_type !== undefined) metadata.evidence_type = request.evidence_type;
      if (evidenceCardId !== null) metadata.evidence_id = evidenceCardId;
      break;
    case 'correction':
      if (request.target_text_excerpt !== undefined) {
        metadata.target_text_excerpt = request.target_text_excerpt;
      }
      break;
    case 'synthesis':
      metadata.included_branch_ids = [...request.included_branch_ids];
      if (request.uncertainty_note !== undefined) {
        metadata.uncertainty_note = request.uncertainty_note;
      }
      break;
    case 'counterexample':
      metadata.relevance_explanation = request.relevance_explanation;
      if (request.source_url !== undefined) metadata.source_url = request.source_url;
      break;
    case 'explanation':
      if (request.assumptions !== undefined) metadata.assumptions = request.assumptions;
      if (request.caveats !== undefined) metadata.caveats = request.caveats;
      break;
    case 'local_context':
      metadata.scope = request.scope;
      if (request.location !== undefined) metadata.location = request.location;
      if (request.time_context !== undefined) metadata.time_context = request.time_context;
      break;
    case 'direct_experience':
      metadata.scope = request.scope;
      if (request.location !== undefined) metadata.location = request.location;
      if (request.time_context !== undefined) metadata.time_context = request.time_context;
      metadata.privacy_acknowledged = true;
      break;
    case 'moderation_concern':
      metadata.reason_code = request.reason_code;
      metadata.urgency = request.urgency ?? 'normal';
      metadata.target_contribution_id = request.target_contribution_id;
      break;
    case 'meta_discussion':
      if (request.target_contribution_id !== undefined) {
        metadata.target_contribution_id = request.target_contribution_id;
      }
      break;
    default:
      break;
  }
  return metadata;
}

function reject(rejection: ContributionRejection): ContributionCreateOutcome {
  return { ok: false, rejection };
}

function invalid(code: string, message: string): ContributionCreateOutcome {
  return reject({ status: 422, code, message });
}

/**
 * Thread visibility for WRITES and READS (WS-G.3 + 404-over-403): hidden
 * story → invisible; a restricted/expert_led room hides its threads from
 * non-members (stewards and active members see them).
 */
export async function threadVisibleToUser(
  bundle: Pick<ServiceBundle, 'forum' | 'ingestion'>,
  thread: { storyId: string; roomId: string | null },
  userId: string | null,
): Promise<boolean> {
  const story = await bundle.ingestion.stories.getById(thread.storyId);
  if (!story || story.hiddenState !== null) return false;
  if (thread.roomId === null) return true;
  const room = await bundle.forum.rooms.getById(thread.roomId);
  if (!room) return true; // orphaned room link — the thread itself is public
  if (room.visibility === 'public') return true;
  if (userId === null) return false;
  const subscription = await bundle.forum.rooms.getSubscription(room.roomId, userId);
  if (subscription?.status === 'active') return true;
  const roles = await bundle.forum.rooms.stewardRolesFor(room.roomId, userId);
  return roles.length > 0;
}

/** The WS-G.3.1 create flow (see module header for the guard chain). */
export async function createContribution(
  bundle: ServiceBundle,
  userId: string,
  accountRefValue: string,
  request: ContributionCreate,
): Promise<ContributionCreateOutcome> {
  const { forum, ingestion, events } = bundle;
  const config = forum.config();
  const nowMs = forum.now();

  // 1. Rate limit (WS-G.3.1: 429 + Retry-After).
  const decision = await forum.contributionLimiter.hit(
    accountRefValue,
    { perMinute: config.contributionsPerMinute, perHour: config.contributionsPerHour },
    nowMs,
  );
  if (!decision.allowed) {
    forum.metrics.increment('contributions.rate_limited');
    return reject({
      status: 429,
      code: 'rate_limited',
      message: 'Contribution rate limit reached',
      retryAfterSec: decision.retryAfterSec,
    });
  }

  // 2. Thread existence + visibility + state.
  const thread = await ingestion.stories.getThreadById(request.thread_id);
  if (!thread) return reject({ status: 404, code: 'not_found', message: 'Thread not found' });
  if (!(await threadVisibleToUser(bundle, thread, userId))) {
    return reject({ status: 404, code: 'not_found', message: 'Thread not found' });
  }
  if (thread.conversationState === 'archived') {
    return reject({
      status: 409,
      code: 'thread_archived',
      message: 'This thread is archived and no longer accepts contributions',
    });
  }
  if (thread.safetyState === 'restricted') {
    return reject({
      status: 403,
      code: 'thread_restricted',
      message: 'This thread is restricted while under safety review',
    });
  }

  // 3. Idempotent create: an existing draft id returns the existing row.
  const existing = await forum.contributions.getByDraft(userId, request.client_draft_id);
  if (existing) {
    forum.metrics.increment('contributions.deduplicated');
    return {
      ok: true,
      contribution: existing,
      evidenceCardId:
        typeof existing.metadata.evidence_id === 'string' ? existing.metadata.evidence_id : null,
      deduplicated: true,
    };
  }

  // 4. Per-type cross-record validation (WS-G.1.2b/1.2d-1).
  let parentPath: string[] = [];
  if (request.parent_contribution_id !== undefined) {
    const parent = await forum.contributions.getById(request.parent_contribution_id);
    if (!parent || parent.threadId !== request.thread_id) {
      return invalid('invalid_parent', 'The parent contribution must belong to the same thread.');
    }
    if (parent.path.length + 1 > MAX_CONTRIBUTION_DEPTH) {
      return invalid('max_depth_exceeded', 'Maximum thread depth exceeded.');
    }
    if (request.type === 'answer' && parent.type !== 'question') {
      return invalid('answer_requires_question', 'Answers must respond to a question.');
    }
    parentPath = [...parent.path, parent.contributionId];
  } else if (request.type === 'answer') {
    // Unreachable through the schema (parent is required there); kept as a
    // defense-in-depth guard for direct service callers.
    return invalid('answer_requires_question', 'Answers must respond to a question.');
  }

  if ('target_claim_id' in request && request.target_claim_id !== undefined) {
    const claim = await ingestion.claims.getById(request.target_claim_id);
    if (!claim) return invalid('unknown_claim', 'The referenced claim does not exist.');
  }

  if (request.type === 'synthesis') {
    const seen = new Set<string>();
    for (const branchId of request.included_branch_ids) {
      const branch = await forum.contributions.getById(branchId);
      if (!branch || branch.threadId !== request.thread_id) {
        return invalid(
          'invalid_branch',
          'Synthesis branches must be contributions in the same thread.',
        );
      }
      if (branch.parentContributionId !== null) {
        return invalid('invalid_branch', 'Synthesis branches must be top-level branch roots.');
      }
      seen.add(branchId);
    }
    if (seen.size < 2) {
      return invalid('synthesis_branches', 'Synthesis requires at least two branches.');
    }
  }

  if (request.type === 'moderation_concern' || request.type === 'meta_discussion') {
    const targetId =
      'target_contribution_id' in request ? request.target_contribution_id : undefined;
    if (targetId !== undefined) {
      const target = await forum.contributions.getById(targetId);
      if (!target || target.threadId !== request.thread_id) {
        return invalid(
          'invalid_target',
          'The targeted contribution must belong to the same thread.',
        );
      }
    }
  }

  if (request.lens_id !== undefined) {
    const lens = await forum.lenses.getById(request.lens_id);
    if (!lens || lens.roomId !== thread.roomId) {
      return invalid('invalid_lens', "The lens must belong to the thread's room.");
    }
  }

  if (request.attachment_ids !== undefined) {
    for (const uploadId of request.attachment_ids) {
      const upload = await forum.uploads.getRecord(uploadId);
      if (!upload || upload.ownerUserId !== userId) {
        return invalid('invalid_attachment', 'Attachments must be uploads you own.');
      }
      if (upload.scanState !== 'clear') {
        return invalid('attachment_not_cleared', 'Attachments must pass the safety scan first.');
      }
      if (upload.contentType.startsWith('image/') && upload.altText === null) {
        return invalid('attachment_alt_required', 'Images require alt text.');
      }
    }
  }

  // Belt-and-suspenders body cap (the schema already enforces it).
  if (request.body.length > CONTRIBUTION_BODY_LIMITS[request.type]) {
    return invalid(
      'body_too_long',
      `Maximum length is ${CONTRIBUTION_BODY_LIMITS[request.type]} characters.`,
    );
  }

  // 5. Safety pre-checks (WS-J.2.6 seam): flagged → under_review + queue.
  const verdict = await forum.safety.classify(request);
  const moderationState = verdict.flagged ? 'under_review' : 'published';

  // 6. Transactional insert (with the evidence card for evidence types).
  const contributionId = randomUUID();
  let evidenceCard: ForumEvidenceCardInput | undefined;
  if (request.type === 'evidence') {
    const claim = await ingestion.claims.getById(request.target_claim_id);
    const firstCitation: Citation | undefined = request.citations[0];
    if (firstCitation === undefined) {
      // Unreachable through the schema (citations.min(1)); typed guard for
      // direct service callers.
      return invalid('citations_required', 'Evidence contributions require at least one citation.');
    }
    evidenceCard = {
      evidenceId: randomUUID(),
      claimId: request.target_claim_id,
      sourceId: null,
      submittedBy: userId,
      evidenceType: request.evidence_type ?? 'report',
      // Neutral relationship by default (asserting `supports` would
      // fabricate a stance — the WS-F.2.5a reasoning); the standalone
      // POST /v1/evidence carries an explicit relationship_type.
      relationshipType: 'contextualizes',
      citationUrlOrRef: firstCitation.url,
      relevanceNote: request.body,
      independenceGroupId: claim?.independenceGroupId ?? null,
      storyId: null,
      contributionId,
    };
  }

  const citations: Citation[] =
    'citations' in request && request.citations ? request.citations : [];
  const metadata = metadataFromRequest(request, evidenceCard?.evidenceId ?? null);
  const inserted = await forum.contributions.insert(
    {
      contributionId,
      threadId: request.thread_id,
      userId,
      type: request.type,
      body: request.body,
      citations,
      metadata,
      targetClaimId:
        'target_claim_id' in request && request.target_claim_id !== undefined
          ? request.target_claim_id
          : null,
      parentContributionId: request.parent_contribution_id ?? null,
      clientDraftId: request.client_draft_id,
      path: parentPath,
      moderationState,
    },
    evidenceCard,
  );
  if (!inserted.ok) {
    return invalid('storage_conflict', 'The contribution could not be stored. Retry.');
  }
  if (inserted.duplicate) {
    forum.metrics.increment('contributions.deduplicated');
    return {
      ok: true,
      contribution: inserted.contribution,
      evidenceCardId:
        typeof inserted.contribution.metadata.evidence_id === 'string'
          ? inserted.contribution.metadata.evidence_id
          : null,
      deduplicated: true,
    };
  }
  const contribution = inserted.contribution;

  // Review-queue intake: safety holds AND user-filed moderation concerns
  // (§18.4 report mechanism; urgent flags carry their urgency in context).
  if (verdict.flagged) {
    forum.metrics.increment('contributions.safety_flagged');
    await ingestion.reviewQueue.insert({
      kind: 'contribution_safety_hold',
      storyId: thread.storyId,
      context: {
        contribution_id: contribution.contributionId,
        thread_id: contribution.threadId,
        reasons: verdict.reasons,
      },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      notBefore: null,
    });
  }
  if (request.type === 'moderation_concern') {
    forum.metrics.increment('contributions.moderation_concern');
    await ingestion.reviewQueue.insert({
      kind: 'moderation_concern',
      storyId: thread.storyId,
      context: {
        contribution_id: contribution.contributionId,
        thread_id: contribution.threadId,
        target_contribution_id: request.target_contribution_id,
        reason_code: request.reason_code,
        urgency: request.urgency ?? 'normal',
      },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      notBefore: null,
    });
  }

  // 7. Durable events (ids/types/flags only — never body text).  A
  // safety-HELD contribution emits NOTHING (fail toward caution): scoring,
  // lifecycle activity, and freshness must not count content readers
  // cannot see — a malware-held "evidence" post would otherwise still earn
  // participation weight while hidden.  Emission on release is the WS-J
  // approval flow's job (the review-queue seam owns the state change).
  if (moderationState === 'under_review') {
    // No room-activity bump either: the public recency timestamp must not
    // reflect content readers cannot see.
    forum.metrics.increment('contributions.held_emission_deferred');
    forum.metrics.increment(`contributions.created.${request.type}`);
    forum.log('forum.contribution_created', {
      contribution_id: contribution.contributionId,
      thread_id: contribution.threadId,
      type: request.type,
      moderation_state: moderationState,
      has_citation: citations.length > 0,
    });
    return {
      ok: true,
      contribution,
      evidenceCardId: evidenceCard?.evidenceId ?? null,
      deduplicated: false,
    };
  }
  const hasCitation = citations.length > 0;
  const baseType = FORUM_TO_EVENT_TYPE[request.type];
  const eventType: EventContributionType =
    (request.type === 'answer' || request.type === 'explanation') &&
    classifyLowInfoReplyV0(request.body, hasCitation)
      ? 'low_info_reply'
      : baseType;
  const created = contributionCreatedEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'contribution.created',
    timestamp: contribution.createdAt,
    schema_version: '1',
    contribution_id: contribution.contributionId,
    thread_id: contribution.threadId,
    user_id: userId,
    contribution_type: eventType,
    target_claim_id: contribution.targetClaimId,
    parent_contribution_id: contribution.parentContributionId,
    has_citation: hasCitation,
    accusation_flag: classifyAccusationV0(request.body),
    privacy_classification: 'public',
    retention_tier: 'public_contribution',
  });
  const createdEntry = TOPIC_REGISTRY['contribution.created'];
  const eventRows: NewStoredEvent[] = [
    {
      eventId: created.event_id,
      eventType: created.event_type,
      topic: created.event_type,
      timestamp: created.timestamp,
      privacyClassification: createdEntry.privacy_classification,
      retentionTier: createdEntry.retention_tier,
      payload: created as unknown as Record<string, unknown>,
      ownerUserId: userId,
      purgeAfter: null,
    },
  ];
  let evidenceAdded: ReturnType<typeof evidenceAddedEventSchema.parse> | null = null;
  if (evidenceCard) {
    evidenceAdded = evidenceAddedEventSchema.parse({
      event_id: randomUUID(),
      event_type: 'evidence.added',
      timestamp: contribution.createdAt,
      schema_version: '1',
      evidence_id: evidenceCard.evidenceId,
      claim_id: evidenceCard.claimId,
      thread_id: contribution.threadId,
      user_id: userId,
      evidence_type: mapCardTypeToEventType(evidenceCard.evidenceType),
      source_id: null,
      contribution_id: contribution.contributionId,
      privacy_classification: 'public',
      retention_tier: 'public_contribution',
    });
    const addedEntry = TOPIC_REGISTRY['evidence.added'];
    eventRows.push({
      eventId: evidenceAdded.event_id,
      eventType: evidenceAdded.event_type,
      topic: evidenceAdded.event_type,
      timestamp: evidenceAdded.timestamp,
      privacyClassification: addedEntry.privacy_classification,
      retentionTier: addedEntry.retention_tier,
      payload: evidenceAdded as unknown as Record<string, unknown>,
      ownerUserId: userId,
      purgeAfter: null,
    });
  }
  await events.eventStore.insertMany(eventRows);
  forum.trackBackground(events.router.publish(created));
  if (evidenceAdded) forum.trackBackground(events.router.publish(evidenceAdded));

  // Room activity recency (a timestamp, never a popularity count).
  if (thread.roomId !== null) {
    await forum.rooms.touchActivity(thread.roomId, contribution.createdAt);
  }

  // Organic deepening evaluation (WS-G.1.1 system trigger) — detached: the
  // response never waits on it, and a failure only logs.
  forum.trackBackground(
    maybeDeepenConversation(
      {
        stories: ingestion.stories,
        events,
        audit: getIdentityServices().audit,
        trackBackground: forum.trackBackground,
        now: forum.now,
      },
      (tid, states) => forum.contributions.countByType(tid, states),
      config,
      contribution.threadId,
      contribution.path.length,
    ),
  );

  forum.metrics.increment(`contributions.created.${request.type}`);
  forum.log('forum.contribution_created', {
    contribution_id: contribution.contributionId,
    thread_id: contribution.threadId,
    type: request.type,
    moderation_state: moderationState,
    has_citation: hasCitation,
  });

  return {
    ok: true,
    contribution,
    evidenceCardId: evidenceCard?.evidenceId ?? null,
    deduplicated: false,
  };
}

/** WS-G.1.3 material types → the WS-E `evidence.added` wire taxonomy.  The
 *  event enum predates WS-G and lacks `expert_reference`/`fact_check`:
 *  expert references map to `other`, fact-checks to `article` (a published
 *  fact-check is an article).  Pinned by unit test. */
export function mapCardTypeToEventType(
  cardType: NonNullable<ForumEvidenceCardInput['evidenceType']>,
): 'primary_source' | 'dataset' | 'transcript' | 'legal_text' | 'report' | 'article' | 'other' {
  switch (cardType) {
    case 'primary_source':
    case 'dataset':
    case 'transcript':
    case 'legal_text':
    case 'report':
      return cardType;
    case 'expert_reference':
      return 'other';
    case 'fact_check':
      return 'article';
  }
}

export type ContributionEditOutcome =
  | { ok: true; contribution: ContributionRecord }
  | { ok: false; rejection: ContributionRejection };

/**
 * Author-only edit (§15.5 "edit history for material changes"): body/
 * citations/metadata only — `type` is structurally absent from the contract.
 * The previous values are snapshotted into the append-only edit history.
 */
export async function editContribution(
  bundle: ServiceBundle,
  userId: string,
  contributionId: string,
  update: ContributionUpdate,
): Promise<ContributionEditOutcome> {
  const { forum } = bundle;
  const existing = await forum.contributions.getById(contributionId);
  if (!existing || existing.userId !== userId) {
    // 404-over-403: never confirm another user's contribution ids.
    return {
      ok: false,
      rejection: { status: 404, code: 'not_found', message: 'Contribution not found' },
    };
  }
  if (existing.moderationState === 'removed' || existing.moderationState === 'hidden') {
    return {
      ok: false,
      rejection: {
        status: 409,
        code: 'thread_archived',
        message: 'This contribution can no longer be edited',
      },
    };
  }
  if (update.body !== undefined && update.body.length > CONTRIBUTION_BODY_LIMITS[existing.type]) {
    return {
      ok: false,
      rejection: {
        status: 422,
        code: 'body_too_long',
        message: `Maximum length is ${CONTRIBUTION_BODY_LIMITS[existing.type]} characters.`,
      },
    };
  }
  // Citation-floor invariants survive edits (WS-G.1.2b): evidence keeps ≥ 1
  // citation, corrections keep 1..5.
  if (update.citations !== undefined) {
    if (existing.type === 'evidence' && update.citations.length < 1) {
      return {
        ok: false,
        rejection: {
          status: 422,
          code: 'citations_required',
          message: 'Evidence contributions require at least one citation.',
        },
      };
    }
    if (
      existing.type === 'correction' &&
      (update.citations.length < 1 || update.citations.length > 5)
    ) {
      return {
        ok: false,
        rejection: {
          status: 422,
          code: 'citations_required',
          message: 'Corrections require one to five supporting citations.',
        },
      };
    }
  }
  const patch: { body?: string; citations?: Citation[] } = {};
  if (update.body !== undefined) patch.body = update.body;
  if (update.citations !== undefined) patch.citations = update.citations;
  // Metadata edits are deliberately NOT accepted in v0 (the structured fields
  // define the contribution's meaning; changing them is a new contribution).

  // Safety re-screen (WS-G.3.1 parity): an edit can introduce exactly the
  // content the create-time classifier would have held — a denylisted URL
  // in the body or citations.  Classify the contribution AS IT WILL READ
  // after the patch; a flag holds it for review (fail toward caution, same
  // queue as create-time holds).
  const editedShape = {
    type: existing.type,
    thread_id: existing.threadId,
    client_draft_id: existing.clientDraftId,
    body: patch.body ?? existing.body,
    citations: patch.citations ?? existing.citations,
    ...(typeof existing.metadata['source_url'] === 'string'
      ? { source_url: existing.metadata['source_url'] }
      : {}),
  } as unknown as ContributionCreate;
  const verdict = await forum.safety.classify(editedShape);

  const edited = await forum.contributions.applyEdit(contributionId, patch, userId, randomUUID());
  if (!edited) {
    return {
      ok: false,
      rejection: { status: 404, code: 'not_found', message: 'Contribution not found' },
    };
  }
  if (verdict.flagged && edited.moderationState === 'published') {
    forum.metrics.increment('contributions.edit_safety_flagged');
    const held = await forum.contributions.setModerationState(contributionId, 'under_review');
    const storyId = await bundle.ingestion.stories.getStoryIdByThreadId(existing.threadId);
    await bundle.ingestion.reviewQueue.insert({
      kind: 'contribution_safety_hold',
      storyId,
      context: {
        contribution_id: contributionId,
        thread_id: existing.threadId,
        reasons: verdict.reasons,
        trigger: 'edit',
      },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      notBefore: null,
    });
    forum.metrics.increment('contributions.edited');
    return { ok: true, contribution: held ?? edited };
  }
  forum.metrics.increment('contributions.edited');
  return { ok: true, contribution: edited };
}

/**
 * Author-only removal with a TOMBSTONE (§15.5: deletion preserves thread
 * integrity — the row stays, the body is no longer served).
 */
export async function removeContribution(
  bundle: ServiceBundle,
  userId: string,
  contributionId: string,
): Promise<ContributionEditOutcome> {
  const { forum } = bundle;
  const existing = await forum.contributions.getById(contributionId);
  if (!existing || existing.userId !== userId) {
    return {
      ok: false,
      rejection: { status: 404, code: 'not_found', message: 'Contribution not found' },
    };
  }
  if (existing.moderationState === 'removed') {
    return { ok: true, contribution: existing }; // idempotent
  }
  const removed = await forum.contributions.setModerationState(contributionId, 'removed');
  if (!removed) {
    return {
      ok: false,
      rejection: { status: 404, code: 'not_found', message: 'Contribution not found' },
    };
  }
  forum.metrics.increment('contributions.removed');
  return { ok: true, contribution: removed };
}
