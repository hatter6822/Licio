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
  contentEventClassification,
  contentSubmittedEventSchema,
  DEFAULT_TRACKER_DENYLIST,
  deriveStoryVisibility,
  evidenceAddedEventSchema,
  normalizeUrl,
  type StoryCreateRequest,
  TOPIC_REGISTRY,
  type TrackerDenylist,
  UNCLASSIFIED_TOPIC_ID,
} from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import { joinRoom, roomContentVisibleToUser, userMayPostTopLevel } from '../forum/rooms.js';
import type { ForumServices } from '../forum/services.js';
import { accountRef } from '../identity/crypto.js';
import type { IdentityServices } from '../identity/services.js';
import { loadContentFlags } from './content-flags.js';
import { findNearDuplicates, signatureStory } from './dedup.js';
import { submissionText } from './pipeline.js';
import { evaluatePrechecks, titleHash } from './prechecks.js';
import type { IngestionServices } from './services.js';
import type { StoryDedupTier, StoryRecord } from './stores.js';

export type SubmissionRejection =
  | { status: 429; code: 'rate_limited'; message: string; retryAfterSec: number }
  | { status: 404; code: string; message: string }
  | { status: 403; code: string; message: string }
  | { status: 400; code: string; message: string }
  | { status: 409; code: 'p2p_room_requires_client_sync'; message: string }
  | { status: 409; code: 'room_frozen'; message: string }
  | { status: 409; code: 'duplicate_story'; message: string; existingStoryId: string };

/** WS-Q.2.1a — an unknown room OR a private-room outsider/pending applicant get
 *  the SAME 404 (tier one is universal; tier two never confirms membership —
 *  the WS-D.1.6a 404-over-403 house rule, no content/membership oracle). */
