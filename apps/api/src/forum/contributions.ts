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
//   4. cross-record validation (same-thread parent + ≤10 depth, correction
//      target existence/consistency, known claims, lens belongs to the
//      thread's room, attachments owned + scanned),
//   5. safety pre-checks (WS-J.2.6 seam) — flagged content persists as
//      under_review (default-hidden, §18.4) and enters the review queue,
//   6. insert,
//   7. durable event emission: contribution.created, the WS-E scoring
//      mapping below, accusation + low-info classification — events carry
//      ids/types/flags ONLY, never body text.
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
  MAX_CONTRIBUTION_DEPTH,
  TOPIC_REGISTRY,
} from '@licio/shared';
import { type SlidingWindowStore, slidingWindowRetryAfterMs } from '../events/ingest-limiter.js';
import type { EventPipelineServices } from '../events/services.js';
import type { NewStoredEvent } from '../events/stores.js';
import { getIdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import {
  concedeDebate,
  liveArenasForContribution,
  maybeEnterDebate,
  rebroadcastArena,
  snapshotDebateContent,
  withdrawDebate,
} from './debate.js';
import { buildDebateDeps } from './debate-scheduler.js';
import type { DebateArenaRecord } from './debate-store.js';
import type { ForumServices } from './services.js';
import type { ContributionRecord } from './stores.js';
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
 *  A comment scores as `explanation` (its citations carry the sourcing
 *  weight via `has_citation`); the low-info classifier can downgrade it to
 *  `low_info_reply` at emission. */
export const FORUM_TO_EVENT_TYPE: Readonly<Record<ContributionType, EventContributionType>> = {
  comment: 'explanation',
  correction: 'correction',
};

/** Contribution moderation states ordered by restrictiveness (higher wins when
 *  combining the platform floor with the WS-U in-room agent — the agent can only
 *  raise the state, never lower a floor decision). */
type ModState = 'published' | 'under_review' | 'removed';
const MOD_STATE_RANK: Readonly<Record<ModState, number>> = {
  published: 0,
  under_review: 1,
  removed: 2,
};

export type ContributionRejection =
  | { status: 404; code: 'not_found'; message: string }
  | { status: 403; code: 'thread_restricted'; message: string }
  | { status: 403; code: 'interaction_blocked'; message: string }
  | { status: 409; code: 'thread_archived'; message: string }
  | { status: 409; code: 'debate_locked'; message: string }
  | { status: 422; code: string; message: string }
  | { status: 429; code: 'rate_limited'; message: string; retryAfterSec: number };

export type ContributionCreateOutcome =
  | {
      ok: true;
      contribution: ContributionRecord;
      deduplicated: boolean;
    }
  | { ok: false; rejection: ContributionRejection };

interface ServiceBundle {
  forum: ForumServices;
  ingestion: IngestionServices;
  events: EventPipelineServices;
}

/** Assemble the canonical metadata object from a flat create request. */
export function metadataFromRequest(request: ContributionCreate): ContributionMetadata {
  const metadata: ContributionMetadata = {};
  if (request.lens_id !== undefined) metadata.lens_id = request.lens_id;
  if (request.attachment_ids !== undefined && request.attachment_ids.length > 0) {
    metadata.attachment_ids = [...request.attachment_ids];
  }
  if (request.type === 'correction') {
    // WS-T — a correction targets EXACTLY ONE of a comment or the story root
    // (the create guard validates existence/same-thread); the target's author
    // becomes the incumbent when the debate arena opens.
    if (request.target_contribution_id !== undefined) {
      metadata.target_contribution_id = request.target_contribution_id;
    }
    if (request.target_story_id !== undefined) {
      metadata.target_story_id = request.target_story_id;
    }
    if (request.target_text_excerpt !== undefined) {
      metadata.target_text_excerpt = request.target_text_excerpt;
    }
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

/**
 * Read-side visibility for a thread (WS-J #8): room/story visibility (above)
 * AND not moderation-removed.  A WS-J hide/remove on the thread writes the WS-E
 * item-safety row (state='removed'); the thread is then gone from the DIRECT
 * reads — overview, branches, subtree, summaries — exactly as a hidden story
 * is.  This is DISTINCT from the WS-G steward `restricted` posture (a review
 * lock that keeps the thread readable): the two states have separate owners, so
 * a moderation revert never lifts a steward review lock and vice versa.
 */
export async function threadReadableToUser(
  bundle: Pick<ServiceBundle, 'forum' | 'ingestion' | 'events'>,
  thread: { threadId: string; storyId: string; roomId: string | null },
  userId: string | null,
): Promise<boolean> {
  const safety = await bundle.events.safetyStore.get(thread.threadId);
  if (safety?.safetyState === 'removed') return false;
  return threadVisibleToUser(bundle, thread, userId);
}

/**
 * Whether a thread belongs on the GLOBAL conversation directory (the `/threads`
 * tab) — the read-side analogue of the ranking pipeline's two-condition global
 * containment (`filterByVisibility`, SPEC §18.4 / WS-Q): a PUBLIC item from a
 * PUBLIC room, not hidden and not moderation-removed.  Like the front-page feed
 * this is USER-INDEPENDENT: `room_only` items and private-room threads are kept
 * OFF every global surface (they are reached through the room itself), so the
 * directory shows the same public set to everyone and never leaks a room-scoped
 * conversation onto a global tab.  Item visibility never WIDENS the bar — a
 * public item mislabeled into a private room still fails closed because the room
 * is private.
 */
export async function threadOnGlobalDirectory(
  bundle: Pick<ServiceBundle, 'forum' | 'ingestion' | 'events'>,
  thread: { threadId: string; storyId: string; roomId: string | null },
): Promise<boolean> {
  const safety = await bundle.events.safetyStore.get(thread.threadId);
  if (safety?.safetyState === 'removed') return false;
  const story = await bundle.ingestion.stories.getById(thread.storyId);
  if (!story || story.hiddenState !== null) return false;
  // Condition 1: a PUBLIC item (room_only stays off global surfaces, WS-Q).
  if (story.visibility !== 'public') return false;
  // Condition 2: from a confirmed PUBLIC room.  FAIL CLOSED on an unresolved
  // room (a null link or migration-drift orphan) exactly like the feed/search
  // global gate (filterByVisibility) — a global public surface never lists a
  // conversation whose room cannot be confirmed public.  (Every story has a
  // home room, WS-Q.1.5, so this only excludes genuine drift.)
  if (thread.roomId === null) return false;
  const room = await bundle.forum.rooms.getById(thread.roomId);
  return room !== null && room.visibility === 'public';
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
  // 2a. WS-S.1.3 — defense in depth: a Private P2P room's thread/contribution
  //     lives ONLY on member devices (the §8 non-storage contract), so a p2p
  //     thread should never exist server-side.  If one somehow does, refuse the
  //     write with the same non-oracle 404 the reads use (no membership/exists
  //     oracle), and emit a security metric — the guard catches a bug, never a
  //     legitimate write.
  if (thread.roomId !== null) {
    const threadRoom = await forum.rooms.getById(thread.roomId);
    if (threadRoom?.storageMode === 'p2p') {
      forum.metrics.increment('contributions.p2p_room_rejected');
      return reject({ status: 404, code: 'not_found', message: 'Thread not found' });
    }
    // 2b. WS-S.9 (PRIVATE_SPEC §24, phase 5) — a FROZEN (migrated) room is
    //     READ-ONLY: reject every new contribution (fail-closed). New
    //     conversation belongs in the Private P2P replacement, never the
    //     read-only server shell.
    if (threadRoom?.frozen === true) {
      forum.metrics.increment('contributions.room_frozen_rejected');
      return reject({
        status: 409,
        code: 'thread_archived',
        message: 'This room is read-only — it has migrated to a Private P2P room.',
      });
    }
  }
  if (!(await threadVisibleToUser(bundle, thread, userId))) {
    return reject({ status: 404, code: 'not_found', message: 'Thread not found' });
  }
  // A WS-J moderation removal hides the thread from reads AND writes (item-safety
  // 'removed'); a create must 404 like the reads (no existence oracle).  This is
  // separate from the steward `restricted` review lock handled below.
  if ((await events.safetyStore.get(request.thread_id))?.safetyState === 'removed') {
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
    return { ok: true, contribution: existing, deduplicated: true };
  }

  // 4. Per-type cross-record validation (WS-G.1.2b/1.2d-1).
  let parentPath: string[] = [];
  if (request.parent_contribution_id !== undefined) {
    const parent = await forum.contributions.getById(request.parent_contribution_id);
    if (!parent || parent.threadId !== request.thread_id) {
      return invalid('invalid_parent', 'The parent contribution must belong to the same thread.');
    }
    // WS-J.1.2a — a blocked user cannot reply to the blocker (bilateral,
    // server-side authorization; the block relationship is never disclosed).
    if (
      parent.userId !== null &&
      forum.relationshipReader !== null &&
      (await forum.relationshipReader.interactionBlocked(userId, parent.userId))
    ) {
      return reject({
        status: 403,
        code: 'interaction_blocked',
        message: 'You cannot reply to this contribution.',
      });
    }
    if (parent.path.length + 1 > MAX_CONTRIBUTION_DEPTH) {
      return invalid('max_depth_exceeded', 'Maximum thread depth exceeded.');
    }
    parentPath = [...parent.path, parent.contributionId];
  } else {
    // WS-J.1.2a — a TOP-LEVEL contribution interacts with the thread's story
    // owner; a blocked user cannot post into the blocker's thread (bilateral,
    // server-side authorization — the block is not just a viewing filter).  The
    // reply path above checks the parent author; this is the main-entry analogue.
    if (forum.relationshipReader !== null) {
      const story = await ingestion.stories.getById(thread.storyId);
      if (
        story?.submittedBy != null &&
        (await forum.relationshipReader.interactionBlocked(userId, story.submittedBy))
      ) {
        return reject({
          status: 403,
          code: 'interaction_blocked',
          message: 'You cannot post in this thread.',
        });
      }
    }
  }

  if ('target_claim_id' in request && request.target_claim_id !== undefined) {
    const claim = await ingestion.claims.getById(request.target_claim_id);
    if (!claim) return invalid('unknown_claim', 'The referenced claim does not exist.');
  }

  // WS-T — a correction targets EXACTLY ONE of a comment (same thread) or the
  // story root (the thread's story).  The schema's superRefine guarantees the
  // exactly-one shape; here we validate existence/consistency.  A correction may
  // not target its own author's tombstone or a removed row.
  if (request.type === 'correction') {
    if (request.target_contribution_id !== undefined) {
      const target = await forum.contributions.getById(request.target_contribution_id);
      if (!target || target.threadId !== request.thread_id) {
        return invalid('invalid_target', 'A correction must target a comment in the same thread.');
      }
      if (target.moderationState === 'removed' || target.moderationState === 'hidden') {
        return invalid('invalid_target', 'The targeted comment is no longer available.');
      }
      // WS-T — refuse a challenge against a comment already under debate or already
      // adjudicated `incorrect` (the UI disables this, but a direct API caller must
      // not open a second arena / re-litigate a settled outcome).
      if (target.disputeStatus === 'under_debate') {
        return invalid('target_under_debate', 'This comment is already under debate.');
      }
      if (target.disputeStatus === 'incorrect') {
        return invalid('target_already_incorrect', 'This comment was already found incorrect.');
      }
    } else if (request.target_story_id !== undefined) {
      if (request.target_story_id !== thread.storyId) {
        return invalid('invalid_target', "A story correction must target the thread's story.");
      }
      const targetStory = await ingestion.stories.getById(request.target_story_id);
      if (!targetStory) {
        return invalid('invalid_target', 'The targeted story no longer exists.');
      }
      const storyDispute = targetStory.disputeStatus ?? 'none';
      if (storyDispute === 'under_debate') {
        return invalid('target_under_debate', 'This story is already under debate.');
      }
      if (storyDispute === 'incorrect') {
        return invalid('target_already_incorrect', 'This story was already found incorrect.');
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
      if (request.type === 'comment' && !upload.contentType.startsWith('image/')) {
        return invalid('invalid_comment_media', 'Comment attachments must be images or GIFs.');
      }
    }
  }
  if (
    request.type === 'comment' &&
    request.body.trim().length === 0 &&
    (request.attachment_ids?.length ?? 0) === 0
  ) {
    return invalid('comment_body_or_media_required', 'Comment text or media is required.');
  }

  // Belt-and-suspenders body cap (the schema already enforces it).
  if (request.body.length > CONTRIBUTION_BODY_LIMITS[request.type]) {
    return invalid(
      'body_too_long',
      `Maximum length is ${CONTRIBUTION_BODY_LIMITS[request.type]} characters.`,
    );
  }

  // The contribution id is minted here (before the safety/agent passes) so the
  // WS-U agent action log can reference it as the moderated subject.
  const contributionId = randomUUID();

  // 5. Safety pre-checks (WS-J.2.6 floor seam): flag → under_review + queue;
  //    block → removed (high-confidence spam/malware auto-block, appealable).
  //    The duplicate-flood detector counts distinct ROOMS, so pass the thread's
  //    real home room (NOT the thread id — same-room reposts are one room).
  const verdict = await forum.safety.classify(request, { userId, roomId: thread.roomId });
  const floorState: ModState =
    verdict.disposition === 'block'
      ? 'removed'
      : verdict.disposition === 'flag'
        ? 'under_review'
        : 'published';

  // 5b. WS-U bounded in-room agent (SPEC §24.6): when the room has an active
  //     community-approved binding, the agent may add caution within its
  //     community-granted capabilities. Combined FLOOR-DOMINANTLY (max
  //     restriction) — the agent can never reduce a floor decision or reinstate a
  //     floor removal (it holds no floor-reserved capability). The agent action
  //     (with its provenance triple) is logged inside the GovernanceService.
  let moderationState: ModState = floorState;
  let agentEscalated = false;
  let agentReason: string | null = null;
  if (thread.roomId !== null && forum.agentModerator !== null) {
    const agent = await forum.agentModerator.moderateContribution({
      roomId: thread.roomId,
      contributionId,
      authorUserId: userId,
      type: request.type,
      body: request.body,
      citationCount: 'citations' in request && request.citations ? request.citations.length : 0,
      attachmentCount: request.attachment_ids?.length ?? 0,
    });
    if (agent !== null && MOD_STATE_RANK[agent.state] > MOD_STATE_RANK[moderationState]) {
      moderationState = agent.state;
      agentEscalated = true;
      agentReason = agent.reason ?? null;
      forum.metrics.increment('contributions.agent_moderated');
    }
  }

  // 6. Insert.
  const citations: Citation[] =
    'citations' in request && request.citations ? request.citations : [];
  const metadata = metadataFromRequest(request);
  // WS-T — a PUBLISHED sourced correction opens a debate arena.  The id is minted
  // here so `maybeEnterDebate` can open the arena under it; `debate_arena_id` is
  // written onto the RETURNED contribution's metadata ONLY after the arena is
  // confirmed open (below) — never speculatively, so the client is never handed
  // an id that resolves to nothing (SPEC §15.4).
  const debateArenaId =
    request.type === 'correction' && moderationState === 'published' ? randomUUID() : null;
  const inserted = await forum.contributions.insert({
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
  });
  if (!inserted.ok) {
    return invalid('storage_conflict', 'The contribution could not be stored. Retry.');
  }
  if (inserted.duplicate) {
    forum.metrics.increment('contributions.deduplicated');
    return { ok: true, contribution: inserted.contribution, deduplicated: true };
  }
  const contribution = inserted.contribution;

  // WS-Q.5.2c — back-link attachments to the thread's story so the gated
  // serving path restricts them exactly as it restricts story media: an
  // attachment in a room_only story's thread is reachable only through a signed
  // URL, and a taken-down story's attachments stop serving. A thread inherits
  // its story's visibility (§14.5.6), so the owning story is the right governor.
  if (request.attachment_ids !== undefined) {
    for (const uploadId of request.attachment_ids) {
      await forum.uploads.setOwnerStory(uploadId, thread.storyId);
    }
  }

  // Review-queue intake: safety holds AND user-filed moderation concerns
  // (§18.4 report mechanism; urgent flags carry their urgency in context).
  // The intake spans the ingestion review queue + (for an auto-block) the
  // moderation action/audit/notice stores — none sharing a transaction with the
  // contribution insert above.  A partial failure here would leave content
  // hidden (under_review/removed) with NO queue item or appeal notice, and the
  // client's retry (same client_draft_id) would dedup and skip the missing
  // intake — orphaning the suppression.  So on ANY intake failure we COMPENSATE
  // by purging the just-created contribution (fail toward flagging, never toward
  // a silent un-recourse-able removal): the retry then recreates BOTH the row
  // and its intake.
  try {
    if (verdict.disposition !== 'clear') {
      forum.metrics.increment(
        verdict.disposition === 'block'
          ? 'contributions.safety_blocked'
          : 'contributions.safety_flagged',
      );
      await ingestion.reviewQueue.insert({
        kind: 'contribution_safety_hold',
        storyId: thread.storyId,
        context: {
          contribution_id: contribution.contributionId,
          thread_id: contribution.threadId,
          reasons: verdict.reasons,
          disposition: verdict.disposition,
        },
        status: 'pending',
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        notBefore: null,
      });
      // A high-confidence auto-block is an APPEALABLE system action: record the
      // moderation action + audit + a statement-of-reasons notice (WS-J.2.6a/b +
      // the false-positive recourse).  AWAITED, not background: an auto-removal is
      // only legitimate WITH its appealable action/audit/notice, so the
      // accountability write must be durable before the response (never a silent
      // removal if the process exits).
      if (verdict.disposition === 'block' && forum.autoModerationSink !== null) {
        await forum.autoModerationSink.recordContentAutoBlock({
          contributionId: contribution.contributionId,
          authorUserId: userId,
          reasonCode: verdict.reasonCode ?? 'MOD_SPAM_001',
          reasons: verdict.reasons,
        });
      }
    } else if (agentEscalated) {
      // The WS-U in-room agent held/removed content the floor cleared: route it
      // to human review (the appealable-to-floor path). The agent action itself
      // is already in the knomosis agent_action_log with its provenance triple.
      forum.metrics.increment(
        moderationState === 'removed'
          ? 'contributions.agent_blocked'
          : 'contributions.agent_flagged',
      );
      await ingestion.reviewQueue.insert({
        kind: 'contribution_safety_hold',
        storyId: thread.storyId,
        context: {
          contribution_id: contribution.contributionId,
          thread_id: contribution.threadId,
          reasons: ['in_room_agent'],
          disposition: moderationState === 'removed' ? 'block' : 'flag',
          source: 'in_room_agent',
        },
        status: 'pending',
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        notBefore: null,
      });
      // No silent sanction: the author gets the agent's statement of reasons.
      // AWAITED inside the compensating try (a hold is only legitimate WITH its
      // author notice, mirroring the auto-block path).
      if (forum.autoModerationSink !== null) {
        await forum.autoModerationSink.recordAgentHold({
          contributionId: contribution.contributionId,
          authorUserId: userId,
          removed: moderationState === 'removed',
          reason: agentReason,
        });
      }
    }
  } catch (error) {
    forum.metrics.increment('contributions.safety_intake_rollback');
    await forum.contributions.purgeForRollback(contribution.contributionId);
    throw error;
  }

  // 7. Durable events (ids/types/flags only — never body text).  A
  // safety-HELD or AUTO-BLOCKED contribution emits NOTHING (fail toward
  // caution): scoring, lifecycle activity, and freshness must not count content
  // readers cannot see — a malware-held/removed sourced post would otherwise
  // still earn participation weight while hidden.  Emission on release is the
  // WS-J approval flow's job (the review-queue seam owns the state change).
  if (moderationState === 'under_review' || moderationState === 'removed') {
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
    return { ok: true, contribution, deduplicated: false };
  }
  const hasCitation = citations.length > 0;
  const baseType = FORUM_TO_EVENT_TYPE[request.type];
  const eventType: EventContributionType =
    request.type === 'comment' && classifyLowInfoReplyV0(request.body, hasCitation)
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
  await events.eventStore.insertMany(eventRows);
  forum.trackBackground(events.router.publish(created));

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
      {
        countByType: (tid, states) => forum.contributions.countByType(tid, states),
        countSourced: (tid, states) => forum.contributions.countSourced(tid, states),
      },
      config,
      contribution.threadId,
      contribution.path.length,
    ),
  );

  // WS-T — open the debate arena for a published sourced correction.  This is
  // AWAITED (not detached): the arena row must exist before the response returns
  // its id, or the challenger's client would navigate to a 404.  `debate_arena_id`
  // is written onto the returned metadata ONLY when the arena actually opened, so
  // a race that fails to open one (e.g. a concurrent challenge won) never hands
  // the client a dangling id.  A failure here never fails the (already-created)
  // correction — it just means no arena opened.
  if (debateArenaId !== null) {
    try {
      const openedArena = await maybeEnterDebate(
        buildDebateDeps(forum, ingestion),
        {
          contributionId: contribution.contributionId,
          threadId: contribution.threadId,
          storyId: thread.storyId,
          roomId: thread.roomId,
          userId,
          body: contribution.body,
          citations: contribution.citations,
          metadata: contribution.metadata,
        },
        debateArenaId,
      );
      if (openedArena !== null) {
        contribution.metadata.debate_arena_id = openedArena.debateId;
      }
    } catch (err) {
      forum.log('forum.debate_open_failed', {
        contribution_id: contribution.contributionId,
        error: String(err),
      });
    }
  }

  forum.metrics.increment(`contributions.created.${request.type}`);
  forum.log('forum.contribution_created', {
    contribution_id: contribution.contributionId,
    thread_id: contribution.threadId,
    type: request.type,
    moderation_state: moderationState,
    has_citation: hasCitation,
  });

  return { ok: true, contribution, deduplicated: false };
}

export type ContributionEditOutcome =
  | { ok: true; contribution: ContributionRecord }
  | { ok: false; rejection: ContributionRejection };

/**
 * Author-only edit (§15.5 "edit history for material changes"): body/
 * citations/metadata only — `type` is structurally absent from the contract.
 * The previous values are snapshotted into the append-only edit history.
 */
/** True when any of the contribution's live arenas has its material locked in
 *  (post-lock, pre-verdict) — every party-driven change is refused then. */
function anyDebateLockedIn(parties: readonly { arena: DebateArenaRecord }[]): boolean {
  return parties.some(
    ({ arena }) => arena.state === 'locked' || arena.state === 'awaiting_verdict',
  );
}

const DEBATE_LOCKED_REJECTION = {
  status: 409,
  code: 'debate_locked',
  message: 'This content is locked in a live debate awaiting AI resolution.',
} as const;

export async function editContribution(
  bundle: ServiceBundle,
  userId: string,
  contributionId: string,
  update: ContributionUpdate,
): Promise<ContributionEditOutcome> {
  const { forum, ingestion } = bundle;
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
  // WS-T — once a debate's material is locked in (the hour-23 schedule or the
  // both-sides-idle expedite), neither party may change the debated content
  // until the verdict lands (§15.4: "locked in").  While the arenas are `open`
  // the edit proceeds — the arena shows the live content — and counts as the
  // side's activity (below).  A CORRECTION row can be party to TWO arenas at
  // once (challenger of the one it opened, incumbent of one challenging it);
  // a lock on EITHER freezes it.  This early read is the fast reject; the
  // race against a lock landing DURING the safety passes is closed atomically
  // right before the write (below).
  const debateParties = await liveArenasForContribution(forum.debates, contributionId);
  if (anyDebateLockedIn(debateParties)) {
    return { ok: false, rejection: DEBATE_LOCKED_REJECTION };
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
  // Citation-floor invariants survive edits (WS-G.1.2b): corrections keep 1..5.
  if (update.citations !== undefined) {
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
  } as unknown as ContributionCreate;
  // Re-screen against the thread's real home room (WS-Q), so the flood detector
  // counts distinct rooms — not thread ids.  The thread exists (the contribution
  // does); fall back to the thread id only for an unreachable missing-thread case.
  const editThread = await ingestion.stories.getThreadById(existing.threadId);
  const verdict = await forum.safety.classify(editedShape, {
    userId,
    roomId: editThread?.roomId ?? existing.threadId,
  });

  // WS-T — close the lock race ATOMICALLY at the write boundary.  The gate at
  // the top read `open`, but the safety/agent passes above can take real time
  // (an LLM call) and a lifecycle sweep may have locked + snapshotted the
  // arena meanwhile — persisting the edit then would change the live row out
  // from under the snapshot the verdict judges.  `touchActivity` is a
  // store-level `state = 'open'` CAS, so it doubles as the permission check:
  // a loser here is told `debate_locked` BEFORE anything is written (and a
  // winner has its side-activity clock reset atomically with the permission).
  const debateDeps =
    debateParties.length > 0 ? buildDebateDeps(bundle.forum, bundle.ingestion) : null;
  const touchAt = new Date(forum.now()).toISOString();
  for (const { arena, side } of debateParties) {
    if ((await forum.debates.touchActivity(arena.debateId, side, touchAt)) === null) {
      return { ok: false, rejection: DEBATE_LOCKED_REJECTION };
    }
  }

  const edited = await forum.contributions.applyEdit(contributionId, patch, userId, randomUUID());
  if (!edited) {
    return {
      ok: false,
      rejection: { status: 404, code: 'not_found', message: 'Contribution not found' },
    };
  }

  // WS-T — the residual sliver: a lock that lands BETWEEN the touch-CAS and
  // `applyEdit`.  Reconcile forward while the arena is still `locked`
  // (re-snapshot the now-current content — the queue has not claimed it, so
  // the judge scores exactly what the live row shows); once claimed/judged it
  // is too late to reconcile, so the edit is REVERTED (an honest edit-history
  // entry) and the writer told `debate_locked` — never a silently unjudged
  // live change.
  if (debateDeps !== null) {
    for (const { arena } of debateParties) {
      const current = await forum.debates.getById(arena.debateId);
      if (current === null || current.state === 'open') continue;
      if (current.state === 'locked') {
        const snapshot = await snapshotDebateContent(debateDeps, current);
        if ((await forum.debates.refreshLockedContent(current.debateId, snapshot)) !== null) {
          continue; // the judged snapshot now includes this edit
        }
      }
      // Claimed or judged mid-race: put the previous material back.
      await forum.contributions.applyEdit(
        contributionId,
        { body: existing.body, citations: existing.citations },
        userId,
        randomUUID(),
      );
      return { ok: false, rejection: DEBATE_LOCKED_REJECTION };
    }
    // Fan the fresh material out to arena viewers (the activity clocks were
    // already reset by the pre-write touch-CAS above).  The projection reads
    // the CURRENT row, so a moderation-held edit broadcasts suppressed.
    for (const { arena } of debateParties) {
      await rebroadcastArena(debateDeps, arena.debateId);
    }
  }
  // The WS-U in-room agent RE-MODERATES the edited content (parity with the
  // create path, WS-U §24.6): an edit-to-violate-the-community-policy is caught
  // here too. Combined FLOOR-DOMINANTLY with the platform verdict (the agent can
  // only add caution, never lower a floor decision).
  const floorState: ModState =
    verdict.disposition === 'block'
      ? 'removed'
      : verdict.disposition === 'flag'
        ? 'under_review'
        : 'published';
  let target: ModState = floorState;
  let agentEscalated = false;
  let agentReason: string | null = null;
  if (editThread?.roomId != null && forum.agentModerator !== null) {
    const agent = await forum.agentModerator.moderateContribution({
      roomId: editThread.roomId,
      contributionId,
      authorUserId: userId,
      type: existing.type,
      body: patch.body ?? existing.body,
      citationCount: (patch.citations ?? existing.citations).length,
      attachmentCount: Array.isArray(existing.metadata['attachment_ids'])
        ? existing.metadata['attachment_ids'].length
        : 0,
    });
    if (agent !== null && MOD_STATE_RANK[agent.state] > MOD_STATE_RANK[target]) {
      target = agent.state;
      agentReason = agent.reason ?? null;
      agentEscalated = true;
    }
  }
  // Edit-to-introduce-spam/malware (floor) or to-violate-community-policy (agent)
  // is caught here: `removed` removes the edit (appealable system action);
  // `under_review` holds it for review.
  if (target !== 'published' && edited.moderationState === 'published') {
    forum.metrics.increment(
      agentEscalated && verdict.disposition === 'clear'
        ? 'contributions.edit_agent_flagged'
        : 'contributions.edit_safety_flagged',
    );
    const held = await forum.contributions.setModerationState(contributionId, target);
    if (verdict.disposition === 'block' && forum.autoModerationSink !== null) {
      // Awaited (not background): the auto-removal's appealable action/audit/
      // notice must be durable with the removal (no silent auto-removal).
      await forum.autoModerationSink.recordContentAutoBlock({
        contributionId,
        authorUserId: userId,
        reasonCode: verdict.reasonCode ?? 'MOD_SPAM_001',
        reasons: verdict.reasons,
      });
    }
    const storyId = await bundle.ingestion.stories.getStoryIdByThreadId(existing.threadId);
    await bundle.ingestion.reviewQueue.insert({
      kind: 'contribution_safety_hold',
      storyId,
      context: {
        contribution_id: contributionId,
        thread_id: existing.threadId,
        reasons: verdict.disposition !== 'clear' ? verdict.reasons : ['in_room_agent'],
        trigger: 'edit',
        ...(agentEscalated ? { source: 'in_room_agent' } : {}),
      },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      notBefore: null,
    });
    // The in-room agent held an edit the floor cleared: notify the author with
    // the agent's statement of reasons (no silent sanction).
    if (agentEscalated && verdict.disposition === 'clear' && forum.autoModerationSink !== null) {
      await forum.autoModerationSink.recordAgentHold({
        contributionId,
        authorUserId: userId,
        removed: target === 'removed',
        reason: agentReason,
      });
    }
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
  // WS-T — removing content that is party to a live debate (a correction row
  // may be party to TWO arenas: challenger of the one it opened AND incumbent
  // of one challenging it — every live arena gets its matching exit):
  //   • `open`: the removal IS the party's exit — the challenger removing the
  //     correction WITHDRAWS that debate (no verdict, the target's tag clears);
  //     the incumbent removing the challenged content CONCEDES that debate
  //     (the challenger prevails without adjudication).  Then the tombstone
  //     proceeds.
  //   • `locked`/`awaiting_verdict` on ANY of them: refused — the material is
  //     locked in until the AI resolution queue renders the verdict.
  //   • `judged`/terminal: the outcome already stands; removal proceeds.
  const debateParties = await liveArenasForContribution(forum.debates, contributionId);
  const closedArenaIds: string[] = [];
  if (anyDebateLockedIn(debateParties)) {
    return { ok: false, rejection: DEBATE_LOCKED_REJECTION };
  }
  const debateDeps = debateParties.length > 0 ? buildDebateDeps(forum, bundle.ingestion) : null;
  for (const { arena, side } of debateParties) {
    if (arena.state !== 'open' || debateDeps === null) continue;
    const outcome =
      side === 'challenger'
        ? await withdrawDebate(debateDeps, arena.debateId, userId)
        : await concedeDebate(debateDeps, arena.debateId, userId);
    // A close racing the lock loses (`window_closed`): the material just
    // locked in, so the removal is refused too.  A stale party record
    // (`not_found`/`not_*`) has nothing to close — the removal proceeds.
    if (!outcome.ok && outcome.reason === 'window_closed') {
      return { ok: false, rejection: DEBATE_LOCKED_REJECTION };
    }
    if (outcome.ok) closedArenaIds.push(arena.debateId);
  }
  const removed = await forum.contributions.setModerationState(contributionId, 'removed');
  if (!removed) {
    return {
      ok: false,
      rejection: { status: 404, code: 'not_found', message: 'Contribution not found' },
    };
  }
  // The close above broadcast its terminal frame BEFORE the tombstone landed —
  // and a client stops streaming a terminal arena, so without this it would
  // keep the pre-removal body forever.  Re-broadcast now: the projection reads
  // the tombstoned row and serves the suppressed content.
  if (debateDeps !== null) {
    for (const debateId of closedArenaIds) {
      await rebroadcastArena(debateDeps, debateId);
    }
  }
  forum.metrics.increment('contributions.removed');
  return { ok: true, contribution: removed };
}
