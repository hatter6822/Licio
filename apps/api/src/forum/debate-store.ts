// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate arena store (SPEC §15.4/§24.6).  Holds one arena per sourced-
// correction challenge: the two co-visible rebuttal drafts, the 23h edit
// deadline, the hour-23 locked snapshot, the 24h resolve-due instant (the AI
// resolution queue), the verdict, and the 24h steward-override window.
// Follows the WS-G house pattern — the service depends on this interface;
// production boot swaps in the Drizzle adapter (drizzle over migrations
// 0056/0078/0079).  The in-memory adapter is semantically faithful (one live
// arena per target).
import type {
  Citation,
  DebateDecider,
  DebateState,
  DebateVerdict,
  DebateWinner,
} from '@licio/shared';

/** One side's live, editable draft. */
export interface DebateSidePosition {
  summary: string;
  citations: Citation[];
  /** ISO instant of the side's last post; null until it first posts. */
  updatedAt: string | null;
}

/** One side's hour-23 locked underlying-content snapshot. */
export interface DebateLockedSide {
  /** Story title for a story target; null for comment/correction content. */
  title: string | null;
  /** The comment/correction body or the story excerpt at lock time. */
  body: string;
  citations: Citation[];
  /** ISO instant of the content's last edit before the lock; null if never. */
  updatedAt: string | null;
}

/** The hour-23 snapshot of the material under debate (what the AI resolution
 *  queue judges); null while the arena is still `open`. */
export interface DebateLockedContent {
  target: DebateLockedSide;
  correction: DebateLockedSide;
}

