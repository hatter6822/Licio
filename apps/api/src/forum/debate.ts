// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate arena service (SPEC §15.4/§24.6).  A sourced correction against a
// comment or story opens a live, open debate arena: the incumbent (target
// author) and challenger (correction author) adjust their underlying content
// and post + edit a co-visible rebuttal statement (summary + sources) while the
// arena is open.  The arena queues for AI resolution by the EARLIER of:
//   • the expedited path — BOTH sides idle (no content/rebuttal edit) for the
//     inactivity window (1h): the material is locked in and queued immediately;
//   • the schedule — the 23h edit deadline locks the material; the final hour
//     is a frozen countdown; at 24h the debate enters the queue.
// While open, the challenger may WITHDRAW (closes with no verdict) and the
// incumbent may CONCEDE (the challenger prevails without adjudication).  The
// room's governed AI adjudicator then renders a probabilistic verdict over the
// LOCKED material; the room steward may FULLY overrule it (either direction)
// for 24h.  A `corrected` outcome tags the loser `incorrect` and sinks it to
// the bottom of its comment section / the feed — visible, never hidden.  This
// is NOT a vote (no member count anywhere; no-applause).

import type { DebateJudgeVerdict } from '@licio/ai-governance';
import {
  type Citation,
  type ContributionMetadata,
  DEBATE_EDIT_WINDOW_MS,
  DEBATE_INACTIVITY_WINDOW_MS,
  DEBATE_LOCK_WINDOW_MS,
  DEBATE_OVERRIDE_WINDOW_MS,
  type DebateArenaPublic,
  type DebateArenaSummary,
  type DebateContent,
  type DebateJudgeInput,
  type DebateJudgeSideInput,
  type DebatePosition,
  type DebatePositionUpdate,
  type DebateViewerRole,
  type DebateWinner,
  debateArenaPublicSchema,
  debateArenaSummarySchema,
} from '@licio/shared';
import { mapBounded } from '../lib/concurrency.js';
import type {
  DebateArenaRecord,
  DebateLockedContent,
  DebateLockedSide,
  DebateSidePosition,
  DebateStore,
} from './debate-store.js';
import type { ContributionStore } from './stores.js';

/** The room context handed to the judge runner: a governed room whose ratified
 *  agent holds the WS-U `debate.judge` capability adjudicates its own queue. */
export interface DebateJudgeContext {
  debateId: string;
  roomId: string | null;
}

/**
 * The governed-adjudicator port.  Runs the ProhibitedUseGuard + the model legs
 * (the room's ratified agent where granted, else the platform LLM leg, else
 * the deterministic MLP) + the AIOutputRecord (apps/api ai-governance/debate.ts).
 * A null result means the judge was UNAVAILABLE/BLOCKED — the arena resolves
 * fail-closed to `inconclusive` (nothing is tagged incorrect).
 */
export type DebateJudgeRunner = (
  context: DebateJudgeContext,
  input: DebateJudgeInput,
) => Promise<{ verdict: DebateJudgeVerdict; outputId: string | null } | null>;

/** Resolve a user's public identity for the arena projection (null = tombstone). */
export type DebateAuthorResolver = (
  userId: string | null,
) => Promise<{ handle: string; displayName: string } | null>;

/** Read a story's author (the incumbent for a story-target debate). */
export type StoryAuthorReader = (storyId: string) => Promise<string | null>;

/** True iff the user is a steward of the room (drives override authority). */
export type StewardReader = (roomId: string, userId: string) => Promise<boolean>;

/** Set a STORY's dispute posture (story-target debates); the ranking feed reads
 *  it to penalize a corrected story to the bottom of the feed. */
export type StoryDisputeSetter = (
  storyId: string,
  status: 'none' | 'under_debate' | 'incorrect' | 'validated',
) => Promise<void>;

/** A story's debatable material (the incumbent side of a story-target arena). */
export interface DebateStoryContent {
  title: string | null;
  /** The native-post body or the extraction excerpt ('' when neither exists). */
  body: string;
  /** The story's primary source as a citation (empty for a link-less native post). */
  citations: Citation[];
  updatedAt: string | null;
}

/** Read a story's debatable material (null = story missing). */
export type StoryContentReader = (storyId: string) => Promise<DebateStoryContent | null>;

/**
 * The arena window lengths. Production ALWAYS runs the §15.4 spec windows (the
 * shared DEBATE_*_WINDOW_MS constants — the defaults when the override is
 * absent).
 */
export interface DebateWindowPolicy {
  /** The outer co-visible edit window (spec: 23h). */
  editWindowMs: number;
  /** The scheduled final freeze between lock and the queue (spec: 1h). */
  lockWindowMs: number;
  /** The both-sides-idle expedited trigger (spec: 1h). */
  inactivityWindowMs: number;
  /** The steward-override window after the verdict (spec: 24h). */
  overrideWindowMs: number;
}

/** The §15.4 spec windows (the production policy, always). */
export const SPEC_DEBATE_WINDOWS: DebateWindowPolicy = {
  editWindowMs: DEBATE_EDIT_WINDOW_MS,
  lockWindowMs: DEBATE_LOCK_WINDOW_MS,
  inactivityWindowMs: DEBATE_INACTIVITY_WINDOW_MS,
  overrideWindowMs: DEBATE_OVERRIDE_WINDOW_MS,
};

/**
 * The window override (dev simulator / tests ONLY; nothing in production
 * wiring ever sets it).  The simulator scopes its shortened windows to arenas
 * whose parties are BOTH synthetic personas via `appliesToUser`, so a debate a
 * real dev-account user opens (or defends) in the dev environment runs the
 * REAL spec windows and can actually be watched live.
 */