function roomNotFoundRejection(): SubmissionRejection {
  return { status: 404, code: 'not_found', message: 'Resource not found' };
}

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
    case 'image_post':
      return {
        submission_type: 'image_post',
        upload_id: request.upload_id,
        alt_text: request.alt_text,
      };
    case 'video_post':
      return {
        submission_type: 'video_post',
        upload_id: request.upload_id,
        ...(request.captions_text !== undefined ? { captions_text: request.captions_text } : {}),
        ...(request.captions_upload_id !== undefined
          ? { captions_upload_id: request.captions_upload_id }
          : {}),
        ...(request.poster_upload_id !== undefined
          ? { poster_upload_id: request.poster_upload_id }
          : {}),
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
  forum: ForumServices,
  userId: string,
  request: StoryCreateRequest,
): Promise<SubmissionOutcome> {
  const config = ingestion.config();
  const nowMs = ingestion.now();
  const nowIso = new Date(nowMs).toISOString();

  // 0. Submitter (roles for the posting-policy gate; account age for the WS-F
  //    pre-checks below).
  const user = await identity.store.getUser(userId);
  if (!user) {
    return {
      ok: false,
      rejection: { status: 403, code: 'forbidden', message: 'Account unavailable' },
    };
  }

  // --- WS-Q room guards (before the WS-F pre-checks; §14.1/§14.5/§16.1) ------
  // 1. Destination room exists (404 on unknown — never confirm beyond tier one).
  const room = await forum.rooms.getById(request.room_id);
  if (room === null) return { ok: false, rejection: roomNotFoundRejection() };
  // 1a. WS-S.1.3 — a Private P2P room is created and synced ENTIRELY on member
  //     devices (the §8 server non-storage contract): the server MUST NOT create
  //     a story/thread shell for it.  Reject BEFORE any side effect (auto-join,
  //     visibility derivation, rate-limit decrement, dedup, create).  In
  //     practice a p2p room id should never reach this path, so this is the
  //     defensive keystone that makes server content for a p2p room impossible.
  if (room.storageMode === 'p2p') {
    ingestion.metrics.increment('submission.p2p_room_rejected');
    return {
      ok: false,
      rejection: {
        status: 409,
        code: 'p2p_room_requires_client_sync',
        message: 'Private P2P rooms are created and synced locally.',
      },
    };
  }
  // 1b. WS-S.9 (PRIVATE_SPEC §24, phase 5) — a FROZEN (migrated) room is
  //     READ-ONLY: reject every new submission BEFORE any side effect
  //     (auto-join, rate-limit decrement, create). Fail-closed: a steward froze
  //     the room because it migrated to a Private P2P replacement, so new
  //     content belongs in the P2P room, never the read-only server shell.
  if (room.frozen) {
    ingestion.metrics.increment('submission.room_frozen_rejected');
    return {
      ok: false,
      rejection: {
        status: 409,
        code: 'room_frozen',
        message: 'This room is read-only — it has migrated to a Private P2P room.',
      },
    };
  }
  // 2. Read bar + ACTIVE membership. A public room is open-join: posting to it
  //    (the composer's required room pick is the consent) auto-joins the author.
  //    A private-room outsider/pending applicant gets 404 (no membership oracle).
  if (room.visibility === 'public') {
    const subscription = await forum.rooms.getSubscription(room.roomId, userId);
    if (subscription === null || subscription.status !== 'active') {
      await joinRoom(forum, room, userId, nowIso);
      ingestion.metrics.increment('submission.room_autojoined');
    }
  } else if (!(await roomContentVisibleToUser(forum, room, userId))) {
    return { ok: false, rejection: roomNotFoundRejection() };
  }
  // 3. Posting policy (WS-Q.2.1b): `experts_and_stewards` rooms admit only
  //    stewards/experts; a read-capable member who cannot post gets a DISTINCT
  //    in-room error (403, never 404 — they can see the room).
  if (!(await userMayPostTopLevel(forum, room, userId, user.roles))) {
    ingestion.metrics.increment('submission.posting_restricted');
    return {
      ok: false,
      rejection: {
        status: 403,
        code: 'posting_restricted',
        message: "Posting here is limited to this room's stewards and experts",
      },
    };
  }
  // 3b. WS-Q.6.2 rollout flags (fail-closed). Media posts gate the new types;
  //     the in-room-visibility flag gates the PUBLIC-room author choice only.
  const contentFlags = await loadContentFlags(events.configStore, (name, problem) =>
    ingestion.log('content.flag.invalid', { name, problem }),
  );
  if (
    (request.submission_type === 'image_post' || request.submission_type === 'video_post') &&
    !contentFlags.mediaPostsEnabled
  ) {
    ingestion.metrics.increment('submission.media_posts_disabled');
    return {
      ok: false,
      rejection: {
        status: 403,
        code: 'media_posts_disabled',
        message: 'Image and video posts are not currently enabled',
      },
    };
  }
  // 4. Visibility derivation (WS-Q.2.1c): a private room FORCES room_only
  //    (containment — independent of any flag). When the in-room-visibility
  //    flag is OFF, a PUBLIC room ignores the author's room_only request and
  //    behaves pre-WS-Q (public); the request is treated as `public`.
  const requestedVisibility = contentFlags.inRoomVisibilityEnabled ? request.visibility : 'public';
  const visibility = deriveStoryVisibility(room.visibility, requestedVisibility);
  if (request.visibility === 'public' && visibility === 'room_only') {
    ingestion.metrics.increment('submission.visibility_forced');
  }

  // 5. Rate limit (per-account sliding windows; non-reversible key, §19.1).
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

  // 6. Pre-checks (WS-F.1.4c): account age, spam title pattern, URL safety.
  const hash = titleHash(request.title);
  const windowStart = new Date(nowMs - config.duplicateTitleWindowMinutes * 60_000).toISOString();
  const rejection = evaluatePrechecks({
    accountCreatedAtIso: user.createdAt,
    nowMs,
    minAccountAgeMinutes: config.minAccountAgeMinutes,
    // DEV/TEST: drop the account-age gate so a fresh local account can post
    // (parallels the /v1/auth/dev/verify shortcut). Always false in production.
    skipAccountAgeGate: ingestion.skipAccountAgeGate,
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

  // 7. Media intake (WS-Q.2.3a/e): image/video posts anchor a previously
  //    uploaded, scan-gated, metadata-stripped object. Verify it exists, is
  //    OWNED by the submitter, is the right media type, and is not already
  //    claimed; `flagged` ⇒ rejected; `pending` ⇒ the story is held for review
  //    (fail-toward-caution), never published-then-hidden.
  let mediaUploadRef: string | null = null;
  let mediaType: StoryRecord['mediaType'] = null;
  let extractionState: StoryRecord['extractionState'] = 'pending';
  let heldForScan = false;
  if (request.submission_type === 'image_post' || request.submission_type === 'video_post') {
    const wantImage = request.submission_type === 'image_post';
    const upload = await forum.uploads.getRecord(request.upload_id);
    if (upload === null || upload.ownerUserId !== userId) {
      return {
        ok: false,
        rejection: {
          status: 400,
          code: 'unknown_upload',
          message: 'The referenced upload does not exist or is not owned by you',
        },
      };
    }
    const isImage = upload.contentType.startsWith('image/');
    const isVideo = upload.contentType.startsWith('video/');
    if ((wantImage && !isImage) || (!wantImage && !isVideo)) {
      return {
        ok: false,
        rejection: {
          status: 400,
          code: 'upload_type_mismatch',
          message: 'The upload type does not match the post type',
        },
      };
    }
    if ((await ingestion.stories.getByMediaUploadRef(upload.uploadId)) !== null) {
      return {
        ok: false,
        rejection: {
          status: 400,
          code: 'upload_already_used',
          message: 'This upload is already attached to another post',
        },
      };
    }
    if (upload.scanState === 'flagged') {
      ingestion.metrics.increment('submission.media_flagged');
      return {
        ok: false,
        rejection: {
          status: 403,
          code: 'held_for_review',
          message: 'This upload did not pass a safety check',
        },
      };
    }
    mediaUploadRef = upload.uploadId;
    mediaType = wantImage ? 'image' : 'video';
    // Media is never URL-normalized or crawled — but it STILL runs the §14.2
    // pipeline's non-link path (which classifies the local text: title + alt
    // text / captions), so its topics get validated and `content.normalized` is
    // emitted. Left at `pending` for that pass; the non-link path sets the final
    // `not_applicable` state. (Skipping the pipeline left media permanently
    // UNCLASSIFIED — excluded from topic feeds and PHI/topic matching.)
    extractionState = 'pending';
    heldForScan = upload.scanState === 'pending';
  }

  // 7b. Optional video sub-uploads (WS-Q.5.2c): a WebVTT caption track and/or a
  //     poster image must each be OWNED, the right type, and scan-cleared (a
  //     pending scan holds the story; a flagged one rejects it).
  if (request.submission_type === 'video_post') {
    const subUploads: Array<[string | undefined, string]> = [
      [request.captions_upload_id, 'text/vtt'],
      [request.poster_upload_id, 'image/'],
    ];
    for (const [id, typePrefix] of subUploads) {
      if (id === undefined) continue;
      const sub = await forum.uploads.getRecord(id);
      if (sub === null || sub.ownerUserId !== userId || !sub.contentType.startsWith(typePrefix)) {
        return {
          ok: false,
          rejection: {
            status: 400,
            code: 'unknown_upload',
            message: 'A referenced caption or poster upload is invalid',
          },
        };
      }
      if (sub.scanState === 'flagged') {
        ingestion.metrics.increment('submission.media_flagged');
        return {
          ok: false,
          rejection: {
            status: 403,
            code: 'held_for_review',
            message: 'A referenced upload did not pass a safety check',
          },
        };
      }
      if (sub.scanState === 'pending') heldForScan = true;
    }
  }

  // 8. Tier-scoped exact-URL duplicate (WS-Q.2.2a, §14.5.6) + the takedown
  //    denylist (WS-Q.2.6, the companion the `hidden_state IS NULL` partial
  //    unique index requires). The create path's tier-scoped unique index
  //    closes the concurrent race.
  const dedupTier: StoryDedupTier =
    visibility === 'public'
      ? { visibility: 'public' }
      : { visibility: 'room_only', roomId: room.roomId };
  let canonicalPublicStoryId: string | null = null;
  if (canonicalUrl !== null) {
    // (a) A hidden (taken-down/safety) story for this URL — in ANY tier — blocks
    //     re-submission and is reported with a generic, non-identifying
    //     rejection (no hidden-discussion oracle; no takedown bypass).
    if (await ingestion.stories.hasHiddenForUrl(canonicalUrl)) {
      ingestion.metrics.increment('dedup.exact_url_hidden');
      return { ok: false, rejection: hiddenDuplicateRejection() };
    }
    // (b) A live duplicate in the SAME tier ⇒ 409 + the existing story id.
    const existing = await ingestion.stories.getByCanonicalUrl(canonicalUrl, dedupTier);
    if (existing !== null) {
      ingestion.metrics.increment('dedup.exact_url_409');
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
    // (c) Cross-tier link (WS-Q.2.2b): a room_only submission whose URL matches
    //     an existing public story records the canonical-public pointer.
    if (visibility === 'room_only') {
      const canonicalPublic = await ingestion.stories.getByCanonicalUrl(canonicalUrl, {
        visibility: 'public',
      });
      if (canonicalPublic !== null) canonicalPublicStoryId = canonicalPublic.storyId;
    }
  }

  // 9. Transactional create (story + thread shell, WS-F.1.4d): both rows are
  //    stamped with the home room and the derived visibility (WS-Q.2.1c).
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
      roomId: room.roomId,
      visibility,
      mediaUploadRef,
      canonicalPublicStoryId,
      language: request.language !== undefined ? canonicalizeBcp47(request.language) : null,
      // WS-K §24.1 — author picks are UNTRUSTED proposals. The trusted topic
      // set starts as the UNCLASSIFIED sentinel; the validator promotes the
      // content-supported proposals (+ any it detects) on content.normalized.
      proposedTopicIds: [...request.topic_ids],
      topicIds: [UNCLASSIFIED_TOPIC_ID],
      locationScope: request.location_scope ?? null,
      sensitivityLabels: [...(request.sensitivity_labels ?? ['none'])],
      lifecycleState: 'submitted',
      submissionType: request.submission_type,
      submissionMetadata: metadataOf(request),
      excerpt: null,
      publisher: null,
      author: null,
      publishedAt: null,
      mediaType,
      extractionState,
      // A pending-scan media post is HELD (fail-toward-caution) until the scan
      // clears — never published-then-hidden (the serving path also gates bytes).
      hiddenState: heldForScan ? 'safety' : null,
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

  // 9a2. WS-Q.5.2c — back-link the story's media uploads (main media, caption
  //      track, poster) so the gated serving path can re-derive each upload's
  //      visibility (room_only ⇒ signed URL required) and re-check takedown at
  //      fetch time. Contribution attachments keep a null owner and serve bare.
  if (mediaUploadRef !== null) {
    const mediaUploadIds = [mediaUploadRef];
    if (request.submission_type === 'video_post') {
      if (request.captions_upload_id !== undefined) {
        mediaUploadIds.push(request.captions_upload_id);
      }
      if (request.poster_upload_id !== undefined) mediaUploadIds.push(request.poster_upload_id);
    }
    for (const id of mediaUploadIds) {
      await forum.uploads.setOwnerStory(id, created.story.storyId);
    }
  }

  // 9b. WS-Q.2.2b cross-tier back-link: a NEW public story for a URL that
  //     already has room_only twins becomes their canonical public story
  //     (opportunistic; not transaction-coupled).
  if (visibility === 'public' && canonicalUrl !== null) {
    const roomOnlyTwins = await ingestion.stories.listRoomOnlyByCanonicalUrl(canonicalUrl);
    for (const twin of roomOnlyTwins) {
      if (twin.canonicalPublicStoryId === null) {
        await ingestion.stories.update(twin.storyId, {
          canonicalPublicStoryId: created.story.storyId,
        });
      }
    }
  }

  // 9c. WS-Q.2.3a media hold: a pending-scan media post is parked in the WS-F
  //     review queue (fail-toward-caution) and its story stays held until a
  //     steward clears it.
  if (heldForScan) {
    await ingestion.reviewQueue.insert({
      kind: 'contribution_safety_hold',
      storyId: created.story.storyId,
      context: { reason: 'media_scan_pending', media_upload_ref: mediaUploadRef },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      notBefore: null,
    });
    ingestion.metrics.increment('submission.media_held_for_scan');
  }

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
      contributionId: null,
      submittedBy: userId,
      // The §14.1 evidence-card submission carries no MATERIAL type and no
      // relationship direction; `report` and `contextualizes` are the
      // neutral defaults (asserting `supports` would fabricate a stance).
      // WS-G's evidence composer attaches both dimensions explicitly.
      evidenceType: 'report',
      relationshipType: 'contextualizes',
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

  // 7. SYNC near-duplicate pass — ONLY for stories whose text is COMPLETE at
  //    submission (WS-F.1.3c). A LINK's submitted text is just its title + a
  //    short reason NOTE, not the article, so signing + near-dup-matching it
  //    here would (a) compare a thin note against other stories' full CONTENT
  //    signatures — MinHash Jaccard across incomparable text bases, which is
  //    meaningless — and (b) be immediately superseded by the post-fetch
  //    `extracted` signature (only ONE signature per story). A link's single,
  //    accurate signature + near-dup pass is written over the FETCHED article by
  //    the extraction pipeline (processLinkStory); defer entirely to it.
  //    Inline-content stories (original_brief/question/local_update/…) are
  //    signed + matched here — their submitted text IS their content — so every
  //    signature the near-dup pass ever compares is over actual story content.
  // WS-Q.2.2c — sign inline-content stories regardless of visibility (so a later
  // widen joins the public cluster without a recompute), but only run the near-
  // dup MATCHING for PUBLIC submissions: a room_only twin is neither flagged nor
  // flags others (room-tier dedup is out of v1 scope).
  const contentCompleteAtSubmission = created.story.submissionType !== 'link';
  const reviewFlags: Array<'near_duplicate' | 'syndicated_copy_candidate'> = [];
  let similar: Awaited<ReturnType<typeof findNearDuplicates>> = [];
  if (contentCompleteAtSubmission) {
    const localText = submissionText(created.story);
    const { signature, bands } = await signatureStory(
      ingestion.signatures,
      created.story.storyId,
      localText,
      'submitted',
    );
    if (created.story.visibility === 'public') {
      similar = await findNearDuplicates(
        ingestion.signatures,
        ingestion.stories,
        created.story.storyId,
        signature,
        bands,
        config.nearDuplicateThreshold,
        5,
      );
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
    }
  }

  // 8. Emit content.submitted: durable insert NOW; publication (which runs
  //    the extraction pipeline in-process) is detached so the 201 returns
  //    within the pre-check latency budget. Crash between insert and publish
  //    is recovered by the durable consumer's checkpoint replay at boot.
  // WS-Q.1.7c — the content event carries the home room + visibility, and the
  // classification TRACKS that visibility (public⟺public, room_only⟺restricted)
  // so an in-room story's URL/topics/submitter never reach a public consumer.
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
    room_id: created.story.roomId,
    visibility: created.story.visibility,
    privacy_classification: contentEventClassification(created.story.visibility),
    retention_tier: 'public_contribution',
  });
  await events.eventStore.insertMany([
    {
      eventId: event.event_id,
      eventType: event.event_type,
      topic: event.event_type,
      timestamp: event.timestamp,
      // Persist the EVENT's actual classification (restricted for room_only),
      // not the topic's public base — so the storage tier matches the content.
      privacyClassification: event.privacy_classification,
      retentionTier: event.retention_tier,
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