export interface DebateArenaRecord {
  debateId: string;
  storyId: string;
  threadId: string | null;
  roomId: string | null;
  targetType: 'comment' | 'story';
  /** The challenged comment; null for a story target. */
  targetContributionId: string | null;
  /** The correction contribution that opened the arena. */
  challengerContributionId: string;
  incumbentUserId: string | null;
  challengerUserId: string | null;
  state: DebateState;
  positions: { incumbent: DebateSidePosition; challenger: DebateSidePosition };
  /** The outer edit deadline (open + 23h); edits/withdrawal/concession are
   *  rejected after this instant even in a continuously active debate. */
  editDeadlineAt: string;
  /** When the debate enters the AI resolution queue: open + 24h scheduled,
   *  pulled EARLIER to the lock instant on the both-sides-idle path. */
  resolveDueAt: string;
  /** The instant the material was locked in; null while still `open`. */
  lockedAt: string | null;
  /** The locked snapshot of both sides' underlying content. */
  lockedContent: DebateLockedContent | null;
  /** Each side's last edit (underlying content or rebuttal).  Once BOTH are
   *  older than the inactivity window, the arena locks + queues early. */
  incumbentLastActiveAt: string;
  challengerLastActiveAt: string;
  verdict: DebateVerdict | null;
  winner: DebateWinner | null;
  decidedBy: DebateDecider | null;
  rationale: string | null;
  confidence: number | null;
  aiOutputId: string | null;
  verdictAt: string | null;
  overrideDeadlineAt: string | null;
  overriddenByUserId: string | null;
  overrideReason: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The verdict fields the AI (or a steward) writes onto an arena. */
export interface DebateVerdictPatch {
  verdict: DebateVerdict;
  winner: DebateWinner;
  decidedBy: DebateDecider;
  rationale: string | null;
  confidence: number | null;
  aiOutputId: string | null;
  verdictAt: string;
  overrideDeadlineAt: string;
  state: DebateState;
}

/** The concession outcome patch (the incumbent conceded during `open`). */
export interface DebateConcessionPatch {
  verdict: DebateVerdict;
  winner: DebateWinner;
  decidedBy: DebateDecider;
  rationale: string;
  verdictAt: string;
  resolvedAt: string;
}

/** One arena's exit in an ALL-OR-NOTHING removal close (`closeForRemoval`). */
export type DebateRemovalClosure =
  | { debateId: string; kind: 'withdraw'; closedAt: string }
  | { debateId: string; kind: 'concede'; patch: DebateConcessionPatch };

export interface DebateStore {
  /** Insert a new arena.  Returns null if a live (non-terminal) arena already
   *  exists for the same target (the one-live-per-target invariant). */
  open(
    record: Omit<DebateArenaRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<DebateArenaRecord | null>;
  getById(debateId: string): Promise<DebateArenaRecord | null>;
  /** The live (non-terminal) arena challenging a comment, if any. */
  getActiveForComment(contributionId: string): Promise<DebateArenaRecord | null>;
  /** The live (non-terminal) arena challenging a story, if any. */
  getActiveForStory(storyId: string): Promise<DebateArenaRecord | null>;
  /** The live (non-terminal) arena OPENED BY a correction contribution, if
   *  any (the challenger-side lookup: activity touches + edit/remove gates). */
  getActiveForCorrection(contributionId: string): Promise<DebateArenaRecord | null>;
  /** Write one side's rebuttal draft (window enforcement is the service's
   *  job).  Also resets that side's activity clock — a rebuttal edit counts
   *  against the both-sides-idle expedited path. */
  updatePosition(
    debateId: string,
    side: 'incumbent' | 'challenger',
    position: DebateSidePosition,
  ): Promise<DebateArenaRecord | null>;
  /** Reset one side's activity clock (an edit to the side's UNDERLYING
   *  content — the correction or the challenged comment/story).  Only an
   *  `open` arena is touched (post-lock edits are refused upstream anyway). */
  touchActivity(
    debateId: string,
    side: 'incumbent' | 'challenger',
    at: string,
  ): Promise<DebateArenaRecord | null>;
  /** ATOMICALLY lock an arena (`open` → `locked`), stamping the underlying-
   *  content snapshot the AI resolution queue will judge.  From this instant
   *  the store-level `state = 'open'` guards on position writes, withdrawal,
   *  and concession reject every further change — the material is locked in.
   *  `resolveDueAt`, when given, pulls the queue-entry instant forward (the
   *  both-sides-idle expedited path).  A non-`open` arena returns null
   *  (idempotent no-op). */
  lock(
    debateId: string,
    lockedAt: string,
    content: DebateLockedContent,
    resolveDueAt?: string,
  ): Promise<DebateArenaRecord | null>;
  /** ATOMICALLY replace a still-`locked` arena's content snapshot (CAS on
   *  `state = 'locked'`).  The reconcile seam for an underlying-content edit
   *  that raced the lock: the persisted edit re-enters the snapshot BEFORE the
   *  queue claims it, so the judge never scores content the live row no longer
   *  shows.  A claimed/terminal arena returns null (too late to reconcile —
   *  the caller reverts the edit instead). */
  refreshLockedContent(
    debateId: string,
    content: DebateLockedContent,
  ): Promise<DebateArenaRecord | null>;
  /** ATOMICALLY fill a MISSING snapshot on an already-claimed arena (CAS on
   *  `state = 'awaiting_verdict' AND lockedContent IS NULL`).  The judge-time
   *  catch-up for an arena claimed WITHOUT ever locking — a pre-live-window
   *  legacy row or a crash-recovered claim — so re-judging never scores empty
   *  sides.  Deliberately DISTINCT from `refreshLockedContent`: a snapshot
   *  that already exists is frozen for the judge and is never replaced here. */
  backfillLockedContent(
    debateId: string,
    lockedAt: string,
    content: DebateLockedContent,
  ): Promise<DebateArenaRecord | null>;
  /** ATOMICALLY close an `open` arena as `withdrawn` (the challenger retracted
   *  the correction) — terminal, no verdict.  Non-`open` returns null (a
   *  withdrawal racing the hour-23 lock loses: the material was locked in). */
  withdraw(debateId: string, closedAt: string): Promise<DebateArenaRecord | null>;
  /** ATOMICALLY close an `open` arena as `resolved` with the concession
   *  outcome (the incumbent conceded; the challenger prevails without
   *  adjudication).  Non-`open` returns null (same lock-race rule). */
  concede(debateId: string, patch: DebateConcessionPatch): Promise<DebateArenaRecord | null>;
  /** ALL-OR-NOTHING close of every arena a removed contribution is party to
   *  (a correction can be challenger of one arena AND incumbent of another):
   *  every arena must still be `open`, else NOTHING mutates and null returns
   *  — a removal must never withdraw one arena and then fail on a second
   *  that locked concurrently.  Returns the closed rows in input order. */
  closeForRemoval(closures: readonly DebateRemovalClosure[]): Promise<DebateArenaRecord[] | null>;
  /** ATOMICALLY claim an arena for adjudication (`open`/`locked`/
   *  `awaiting_verdict` → `awaiting_verdict`), returning the post-claim row —
   *  the EXACT snapshot the judge must score.  `open` is accepted for
   *  catch-up (a lock sweep that never ran past both deadlines); re-claiming
   *  an `awaiting_verdict` arena succeeds (crash recovery: a claim whose
   *  judge never returned is re-judgeable on a later tick).  A judged/
   *  terminal arena returns null. */
  claimForVerdict(debateId: string): Promise<DebateArenaRecord | null>;
  /** Record the adjudicator's verdict. STATE-CONDITIONAL: applies only while
   *  the arena is `open`/`locked`/`awaiting_verdict` — a stale concurrent
   *  judge (e.g. a scheduler tick that outlived its lease) gets null and
   *  never clobbers a recorded verdict or a steward override. */
  recordVerdict(debateId: string, patch: DebateVerdictPatch): Promise<DebateArenaRecord | null>;
  /** A steward override re-decides the outcome in place (state stays `judged`). */
  recordOverride(
    debateId: string,
    override: {
      verdict: DebateVerdict;
      winner: DebateWinner;
      overriddenByUserId: string;
      overrideReason: string;
    },
  ): Promise<DebateArenaRecord | null>;
  setState(
    debateId: string,
    state: DebateState,
    resolvedAt?: string,
  ): Promise<DebateArenaRecord | null>;
  /** Arenas due for the scheduled hour-23 lock: still `open` past their edit
   *  deadline. */
  listDueForLock(nowIso: string, limit: number): Promise<DebateArenaRecord[]>;
  /** Arenas due for the AI resolution queue: past their resolve-due instant
   *  and still `locked` (the scheduled path), `open` (lock-sweep catch-up),
   *  or `awaiting_verdict` (a claim whose judge crashed mid-flight must be
   *  re-listed, never stranded). */
  listPastResolveDeadline(nowIso: string, limit: number): Promise<DebateArenaRecord[]>;
  /** Arenas due for the EXPEDITED path: still `open` with BOTH sides' last
   *  activity at or before `idleSinceIso` (= now − the inactivity window).
   *  The lifecycle locks these at their idle instant and queues them
   *  immediately. */
  listIdleSince(idleSinceIso: string, limit: number): Promise<DebateArenaRecord[]>;
  /** Judged arenas whose override window has closed (scheduler → finalize). */
  listPastOverrideDeadline(nowIso: string, limit: number): Promise<DebateArenaRecord[]>;
  /** Map contribution id → active debate id (for the comment projection). */
  activeDebateIdsForContributions(ids: readonly string[]): Promise<Map<string, string>>;
  /** Count active arenas for a story's threads (the overview `debates_count`). */
  countActiveForStory(storyId: string): Promise<number>;
  /** Batched story-card signal: live (non-terminal) COMMENT-target arenas per
   *  story — one read per feed page.  Story-target arenas are excluded by
   *  design: the story's own live challenge is already carried by its
   *  `dispute_status` (`under_debate`), so the card tally never double-reports
   *  one debate.  Stories with no live comment arenas are absent from the map. */
  countActiveCommentArenas(storyIds: readonly string[]): Promise<Map<string, number>>;
  /** Live (non-terminal) arenas for a story — comment- AND story-target —
   *  ordered by their edit deadline (soonest first): the story-level "active
   *  debates" discovery list.  Bounded by `limit`. */
  listActiveForStory(storyId: string, limit: number): Promise<DebateArenaRecord[]>;
  /** DEV/TEST seam (the simulator's fast-forward control): shift an arena's
   *  deadlines so the lifecycle sweeps pick it up immediately.  Production
   *  never calls this. */
  shiftDeadlines(
    debateId: string,
    patch: { editDeadlineAt?: string; resolveDueAt?: string; overrideDeadlineAt?: string },
  ): Promise<DebateArenaRecord | null>;
  clear(): Promise<void>;
}

const NON_RESOLVED: ReadonlySet<DebateState> = new Set<DebateState>([
  'open',
  'locked',
  'awaiting_verdict',
  'judged',
]);

type Clock = () => number;

export class InMemoryDebateStore implements DebateStore {
  readonly #rows = new Map<string, DebateArenaRecord>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  async open(
    record: Omit<DebateArenaRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<DebateArenaRecord | null> {
    // One non-resolved arena per target.
    for (const existing of this.#rows.values()) {
      if (!NON_RESOLVED.has(existing.state)) continue;
      if (
        record.targetType === 'comment' &&
        existing.targetType === 'comment' &&
        existing.targetContributionId === record.targetContributionId
      ) {
        return null;
      }
      if (
        record.targetType === 'story' &&
        existing.targetType === 'story' &&
        existing.storyId === record.storyId
      ) {
        return null;
      }
    }
    const at = this.#iso();
    const full: DebateArenaRecord = {
      ...record,
      positions: {
        incumbent: {
          ...record.positions.incumbent,
          citations: [...record.positions.incumbent.citations],
        },
        challenger: {
          ...record.positions.challenger,
          citations: [...record.positions.challenger.citations],
        },
      },
      createdAt: at,
      updatedAt: at,
    };
    this.#rows.set(full.debateId, full);
    return full;
  }