export interface DebateWindowsOverride {
  windows: DebateWindowPolicy;
  /** When present, the shortened windows apply only if BOTH parties satisfy
   *  this predicate; absent ⇒ every arena (the test harness default). */
  appliesToUser?: (userId: string | null) => boolean;
}

/** Resolve the effective windows for an arena's two parties. */
export function resolveDebateWindows(
  override: DebateWindowsOverride | undefined,
  incumbentUserId: string | null,
  challengerUserId: string | null,
): DebateWindowPolicy {
  if (override === undefined) return SPEC_DEBATE_WINDOWS;
  if (override.appliesToUser === undefined) return override.windows;
  return override.appliesToUser(incumbentUserId) && override.appliesToUser(challengerUserId)
    ? override.windows
    : SPEC_DEBATE_WINDOWS;
}

export interface DebateDeps {
  debates: DebateStore;
  contributions: ContributionStore;
  storyAuthor: StoryAuthorReader;
  /** Read a story's debatable material (title/body/primary source). */
  storyContent: StoryContentReader;
  isSteward: StewardReader;
  setStoryDispute: StoryDisputeSetter;
  runJudge: DebateJudgeRunner;
  /** Fan-out a live arena frame (co-visible drafts / verdict / resolution). */
  broadcast?: (debateId: string, arena: DebateArenaPublic) => void;
  /** Window-length override (dev simulator / tests ONLY; absent ⇒ the §15.4
   *  spec constants). */
  windows?: DebateWindowsOverride | undefined;
  now: () => number;
  log: (event: string, meta: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Open (fired from a valid sourced correction).
// ---------------------------------------------------------------------------

export interface CorrectionForDebate {
  contributionId: string;
  threadId: string;
  storyId: string;
  roomId: string | null;
  userId: string | null;
  body: string;
  citations: Citation[];
  metadata: ContributionMetadata;
}

/**
 * Open a debate arena for a sourced correction, if one is not already open for
 * the same target.  Marks the target `under_debate`.  Returns the arena, or null
 * when the target is unknown / an arena is already open.
 */
export async function maybeEnterDebate(
  deps: DebateDeps,
  correction: CorrectionForDebate,
  debateId: string,
): Promise<DebateArenaRecord | null> {
  const targetContributionId = correction.metadata.target_contribution_id ?? null;
  const targetStoryId = correction.metadata.target_story_id ?? null;
  const targetType: 'comment' | 'story' = targetContributionId !== null ? 'comment' : 'story';

  let incumbentUserId: string | null = null;
  if (targetType === 'comment') {
    if (targetContributionId === null) return null;
    const target = await deps.contributions.getById(targetContributionId);
    if (target === null) return null;
    incumbentUserId = target.userId;
  } else {
    if (targetStoryId === null) return null;
    incumbentUserId = await deps.storyAuthor(targetStoryId);
  }

  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const windows = resolveDebateWindows(deps.windows, incumbentUserId, correction.userId);
  const editDeadlineAt = new Date(nowMs + windows.editWindowMs).toISOString();
  const resolveDueAt = new Date(nowMs + windows.editWindowMs + windows.lockWindowMs).toISOString();
  const arena = await deps.debates.open({
    debateId,
    storyId: correction.storyId,
    threadId: correction.threadId,
    roomId: correction.roomId,
    targetType,
    targetContributionId: targetType === 'comment' ? targetContributionId : null,
    challengerContributionId: correction.contributionId,
    incumbentUserId,
    challengerUserId: correction.userId,
    state: 'open',
    positions: {
      // The correction ITSELF is the challenger's opening material (shown live
      // on the arena as underlying content); the rebuttal statement starts
      // empty on both sides.
      challenger: { summary: '', citations: [], updatedAt: null },
      incumbent: { summary: '', citations: [], updatedAt: null },
    },
    editDeadlineAt,
    resolveDueAt,
    lockedAt: null,
    lockedContent: null,
    // Posting the correction IS challenger activity; the incumbent's clock
    // starts at open — with both idle, the expedited path queues the debate
    // one inactivity window after the challenge (the no-show fast path).
    incumbentLastActiveAt: nowIso,
    challengerLastActiveAt: nowIso,
    verdict: null,
    winner: null,
    decidedBy: null,
    rationale: null,
    confidence: null,
    aiOutputId: null,
    verdictAt: null,
    overrideDeadlineAt: null,
    overriddenByUserId: null,
    overrideReason: null,
    resolvedAt: null,
  });
  if (arena === null) return null;
  // Mark the challenged target `under_debate` (visible; not hidden).
  if (targetType === 'comment' && targetContributionId !== null) {
    await deps.contributions.setDisputeStatus(targetContributionId, 'under_debate');
  } else if (targetType === 'story') {
    await deps.setStoryDispute(correction.storyId, 'under_debate');
  }
  deps.log('forum.debate_opened', {
    debate_id: debateId,
    target_type: targetType,
    story_id: correction.storyId,
  });
  return arena;
}

// ---------------------------------------------------------------------------
// Post / edit a rebuttal statement (allowed while the arena is `open`).
// ---------------------------------------------------------------------------

export type PostPositionOutcome =
  | { ok: true; arena: DebateArenaRecord }
  | { ok: false; reason: 'not_found' | 'not_a_party' | 'window_closed' };

export async function postDebatePosition(
  deps: DebateDeps,
  debateId: string,
  userId: string,
  update: DebatePositionUpdate,
): Promise<PostPositionOutcome> {
  const arena = await deps.debates.getById(debateId);
  if (arena === null) return { ok: false, reason: 'not_found' };
  const side = sideOf(arena, userId);
  if (side === null) return { ok: false, reason: 'not_a_party' };
  // Rejected once the material is locked in (the expedited/scheduled lock or
  // the outer edit deadline), or the arena is past `open` for any other reason.
  if (arena.state !== 'open' || new Date(deps.now()).toISOString() > arena.editDeadlineAt) {
    return { ok: false, reason: 'window_closed' };
  }
  const position: DebateSidePosition = {
    summary: update.summary,
    citations: [...update.citations],
    updatedAt: new Date(deps.now()).toISOString(),
  };
  // The store also resets the side's activity clock (the expedited path).
  const updated = await deps.debates.updatePosition(debateId, side, position);
  if (updated === null) return { ok: false, reason: 'not_found' };
  await broadcastArena(deps, updated);
  return { ok: true, arena: updated };
}

/**
 * Reset a party's activity clock after an edit to their UNDERLYING content
 * (the correction, or the challenged comment) while its arena is open, and
 * fan the fresh material out to arena viewers.  A no-op for a contribution
 * with no live arena.  Story edits have no author edit path today, so the
 * incumbent side of a story-target arena is touched only via its rebuttal.
 */
export async function touchDebateActivityForContribution(
  deps: DebateDeps,
  contributionId: string,
): Promise<void> {
  const asTarget = await deps.debates.getActiveForComment(contributionId);
  const asCorrection =
    asTarget === null ? await deps.debates.getActiveForCorrection(contributionId) : null;
  const arena = asTarget ?? asCorrection;
  if (arena === null || arena.state !== 'open') return;
  const side = asTarget !== null ? 'incumbent' : 'challenger';
  const touched = await deps.debates.touchActivity(
    arena.debateId,
    side,
    new Date(deps.now()).toISOString(),
  );
  if (touched !== null) await broadcastArena(deps, touched);
}

// ---------------------------------------------------------------------------
// Lock (the material is locked in: the hour-23 schedule or both sides idle).
// ---------------------------------------------------------------------------

const EMPTY_LOCKED_SIDE: DebateLockedSide = {
  title: null,
  body: '',
  citations: [],
  updatedAt: null,
};

/** Snapshot both sides' underlying material (what the queue will judge). */
async function snapshotDebateContent(
  deps: DebateDeps,
  arena: DebateArenaRecord,
): Promise<DebateLockedContent> {
  let target: DebateLockedSide = EMPTY_LOCKED_SIDE;
  if (arena.targetType === 'comment' && arena.targetContributionId !== null) {
    const row = await deps.contributions.getById(arena.targetContributionId);
    if (row !== null) {
      target = {
        title: null,
        body: row.body,
        citations: [...row.citations],
        updatedAt: row.updatedAt,
      };
    }
  } else {
    const story = await deps.storyContent(arena.storyId);
    if (story !== null) {
      target = {
        title: story.title,
        body: story.body,
        citations: [...story.citations],
        updatedAt: story.updatedAt,
      };
    }
  }
  const correctionRow = await deps.contributions.getById(arena.challengerContributionId);
  const correction: DebateLockedSide =
    correctionRow === null
      ? EMPTY_LOCKED_SIDE
      : {
          title: null,
          body: correctionRow.body,
          citations: [...correctionRow.citations],
          updatedAt: correctionRow.updatedAt,
        };
  return { target, correction };
}

/**
 * Lock an open arena's material in (`open` → `locked`), snapshotting both
 * sides' underlying content for the AI resolution queue.  `expedited` (the
 * both-sides-idle path) also pulls `resolveDueAt` forward to the lock instant
 * so the queue picks the debate up on the SAME lifecycle pass.  Idempotent —
 * a non-`open` arena is returned unchanged (the store CAS refuses).
 */
export async function lockDebateArena(
  deps: DebateDeps,
  debateId: string,
  mode: 'scheduled' | 'expedited',
): Promise<DebateArenaRecord | null> {
  const arena = await deps.debates.getById(debateId);
  if (arena === null) return null;
  if (arena.state !== 'open') return arena;
  const content = await snapshotDebateContent(deps, arena);
  const nowIso = new Date(deps.now()).toISOString();
  const locked = await deps.debates.lock(
    debateId,
    nowIso,
    content,
    mode === 'expedited' ? nowIso : undefined,
  );
  // Lost the CAS (a concurrent lock/withdrawal/concession won) — return current.
  if (locked === null) return deps.debates.getById(debateId);
  deps.log('forum.debate_locked', { debate_id: debateId, mode });
  await broadcastArena(deps, locked);
  return locked;
}

// ---------------------------------------------------------------------------
// Judge (the AI resolution queue).
// ---------------------------------------------------------------------------

/**
 * Run the governed adjudicator over a queued arena, record the verdict, and
 * open the 24h steward-override window.  Fail-closed: a blocked/unavailable
 * judge resolves to `inconclusive` (nothing tagged).  Idempotent — a no-op
 * unless the arena is `open`/`locked`/`awaiting_verdict`.
 */
export async function judgeDebateArena(
  deps: DebateDeps,
  debateId: string,
): Promise<DebateArenaRecord | null> {
  // Catch-up: an arena the lock sweep never saw (scheduler down through both
  // deadlines) is locked here so the judge always scores a LOCKED snapshot.
  const pre = await deps.debates.getById(debateId);
  if (pre === null) return null;
  if (pre.state === 'open') await lockDebateArena(deps, debateId, 'scheduled');
  // ATOMICALLY claim the arena (→ `awaiting_verdict`) BEFORE the judge runs,
  // and score the post-claim snapshot the claim returns. Adjudication can be
  // slow (a real LLM); without the claim, a write racing the judge could land
  // mid-computation and be silently ignored. From the lock onward the
  // store-level `state = 'open'` guards reject every change with an explicit
  // `window_closed` — a timely write either beat the lock and IS judged, or
  // the writer is told it wasn't considered; never a silent drop.
  // (Re-claiming `awaiting_verdict` succeeds: a claim whose judge crashed is
  // re-judged on a later tick.) A judged/terminal arena refuses the claim —
  // return it unchanged (the idempotent no-op).
  const arena = await deps.debates.claimForVerdict(debateId);
  if (arena === null) return deps.debates.getById(debateId);
  // Co-viewers see the arena enter the resolution queue immediately.
  await broadcastArena(deps, arena);

  const input = assembleJudgeInput(arena);
  const result = await deps.runJudge({ debateId, roomId: arena.roomId }, input);
  const nowMs = deps.now();
  const verdictAt = new Date(nowMs).toISOString();
  const overrideDeadlineAt = new Date(
    nowMs +
      resolveDebateWindows(deps.windows, arena.incumbentUserId, arena.challengerUserId)
        .overrideWindowMs,
  ).toISOString();

  const patch =
    result === null
      ? {
          verdict: 'inconclusive' as const,
          winner: 'none' as const,
          decidedBy: 'ai' as const,
          rationale: 'The adjudicator was unavailable; the challenge is inconclusive.',
          confidence: null,
          aiOutputId: null,
          verdictAt,
          overrideDeadlineAt,
          state: 'judged' as const,
        }
      : {
          verdict: result.verdict.verdict,
          winner: result.verdict.winner,
          decidedBy: 'ai' as const,
          rationale: result.verdict.rationale,
          confidence: result.verdict.confidence,
          aiOutputId: result.outputId,
          verdictAt,
          overrideDeadlineAt,
          state: 'judged' as const,
        };
  const updated = await deps.debates.recordVerdict(debateId, patch);
  if (updated === null) return null;
  deps.log('forum.debate_judged', {
    debate_id: debateId,
    verdict: patch.verdict,
    winner: patch.winner,
    ai_output_id: patch.aiOutputId,
  });
  await broadcastArena(deps, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Steward override (full overrule, either direction; 24h window).
// ---------------------------------------------------------------------------

export type OverrideOutcome =
  | { ok: true; arena: DebateArenaRecord }
  | { ok: false; reason: 'not_found' | 'not_steward' | 'not_judged' | 'window_closed' };

export async function overrideDebateVerdict(
  deps: DebateDeps,
  debateId: string,
  userId: string,
  winner: DebateWinner,
  reason: string,
): Promise<OverrideOutcome> {
  const arena = await deps.debates.getById(debateId);
  if (arena === null) return { ok: false, reason: 'not_found' };
  if (arena.state !== 'judged') return { ok: false, reason: 'not_judged' };
  if (
    arena.overrideDeadlineAt === null ||
    new Date(deps.now()).toISOString() > arena.overrideDeadlineAt
  ) {
    return { ok: false, reason: 'window_closed' };
  }
  // Full overrule is a room-governance power: the room steward only, audited,
  // subordinate to the platform floor (a floor removal is a moderation state, not
  // a dispute status, and is untouched here).
  if (arena.roomId === null || !(await deps.isSteward(arena.roomId, userId))) {
    return { ok: false, reason: 'not_steward' };
  }
  const verdict =
    winner === 'challenger' ? 'corrected' : winner === 'incumbent' ? 'upheld' : 'inconclusive';
  const updated = await deps.debates.recordOverride(debateId, {
    verdict,
    winner,
    overriddenByUserId: userId,
    overrideReason: reason,
  });
  if (updated === null) return { ok: false, reason: 'not_found' };
  deps.log('forum.debate_overridden', {
    debate_id: debateId,
    winner,
    steward: `steward:${userId}`,
  });
  await broadcastArena(deps, updated);
  return { ok: true, arena: updated };
}

// ---------------------------------------------------------------------------
// Withdraw / concede (party-driven early closes, allowed while `open`).
// ---------------------------------------------------------------------------

export type WithdrawOutcome =
  | { ok: true; arena: DebateArenaRecord }
  | { ok: false; reason: 'not_found' | 'not_challenger' | 'window_closed' };

/**
 * The challenger retracts the correction while the arena is open: the debate
 * closes as `withdrawn` — no verdict, and the target's `under_debate` tag
 * clears back to `none` (the target stays re-challengeable).
 */
export async function withdrawDebate(
  deps: DebateDeps,
  debateId: string,
  userId: string,
): Promise<WithdrawOutcome> {
  const arena = await deps.debates.getById(debateId);
  if (arena === null) return { ok: false, reason: 'not_found' };
  if (arena.challengerUserId !== userId) return { ok: false, reason: 'not_challenger' };
  const nowIso = new Date(deps.now()).toISOString();
  if (arena.state !== 'open' || nowIso > arena.editDeadlineAt) {
    return { ok: false, reason: 'window_closed' };
  }
  // The store CAS (`open` only): a withdrawal racing the lock loses.
  const closed = await deps.debates.withdraw(debateId, nowIso);
  if (closed === null) return { ok: false, reason: 'window_closed' };
  await clearDisputeTag(deps, closed);
  deps.log('forum.debate_withdrawn', { debate_id: debateId, story_id: arena.storyId });
  await broadcastArena(deps, closed);
  return { ok: true, arena: closed };
}

export type ConcedeOutcome =
  | { ok: true; arena: DebateArenaRecord }
  | { ok: false; reason: 'not_found' | 'not_incumbent' | 'window_closed' };

/**
 * The incumbent concedes while the arena is open: the challenger prevails
 * without adjudication — the debate resolves `corrected` with
 * `decided_by = 'concession'` and the target is tagged `incorrect`.
 */
export async function concedeDebate(
  deps: DebateDeps,
  debateId: string,
  userId: string,
): Promise<ConcedeOutcome> {
  const arena = await deps.debates.getById(debateId);
  if (arena === null) return { ok: false, reason: 'not_found' };
  if (arena.incumbentUserId !== userId) return { ok: false, reason: 'not_incumbent' };
  const nowIso = new Date(deps.now()).toISOString();
  if (arena.state !== 'open' || nowIso > arena.editDeadlineAt) {
    return { ok: false, reason: 'window_closed' };
  }
  // The store CAS (`open` only): a concession racing the lock loses.
  const closed = await deps.debates.concede(debateId, {
    verdict: 'corrected',
    winner: 'challenger',
    decidedBy: 'concession',
    rationale: 'The incumbent conceded the challenge.',
    verdictAt: nowIso,
    resolvedAt: nowIso,
  });
  if (closed === null) return { ok: false, reason: 'window_closed' };
  // Apply the outcome to the conceded target (visible-but-sunk, never hidden).
  if (closed.targetType === 'comment' && closed.targetContributionId !== null) {
    await deps.contributions.setDisputeStatus(closed.targetContributionId, 'incorrect');
  } else if (closed.targetType === 'story') {
    await deps.setStoryDispute(closed.storyId, 'incorrect');
  }
  deps.log('forum.debate_conceded', { debate_id: debateId, story_id: arena.storyId });
  await broadcastArena(deps, closed);
  return { ok: true, arena: closed };
}

/** Clear the challenged target's `under_debate` tag back to `none`. */
async function clearDisputeTag(deps: DebateDeps, arena: DebateArenaRecord): Promise<void> {
  if (arena.targetType === 'comment' && arena.targetContributionId !== null) {
    await deps.contributions.setDisputeStatus(arena.targetContributionId, 'none');
  } else if (arena.targetType === 'story') {
    await deps.setStoryDispute(arena.storyId, 'none');
  }
}

// ---------------------------------------------------------------------------
// Finalize (the 24h override window has closed) — apply the outcome.
// ---------------------------------------------------------------------------

export async function finalizeDebate(
  deps: DebateDeps,
  debateId: string,
): Promise<DebateArenaRecord | null> {
  const arena = await deps.debates.getById(debateId);
  if (arena === null) return null;
  if (arena.state !== 'judged') return arena;
  const resolvedAt = new Date(deps.now()).toISOString();
  // Apply the dispute outcome to the CHALLENGED target. `corrected` ⇒ tagged
  // `incorrect` (and, for a story, demoted to the bottom of the feed by the
  // ranking layer reading dispute_status); `upheld` ⇒ tagged `validated`
  // (challenged and proven accurate — no penalty, still re-challengeable);
  // `inconclusive`/absent ⇒ cleared back to `none`.
  // A `validated` outcome earns a ranking / participation BOOST, so it must reflect
  // INDEPENDENT scrutiny: a self-targeted arena (the challenger IS the target's own
  // author) can never earn `validated` — an upheld self-challenge clears to `none`,
  // closing the boost-farming vector. `corrected`/`inconclusive` are unaffected
  // (self-marking incorrect is self-inflicted, never a reward).
  const selfTargeted =
    arena.incumbentUserId !== null && arena.incumbentUserId === arena.challengerUserId;
  const resolvedStatus: 'incorrect' | 'validated' | 'none' =
    arena.verdict === 'corrected'
      ? 'incorrect'
      : arena.verdict === 'upheld' && !selfTargeted
        ? 'validated'
        : 'none';
  if (arena.targetType === 'comment' && arena.targetContributionId !== null) {
    await deps.contributions.setDisputeStatus(arena.targetContributionId, resolvedStatus);
  } else if (arena.targetType === 'story') {
    await deps.setStoryDispute(arena.storyId, resolvedStatus);
  }
  const updated = await deps.debates.setState(debateId, 'resolved', resolvedAt);
  if (updated === null) return null;
  deps.log('forum.debate_resolved', {
    debate_id: debateId,
    verdict: arena.verdict,
    target_dispute_status: resolvedStatus,
  });
  await broadcastArena(deps, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Scheduler tick (the lease-guarded deadline sweep).
// ---------------------------------------------------------------------------

/** Concurrent adjudications per lifecycle pass. Arenas are independent, so the
 *  judge calls fan out: a real local runtime serves parallel slots (Ollama
 *  defaults to 4; vLLM batches far wider), roughly dividing a backlog's
 *  wall-clock by this factor — and a single-slot runtime simply queues the
 *  extra requests server-side, no worse than serial. The budget + breaker are
 *  synchronous in-process state, safe under this interleaving (the breaker's
 *  half-open path is explicitly concurrency-hardened). */
export const DEBATE_JUDGE_CONCURRENCY = 4;

/**
 * One debate-lifecycle sweep, in four passes:
 *   1. LOCK — every `open` arena past its 23h edit deadline locks its
 *      material in (the scheduled path; the final hour is a frozen countdown);
 *   2. EXPEDITE — every `open` arena where BOTH sides have gone the
 *      inactivity window without an edit locks immediately AND pulls its
 *      queue entry forward to now (the material is settled);
 *   3. JUDGE — every arena past its resolve-due instant (including the ones
 *      pass 2 just expedited) is adjudicated, fanned out `concurrency`-wide —
 *      the adjudicator is the expensive step;
 *   4. FINALIZE — every judged arena whose 24h override window has closed.
 * Bounded per tick; idempotent (each stage no-ops on an already-advanced
 * arena); per-arena failures are ISOLATED (logged, the rest of the batch
 * proceeds — one poisoned arena must not stall every other verdict).
 *
 * `judgeDeadlineMs` bounds the judge pass in WALL-CLOCK time: once passed, the
 * remaining due arenas are SKIPPED (they stay queued for the next tick/holder).
 * The scheduler derives it from its job-lease window so a slow-LLM backlog can
 * never hold work past the lease — the store-level verdict CAS
 * (`recordVerdict`) independently guarantees a stale overrun can't clobber
 * another holder's verdict, so the deadline is a cost bound, not the
 * correctness mechanism. Absent ⇒ unbounded (the dev simulator's tick).
 */
export async function runDebateLifecycle(
  deps: DebateDeps,
  limit = 100,
  concurrency = DEBATE_JUDGE_CONCURRENCY,
  judgeDeadlineMs?: number,
): Promise<{ locked: number; expedited: number; judged: number; finalized: number }> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  let locked = 0;
  let expedited = 0;
  let judged = 0;
  let finalized = 0;
  let skippedForDeadline = 0;

  // 1. The scheduled hour-23 lock sweep.
  const dueLock = await deps.debates.listDueForLock(nowIso, limit);
  for (const outcome of await mapBounded(dueLock, concurrency, (arena) =>
    lockDebateArena(deps, arena.debateId, 'scheduled'),
  )) {
    if (outcome.ok && outcome.value?.state === 'locked') locked += 1;
    else if (!outcome.ok) deps.log('forum.debate_lock_failed', { error: String(outcome.error) });
  }

  // 2. The both-sides-idle expedited sweep.  The store query uses the
  //    SHORTEST configured inactivity window as the coarse cutoff; each
  //    candidate is then re-checked against ITS OWN effective windows (a
  //    sim-scoped override shortens only both-synthetic arenas).
  const shortestIdleMs = Math.min(
    SPEC_DEBATE_WINDOWS.inactivityWindowMs,
    deps.windows?.windows.inactivityWindowMs ?? SPEC_DEBATE_WINDOWS.inactivityWindowMs,
  );
  const idleCandidates = await deps.debates.listIdleSince(
    new Date(nowMs - shortestIdleMs).toISOString(),
    limit,
  );
  for (const outcome of await mapBounded(idleCandidates, concurrency, async (arena) => {
    const windows = resolveDebateWindows(
      deps.windows,
      arena.incumbentUserId,
      arena.challengerUserId,
    );
    const lastActiveIso =
      arena.incumbentLastActiveAt > arena.challengerLastActiveAt
        ? arena.incumbentLastActiveAt
        : arena.challengerLastActiveAt;
    if (Date.parse(lastActiveIso) + windows.inactivityWindowMs > nowMs) return null;
    // Already due on the schedule — pass 3 picks it up without the pull-forward.
    if (arena.resolveDueAt <= nowIso) return null;
    return lockDebateArena(deps, arena.debateId, 'expedited');
  })) {
    if (outcome.ok && outcome.value?.state === 'locked') expedited += 1;
    else if (!outcome.ok) {
      deps.log('forum.debate_expedite_failed', { error: String(outcome.error) });
    }
  }

  // 3. Drain the AI resolution queue (includes everything pass 2 expedited).
  const due = await deps.debates.listPastResolveDeadline(nowIso, limit);
  for (const outcome of await mapBounded(due, concurrency, async (arena) => {
    if (judgeDeadlineMs !== undefined && deps.now() > judgeDeadlineMs) {
      skippedForDeadline += 1;
      return null;
    }
    return judgeDebateArena(deps, arena.debateId);
  })) {
    if (outcome.ok && outcome.value?.state === 'judged') judged += 1;
    else if (!outcome.ok) deps.log('forum.debate_judge_failed', { error: String(outcome.error) });
  }
  if (skippedForDeadline > 0) {
    deps.log('forum.debate_judge_deadline', { skipped: skippedForDeadline });
  }

  // 4. Finalize past the steward-override window.
  const closable = await deps.debates.listPastOverrideDeadline(nowIso, limit);
  for (const outcome of await mapBounded(closable, concurrency, (arena) =>
    finalizeDebate(deps, arena.debateId),
  )) {
    if (outcome.ok && outcome.value?.state === 'resolved') finalized += 1;
    else if (!outcome.ok) {
      deps.log('forum.debate_finalize_failed', { error: String(outcome.error) });
    }
  }
  return { locked, expedited, judged, finalized };
}

// ---------------------------------------------------------------------------
// Projection + helpers.
// ---------------------------------------------------------------------------

function sideOf(arena: DebateArenaRecord, userId: string): 'incumbent' | 'challenger' | null {
  if (arena.incumbentUserId === userId) return 'incumbent';
  if (arena.challengerUserId === userId) return 'challenger';
  return null;
}

/**
 * A curated set of common two-label public suffixes (`example.co.uk` →
 * registrable `example.co.uk`, not `co.uk`).  This is a deliberately BOUNDED
 * heuristic, not the full Mozilla Public Suffix List (which would be a large
 * versioned dependency): it covers the widely-abused registry suffixes so the
 * judge's independent-source count cannot be trivially inflated with sibling
 * subdomains.  An unknown multi-label suffix falls back to last-two-labels — a
 * conservative default that treats sibling subdomains as ONE registrable domain
 * (never over-counting), the property the anti-gaming feature needs.
 */
const TWO_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set(
  (
    'co.uk org.uk gov.uk ac.uk me.uk net.uk sch.uk ltd.uk plc.uk ' +
    'com.au net.au org.au edu.au gov.au id.au ' +
    'co.nz net.nz org.nz govt.nz ac.nz ' +
    'co.jp or.jp ne.jp go.jp ac.jp co.kr or.kr go.kr ' +
    'co.in net.in org.in gen.in firm.in gov.in ac.in ' +
    'com.br net.br org.br gov.br edu.br com.cn net.cn org.cn gov.cn edu.cn ' +
    'co.za org.za gov.za net.za ac.za com.mx org.mx gob.mx edu.mx ' +
    'com.sg edu.sg gov.sg org.sg com.hk org.hk gov.hk edu.hk ' +
    'com.tr gov.tr org.tr edu.tr com.ar gob.ar org.ar edu.ar ' +
    'co.il org.il gov.il ac.il com.tw org.tw gov.tw edu.tw ' +
    'com.ua gov.ua org.ua com.ph gov.ph edu.ph com.my gov.my org.my edu.my'
  ).split(' '),
);

/**
 * Extract the REGISTRABLE domain (eTLD+1) from a citation URL (null for
 * doi:/opaque).  `a.example.com`, `b.example.com`, and `example.com` all resolve
 * to `example.com` — so a challenger cannot inflate the judge's distinct-source
 * feature by citing sibling subdomains of one registrable domain.
 */
export function domainOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
    if (host.length === 0) return null;
    const labels = host.split('.');
    if (labels.length <= 2) return host;
    const lastTwo = labels.slice(-2).join('.');
    // A known two-label registry suffix means the registrable domain is the
    // last THREE labels (`example` + `co.uk`); otherwise it is the last two.
    const take = TWO_LABEL_PUBLIC_SUFFIXES.has(lastTwo) ? 3 : 2;
    return labels.slice(-take).join('.');
  } catch {
    return null;
  }
}

function toJudgeSide(
  side: 'incumbent' | 'challenger',
  content: DebateLockedSide,
  position: DebateSidePosition,
): DebateJudgeSideInput {
  // The judge weighs the UNION of the side's sourcing: the locked underlying
  // content's citations plus the rebuttal statement's (deduped by URL).
  const byUrl = new Map<string, Citation>();
  for (const c of [...content.citations, ...position.citations]) {
    if (!byUrl.has(c.url)) byUrl.set(c.url, c);
  }
  const contentText =
    content.title !== null && content.title.length > 0
      ? `${content.title}\n\n${content.body}`
      : content.body;
  return {
    content: contentText,
    summary: position.summary,
    sources: [...byUrl.values()].map((c) => ({
      url: c.url,
      domain: domainOf(c.url),
      // The citation schema already rejects dangerous schemes; an http(s) URL is
      // treated as link-safe here (the WS-F reliability signal is null = unknown
      // until the source-profile reader is wired).
      link_safe: /^https?:\/\//i.test(c.url),
      reliability: null,
    })),
    // The correction inherently rebuts the target; the incumbent rebuts only
    // once they post a substantive rebuttal statement.
    rebuts_opponent:
      side === 'challenger'
        ? contentText.trim().length > 0 || position.summary.trim().length > 0
        : position.summary.trim().length > 0,
  };
}

/** Build the content-structural adjudicator input from the LOCKED material +
 *  the two rebuttal statements. */
export function assembleJudgeInput(arena: DebateArenaRecord): DebateJudgeInput {
  const locked = arena.lockedContent;
  return {
    incumbent: toJudgeSide(
      'incumbent',
      locked?.target ?? EMPTY_LOCKED_SIDE,
      arena.positions.incumbent,
    ),
    challenger: toJudgeSide(
      'challenger',
      locked?.correction ?? EMPTY_LOCKED_SIDE,
      arena.positions.challenger,
    ),
  };
}

function sidePosition(
  side: 'incumbent' | 'challenger',
  position: DebateSidePosition,
  author: { handle: string; displayName: string } | null,
  isAuthor: boolean,
): DebatePosition {
  return {
    side,
    author_handle: author?.handle ?? null,
    author_display_name: author?.displayName ?? null,
    is_author: isAuthor,
    summary: position.summary,
    citations: position.citations,
    updated_at: position.updatedAt,
    submitted: position.summary.trim().length > 0 || position.citations.length > 0,
  };
}

/** The two underlying-content projections the arena page renders. */
export interface DebateArenaContent {
  target: DebateContent | null;
  correction: DebateContent | null;
}

function projectContent(
  kind: DebateContent['kind'],
  side: DebateLockedSide,
  suppressed: boolean,
  locked: boolean,
): DebateContent {
  // A row the moderation floor has since removed/hidden keeps its arena SLOT
  // (the debate happened) but never re-serves the suppressed body on the wire.
  return {
    kind,
    title: suppressed ? null : side.title,
    body: suppressed ? '' : side.body,
    citations: suppressed ? [] : side.citations,
    updated_at: side.updatedAt,
    removed: suppressed,
    locked,
  };
}

/**
 * Read the material under debate for the arena projection: the LIVE underlying
 * content while the arena is `open` (either author may still be adjusting it),
 * and the locked snapshot from the lock onward.  A currently moderation-
 * removed/hidden row projects with `removed: true` and no body — the arena
 * never re-serves content the floor has taken down.
 */
export async function readDebateArenaContent(
  contributions: Pick<ContributionStore, 'getById'>,
  storyContent: StoryContentReader,
  arena: DebateArenaRecord,
): Promise<DebateArenaContent> {
  const locked = arena.lockedContent;

  const correctionRow = await contributions.getById(arena.challengerContributionId);
  const correctionSuppressed =
    correctionRow !== null &&
    (correctionRow.moderationState === 'removed' || correctionRow.moderationState === 'hidden');
  let correction: DebateContent | null = null;
  if (locked !== null) {
    correction = projectContent('correction', locked.correction, correctionSuppressed, true);
  } else if (correctionRow !== null) {
    correction = projectContent(
      'correction',
      {
        title: null,
        body: correctionRow.body,
        citations: correctionRow.citations,
        updatedAt: correctionRow.updatedAt,
      },
      correctionSuppressed,
      false,
    );
  }

  let target: DebateContent | null = null;
  if (arena.targetType === 'comment' && arena.targetContributionId !== null) {
    const targetRow = await contributions.getById(arena.targetContributionId);
    const targetSuppressed =
      targetRow !== null &&
      (targetRow.moderationState === 'removed' || targetRow.moderationState === 'hidden');
    if (locked !== null) {
      target = projectContent('comment', locked.target, targetSuppressed, true);
    } else if (targetRow !== null) {
      target = projectContent(
        'comment',
        {
          title: null,
          body: targetRow.body,
          citations: targetRow.citations,
          updatedAt: targetRow.updatedAt,
        },
        targetSuppressed,
        false,
      );
    }
  } else {
    // Story target.  The reader returns null for a missing/hidden story; a
    // locked snapshot still projects (the debate happened over it).
    const story = await storyContent(arena.storyId);
    if (locked !== null) {
      target = projectContent('story', locked.target, false, true);
    } else if (story !== null) {
      target = projectContent(
        'story',
        {
          title: story.title,
          body: story.body,
          citations: story.citations,
          updatedAt: story.updatedAt,
        },
        false,
        false,
      );
    }
  }
  return { target, correction };
}

/** Project an arena record to its public wire shape for `viewerUserId`. */
export async function toDebateArenaPublic(
  arena: DebateArenaRecord,
  viewerUserId: string | null,
  resolveAuthor: DebateAuthorResolver,
  viewerIsSteward: boolean,
  content: DebateArenaContent,
): Promise<DebateArenaPublic> {
  const [incumbentAuthor, challengerAuthor, overriddenBy] = await Promise.all([
    resolveAuthor(arena.incumbentUserId),
    resolveAuthor(arena.challengerUserId),
    resolveAuthor(arena.overriddenByUserId),
  ]);
  const viewerRole: DebateViewerRole =
    viewerUserId !== null && arena.incumbentUserId === viewerUserId
      ? 'incumbent'
      : viewerUserId !== null && arena.challengerUserId === viewerUserId
        ? 'challenger'
        : viewerIsSteward
          ? 'steward'
          : 'observer';
  return debateArenaPublicSchema.parse({
    debate_id: arena.debateId,
    story_id: arena.storyId,
    thread_id: arena.threadId,
    room_id: arena.roomId,
    target_type: arena.targetType,
    target_contribution_id: arena.targetContributionId,
    challenger_contribution_id: arena.challengerContributionId,
    state: arena.state,
    incumbent: sidePosition(
      'incumbent',
      arena.positions.incumbent,
      incumbentAuthor,
      viewerUserId !== null && arena.incumbentUserId === viewerUserId,
    ),
    challenger: sidePosition(
      'challenger',
      arena.positions.challenger,
      challengerAuthor,
      viewerUserId !== null && arena.challengerUserId === viewerUserId,
    ),
    target_content: content.target,
    correction_content: content.correction,
    edit_deadline_at: arena.editDeadlineAt,
    resolve_due_at: arena.resolveDueAt,
    locked_at: arena.lockedAt,
    incumbent_last_active_at: arena.incumbentLastActiveAt,
    challenger_last_active_at: arena.challengerLastActiveAt,
    verdict: arena.verdict,
    winner: arena.winner,
    decided_by: arena.decidedBy,
    rationale: arena.rationale,
    confidence: arena.confidence,
    ai_output_id: arena.aiOutputId,
    verdict_at: arena.verdictAt,
    override_deadline_at: arena.overrideDeadlineAt,
    overridden_by_handle: overriddenBy?.handle ?? null,
    override_reason: arena.overrideReason,
    resolved_at: arena.resolvedAt,
    viewer_role: viewerRole,
    created_at: arena.createdAt,
    updated_at: arena.updatedAt,
  });
}

/**
 * Compact, display-only summary for the story-level active-debates list — no
 * per-viewer role and no both-sides' sources (those load on the arena page).
 */
export async function toDebateArenaSummary(
  arena: DebateArenaRecord,
  resolveAuthor: DebateAuthorResolver,
  targetExcerpt: string | null,
): Promise<DebateArenaSummary> {
  const [incumbent, challenger] = await Promise.all([
    resolveAuthor(arena.incumbentUserId),
    resolveAuthor(arena.challengerUserId),
  ]);
  const trimmed = targetExcerpt?.trim() ?? '';
  return debateArenaSummarySchema.parse({
    debate_id: arena.debateId,
    story_id: arena.storyId,
    target_type: arena.targetType,
    target_contribution_id: arena.targetContributionId,
    challenger_contribution_id: arena.challengerContributionId,
    state: arena.state,
    edit_deadline_at: arena.editDeadlineAt,
    resolve_due_at: arena.resolveDueAt,
    override_deadline_at: arena.overrideDeadlineAt,
    verdict: arena.verdict,
    winner: arena.winner,
    incumbent_display_name: incumbent?.displayName ?? null,
    challenger_display_name: challenger?.displayName ?? null,
    target_excerpt: trimmed.length > 0 ? trimmed.slice(0, 280) : null,
    created_at: arena.createdAt,
    updated_at: arena.updatedAt,
  });
}

/** Fan out a live arena frame (best-effort; the observer projection). */
async function broadcastArena(deps: DebateDeps, arena: DebateArenaRecord): Promise<void> {
  if (deps.broadcast === undefined) return;
  // The live frame is the OBSERVER projection (no per-viewer is_author flags on
  // the wire); each client re-fetches its own role-scoped view on nudge.
  const content = await readDebateArenaContent(deps.contributions, deps.storyContent, arena);
  const projected = await toDebateArenaPublic(arena, null, async () => null, false, content);
  deps.broadcast(arena.debateId, projected);
}
