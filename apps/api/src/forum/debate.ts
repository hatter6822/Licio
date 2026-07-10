// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate arena service (SPEC §15.4/§24.6).  A sourced correction against a
// comment or story opens a live, open debate arena: the incumbent (target
// author) and challenger (correction author) post + edit a co-visible position
// (summary + sources) for 12h; the room's governed AI adjudicator then renders a
// probabilistic verdict; the room steward may FULLY overrule it (either
// direction) for 24h.  A `corrected` outcome tags the loser `incorrect` and
// sinks it to the bottom of its comment section / the feed — visible, never
// hidden.  This is NOT a vote (no member count anywhere; no-applause).

import type { DebateJudgeVerdict } from '@licio/ai-governance';
import {
  type Citation,
  type ContributionMetadata,
  DEBATE_EDIT_WINDOW_MS,
  DEBATE_OVERRIDE_WINDOW_MS,
  type DebateArenaPublic,
  type DebateArenaSummary,
  type DebateJudgeInput,
  type DebateJudgeSideInput,
  type DebatePosition,
  type DebatePositionUpdate,
  type DebateViewerRole,
  type DebateWinner,
  debateArenaPublicSchema,
  debateArenaSummarySchema,
} from '@licio/shared';
import type { DebateArenaRecord, DebateSidePosition, DebateStore } from './debate-store.js';
import type { ContributionStore } from './stores.js';

/**
 * The governed-adjudicator port.  Runs the ProhibitedUseGuard + the neural model
 * + the AIOutputRecord (apps/api ai-governance/debate.ts).  A null result means
 * the judge was UNAVAILABLE/BLOCKED — the arena resolves fail-closed to
 * `inconclusive` (nothing is tagged incorrect).
 */
export type DebateJudgeRunner = (
  debateId: string,
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

/**
 * The arena window lengths. Production ALWAYS runs the §15.4 spec windows (the
 * shared `DEBATE_EDIT_WINDOW_MS`/`DEBATE_OVERRIDE_WINDOW_MS` constants — the
 * defaults when this is absent); the override exists so the DEV traffic
 * simulator (and tests) can drive the full correction → adjudication →
 * finalize lifecycle on an observable cadence instead of 12h + 24h. Nothing in
 * production wiring ever sets it.
 */
export interface DebateWindowPolicy {
  editWindowMs: number;
  overrideWindowMs: number;
}

export interface DebateDeps {
  debates: DebateStore;
  contributions: ContributionStore;
  storyAuthor: StoryAuthorReader;
  isSteward: StewardReader;
  setStoryDispute: StoryDisputeSetter;
  runJudge: DebateJudgeRunner;
  /** Fan-out a live arena frame (co-visible drafts / verdict / resolution). */
  broadcast?: (debateId: string, arena: DebateArenaPublic) => void;
  /** Window-length override (dev simulator / tests ONLY; absent ⇒ the §15.4
   *  spec constants). */
  windows?: DebateWindowPolicy | undefined;
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
  const editDeadlineAt = new Date(
    nowMs + (deps.windows?.editWindowMs ?? DEBATE_EDIT_WINDOW_MS),
  ).toISOString();
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
      // The challenger's opening position IS the correction (body + sources).
      challenger: {
        summary: correction.body,
        citations: [...correction.citations],
        updatedAt: nowIso,
      },
      incumbent: { summary: '', citations: [], updatedAt: null },
    },
    editDeadlineAt,
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
// Post / edit a position (the 12h co-visible window).
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
  // The 12h edit window: rejected once the deadline passes (or past `open`).
  if (arena.state !== 'open' || new Date(deps.now()).toISOString() > arena.editDeadlineAt) {
    return { ok: false, reason: 'window_closed' };
  }
  const position: DebateSidePosition = {
    summary: update.summary,
    citations: [...update.citations],
    updatedAt: new Date(deps.now()).toISOString(),
  };
  const updated = await deps.debates.updatePosition(debateId, side, position);
  if (updated === null) return { ok: false, reason: 'not_found' };
  await broadcastArena(deps, updated);
  return { ok: true, arena: updated };
}

// ---------------------------------------------------------------------------
// Judge (the edit window has closed).
// ---------------------------------------------------------------------------

/**
 * Run the governed adjudicator over an arena whose edit window has closed, record
 * the verdict, and open the 24h steward-override window.  Fail-closed: a blocked/
 * unavailable judge resolves to `inconclusive` (nothing tagged).  Idempotent —
 * a no-op unless the arena is `open`/`awaiting_verdict`.
 */
export async function judgeDebateArena(
  deps: DebateDeps,
  debateId: string,
): Promise<DebateArenaRecord | null> {
  const arena = await deps.debates.getById(debateId);
  if (arena === null) return null;
  if (arena.state !== 'open' && arena.state !== 'awaiting_verdict') return arena;

  const input = assembleJudgeInput(arena);
  const result = await deps.runJudge(debateId, input);
  const nowMs = deps.now();
  const verdictAt = new Date(nowMs).toISOString();
  const overrideDeadlineAt = new Date(
    nowMs + (deps.windows?.overrideWindowMs ?? DEBATE_OVERRIDE_WINDOW_MS),
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

/**
 * One debate-lifecycle sweep: judge every arena whose 12h edit window has closed,
 * then finalize every arena whose 24h override window has closed.  Bounded per
 * tick; idempotent (each stage no-ops on an already-advanced arena).
 */
export async function runDebateLifecycle(
  deps: DebateDeps,
  limit = 100,
): Promise<{ judged: number; finalized: number }> {
  const nowIso = new Date(deps.now()).toISOString();
  let judged = 0;
  let finalized = 0;
  for (const arena of await deps.debates.listPastEditDeadline(nowIso, limit)) {
    const result = await judgeDebateArena(deps, arena.debateId);
    if (result?.state === 'judged') judged += 1;
  }
  for (const arena of await deps.debates.listPastOverrideDeadline(nowIso, limit)) {
    const result = await finalizeDebate(deps, arena.debateId);
    if (result?.state === 'resolved') finalized += 1;
  }
  return { judged, finalized };
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

function toJudgeSide(position: DebateSidePosition): DebateJudgeSideInput {
  return {
    summary: position.summary,
    sources: position.citations.map((c) => ({
      url: c.url,
      domain: domainOf(c.url),
      // The citation schema already rejects dangerous schemes; an http(s) URL is
      // treated as link-safe here (the WS-F reliability signal is null = unknown
      // until the source-profile reader is wired).
      link_safe: /^https?:\/\//i.test(c.url),
      reliability: null,
    })),
    // Posting a substantive position is treated as engaging/rebutting the opponent.
    rebuts_opponent: position.summary.trim().length > 0,
  };
}

/** Build the content-structural adjudicator input from the two positions. */
export function assembleJudgeInput(arena: DebateArenaRecord): DebateJudgeInput {
  return {
    incumbent: toJudgeSide(arena.positions.incumbent),
    challenger: toJudgeSide(arena.positions.challenger),
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

/** Project an arena record to its public wire shape for `viewerUserId`. */
export async function toDebateArenaPublic(
  arena: DebateArenaRecord,
  viewerUserId: string | null,
  resolveAuthor: DebateAuthorResolver,
  viewerIsSteward: boolean,
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
    edit_deadline_at: arena.editDeadlineAt,
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
  const projected = await toDebateArenaPublic(arena, null, async () => null, false);
  deps.broadcast(arena.debateId, projected);
}