  async getById(debateId: string): Promise<DebateArenaRecord | null> {
    return this.#rows.get(debateId) ?? null;
  }

  async getActiveForComment(contributionId: string): Promise<DebateArenaRecord | null> {
    for (const row of this.#rows.values()) {
      if (
        row.targetType === 'comment' &&
        row.targetContributionId === contributionId &&
        NON_RESOLVED.has(row.state)
      ) {
        return row;
      }
    }
    return null;
  }

  async getActiveForStory(storyId: string): Promise<DebateArenaRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.targetType === 'story' && row.storyId === storyId && NON_RESOLVED.has(row.state)) {
        return row;
      }
    }
    return null;
  }

  async getActiveForCorrection(contributionId: string): Promise<DebateArenaRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.challengerContributionId === contributionId && NON_RESOLVED.has(row.state)) {
        return row;
      }
    }
    return null;
  }

  async updatePosition(
    debateId: string,
    side: 'incumbent' | 'challenger',
    position: DebateSidePosition,
  ): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    // Mirror the Drizzle adapter's atomic `state = 'open'` guard: a position may
    // only be written while the arena is still open, so a write that races the
    // judge tick can never mutate an already-judged arena's positions.
    if (row.state !== 'open') return null;
    row.positions[side] = { ...position, citations: [...position.citations] };
    // A rebuttal edit is side activity (the both-sides-idle expedited path).
    const at = position.updatedAt ?? this.#iso();
    if (side === 'incumbent') row.incumbentLastActiveAt = at;
    else row.challengerLastActiveAt = at;
    row.updatedAt = this.#iso();
    return row;
  }

  async touchActivity(
    debateId: string,
    side: 'incumbent' | 'challenger',
    at: string,
  ): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    if (row.state !== 'open') return null;
    if (side === 'incumbent') row.incumbentLastActiveAt = at;
    else row.challengerLastActiveAt = at;
    row.updatedAt = this.#iso();
    return row;
  }

  async lock(
    debateId: string,
    lockedAt: string,
    content: DebateLockedContent,
    resolveDueAt?: string,
  ): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    // CAS: only an `open` arena locks (idempotent no-op on a later state).
    if (row.state !== 'open') return null;
    row.state = 'locked';
    row.lockedAt = lockedAt;
    if (resolveDueAt !== undefined) row.resolveDueAt = resolveDueAt;
    row.lockedContent = {
      target: { ...content.target, citations: [...content.target.citations] },
      correction: { ...content.correction, citations: [...content.correction.citations] },
    };
    row.updatedAt = this.#iso();
    return row;
  }

  async refreshLockedContent(
    debateId: string,
    content: DebateLockedContent,
  ): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    // CAS: only a still-locked (unclaimed) arena's snapshot may be replaced.
    if (row.state !== 'locked') return null;
    row.lockedContent = {
      target: { ...content.target, citations: [...content.target.citations] },
      correction: { ...content.correction, citations: [...content.correction.citations] },
    };
    row.updatedAt = this.#iso();
    return row;
  }

  async backfillLockedContent(
    debateId: string,
    lockedAt: string,
    content: DebateLockedContent,
  ): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    // CAS: fill only a MISSING snapshot on a claimed arena — an existing
    // snapshot is frozen for the judge.
    if (row.state !== 'awaiting_verdict' || row.lockedContent !== null) return null;
    row.lockedAt = lockedAt;
    row.lockedContent = {
      target: { ...content.target, citations: [...content.target.citations] },
      correction: { ...content.correction, citations: [...content.correction.citations] },
    };
    row.updatedAt = this.#iso();
    return row;
  }

  async withdraw(debateId: string, closedAt: string): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    // CAS: a withdrawal racing the hour-23 lock loses (the material locked in).
    if (row.state !== 'open') return null;
    row.state = 'withdrawn';
    row.resolvedAt = closedAt;
    row.updatedAt = this.#iso();
    return row;
  }

  async concede(debateId: string, patch: DebateConcessionPatch): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    // CAS: a concession racing the hour-23 lock loses (the material locked in).
    if (row.state !== 'open') return null;
    row.state = 'resolved';
    row.verdict = patch.verdict;
    row.winner = patch.winner;
    row.decidedBy = patch.decidedBy;
    row.rationale = patch.rationale;
    row.verdictAt = patch.verdictAt;
    row.resolvedAt = patch.resolvedAt;
    row.updatedAt = this.#iso();
    return row;
  }

  async closeForRemoval(
    closures: readonly DebateRemovalClosure[],
  ): Promise<DebateArenaRecord[] | null> {
    // Check-all-then-mutate with NO awaits in between: on the single-threaded
    // event loop this is atomic — either every arena closes or none does.
    const rows: DebateArenaRecord[] = [];
    for (const closure of closures) {
      const row = this.#rows.get(closure.debateId);
      if (row?.state !== 'open') return null;
      rows.push(row);
    }
    for (let i = 0; i < closures.length; i += 1) {
      const closure = closures[i] as DebateRemovalClosure;
      const row = rows[i] as DebateArenaRecord;
      if (closure.kind === 'withdraw') {
        row.state = 'withdrawn';
        row.resolvedAt = closure.closedAt;
      } else {
        row.state = 'resolved';
        row.verdict = closure.patch.verdict;
        row.winner = closure.patch.winner;
        row.decidedBy = closure.patch.decidedBy;
        row.rationale = closure.patch.rationale;
        row.verdictAt = closure.patch.verdictAt;
        row.resolvedAt = closure.patch.resolvedAt;
      }
      row.updatedAt = this.#iso();
    }
    return rows;
  }

  async claimForVerdict(debateId: string): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    if (row.state !== 'open' && row.state !== 'locked' && row.state !== 'awaiting_verdict') {
      return null;
    }
    row.state = 'awaiting_verdict';
    row.updatedAt = this.#iso();
    return row;
  }

  async recordVerdict(
    debateId: string,
    patch: DebateVerdictPatch,
  ): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    // STATE-CONDITIONAL (the store-level CAS): a verdict may only land on an
    // arena still awaiting one. Two lease holders can race past the service's
    // read-time state check (a scheduler tick that outlives its lease); the
    // second, stale verdict must NOT clobber the recorded one — nor, worse, a
    // steward override (state stays `judged`). The loser gets null (no-op).
    if (row.state !== 'open' && row.state !== 'locked' && row.state !== 'awaiting_verdict') {
      return null;
    }
    row.verdict = patch.verdict;
    row.winner = patch.winner;
    row.decidedBy = patch.decidedBy;
    row.rationale = patch.rationale;
    row.confidence = patch.confidence;
    row.aiOutputId = patch.aiOutputId;
    row.verdictAt = patch.verdictAt;
    row.overrideDeadlineAt = patch.overrideDeadlineAt;
    row.state = patch.state;
    row.updatedAt = this.#iso();
    return row;
  }

  async recordOverride(
    debateId: string,
    override: {
      verdict: DebateVerdict;
      winner: DebateWinner;
      overriddenByUserId: string;
      overrideReason: string;
    },
  ): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    row.verdict = override.verdict;
    row.winner = override.winner;
    row.decidedBy = 'steward';
    row.overriddenByUserId = override.overriddenByUserId;
    row.overrideReason = override.overrideReason;
    row.updatedAt = this.#iso();
    return row;
  }

  async setState(
    debateId: string,
    state: DebateState,
    resolvedAt?: string,
  ): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    row.state = state;
    if (resolvedAt !== undefined) row.resolvedAt = resolvedAt;
    row.updatedAt = this.#iso();
    return row;
  }

  async listDueForLock(nowIso: string, limit: number): Promise<DebateArenaRecord[]> {
    return [...this.#rows.values()]
      .filter((row) => row.state === 'open' && row.editDeadlineAt <= nowIso)
      .sort((a, b) => a.editDeadlineAt.localeCompare(b.editDeadlineAt))
      .slice(0, limit);
  }

  async listPastResolveDeadline(nowIso: string, limit: number): Promise<DebateArenaRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (row) =>
          (row.state === 'open' || row.state === 'locked' || row.state === 'awaiting_verdict') &&
          row.resolveDueAt <= nowIso,
      )
      .sort((a, b) => a.resolveDueAt.localeCompare(b.resolveDueAt))
      .slice(0, limit);
  }

  async listIdleSince(idleSinceIso: string, limit: number): Promise<DebateArenaRecord[]> {
    const lastActivity = (row: DebateArenaRecord): string =>
      row.incumbentLastActiveAt > row.challengerLastActiveAt
        ? row.incumbentLastActiveAt
        : row.challengerLastActiveAt;
    return [...this.#rows.values()]
      .filter((row) => row.state === 'open' && lastActivity(row) <= idleSinceIso)
      .sort((a, b) => lastActivity(a).localeCompare(lastActivity(b)))
      .slice(0, limit);
  }

  async listPastOverrideDeadline(nowIso: string, limit: number): Promise<DebateArenaRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (row) =>
          row.state === 'judged' &&
          row.overrideDeadlineAt !== null &&
          row.overrideDeadlineAt <= nowIso,
      )
      .sort((a, b) => (a.overrideDeadlineAt ?? '').localeCompare(b.overrideDeadlineAt ?? ''))
      .slice(0, limit);
  }

  async activeDebateIdsForContributions(ids: readonly string[]): Promise<Map<string, string>> {
    const wanted = new Set(ids);
    const out = new Map<string, string>();
    for (const row of this.#rows.values()) {
      if (
        row.targetType === 'comment' &&
        row.targetContributionId !== null &&
        wanted.has(row.targetContributionId) &&
        NON_RESOLVED.has(row.state)
      ) {
        out.set(row.targetContributionId, row.debateId);
      }
    }
    return out;
  }

  async countActiveForStory(storyId: string): Promise<number> {
    let count = 0;
    for (const row of this.#rows.values()) {
      if (row.storyId === storyId && NON_RESOLVED.has(row.state)) count += 1;
    }
    return count;
  }

  async countActiveCommentArenas(storyIds: readonly string[]): Promise<Map<string, number>> {
    const wanted = new Set(storyIds);
    const out = new Map<string, number>();
    for (const row of this.#rows.values()) {
      if (row.targetType !== 'comment' || !wanted.has(row.storyId) || !NON_RESOLVED.has(row.state))
        continue;
      out.set(row.storyId, (out.get(row.storyId) ?? 0) + 1);
    }
    return out;
  }

  async listActiveForStory(storyId: string, limit: number): Promise<DebateArenaRecord[]> {
    const rows: DebateArenaRecord[] = [];
    for (const row of this.#rows.values()) {
      if (row.storyId === storyId && NON_RESOLVED.has(row.state)) rows.push(row);
    }
    rows.sort((a, b) => Date.parse(a.editDeadlineAt) - Date.parse(b.editDeadlineAt));
    return rows.slice(0, Math.max(0, limit));
  }

  async shiftDeadlines(
    debateId: string,
    patch: { editDeadlineAt?: string; resolveDueAt?: string; overrideDeadlineAt?: string },
  ): Promise<DebateArenaRecord | null> {
    const row = this.#rows.get(debateId);
    if (!row) return null;
    if (patch.editDeadlineAt !== undefined) row.editDeadlineAt = patch.editDeadlineAt;
    if (patch.resolveDueAt !== undefined) row.resolveDueAt = patch.resolveDueAt;
    if (patch.overrideDeadlineAt !== undefined) row.overrideDeadlineAt = patch.overrideDeadlineAt;
    row.updatedAt = this.#iso();
    return row;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}
