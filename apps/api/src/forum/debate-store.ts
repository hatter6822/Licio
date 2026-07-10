// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate arena store (SPEC §15.4/§24.6).  Holds one arena per sourced-
// correction challenge: the two co-visible position drafts, the 12h edit
// deadline, the AI verdict, and the 24h steward-override window.  Follows the
// WS-G house pattern — the service depends on this interface; production boot
// swaps in the Drizzle adapter (drizzle over migration 0056).  The in-memory
// adapter is semantically faithful (one non-resolved arena per target).
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
  editDeadlineAt: string;
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

export interface DebateStore {
  /** Insert a new arena.  Returns null if a non-resolved arena already exists
   *  for the same target (the one-open-per-target invariant). */
  open(
    record: Omit<DebateArenaRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<DebateArenaRecord | null>;
  getById(debateId: string): Promise<DebateArenaRecord | null>;
  /** The active (non-resolved) arena challenging a comment, if any. */
  getActiveForComment(contributionId: string): Promise<DebateArenaRecord | null>;
  /** The active (non-resolved) arena challenging a story, if any. */
  getActiveForStory(storyId: string): Promise<DebateArenaRecord | null>;
  /** Write one side's draft (12h-window enforcement is the service's job). */
  updatePosition(
    debateId: string,
    side: 'incumbent' | 'challenger',
    position: DebateSidePosition,
  ): Promise<DebateArenaRecord | null>;
  /** Record the adjudicator's verdict. STATE-CONDITIONAL: applies only while
   *  the arena is `open`/`awaiting_verdict` — a stale concurrent judge (e.g. a
   *  scheduler tick that outlived its lease) gets null and never clobbers a
   *  recorded verdict or a steward override. */
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
  /** Open arenas whose edit window has closed (scheduler → judge). */
  listPastEditDeadline(nowIso: string, limit: number): Promise<DebateArenaRecord[]>;
  /** Judged arenas whose override window has closed (scheduler → finalize). */
  listPastOverrideDeadline(nowIso: string, limit: number): Promise<DebateArenaRecord[]>;
  /** Map contribution id → active debate id (for the comment projection). */
  activeDebateIdsForContributions(ids: readonly string[]): Promise<Map<string, string>>;
  /** Count active arenas for a story's threads (the overview `debates_count`). */
  countActiveForStory(storyId: string): Promise<number>;
  /** Active (non-resolved) arenas for a story — comment- AND story-target —
   *  ordered by their edit deadline (soonest first): the story-level "active
   *  debates" discovery list.  Bounded by `limit`. */
  listActiveForStory(storyId: string, limit: number): Promise<DebateArenaRecord[]>;
  clear(): Promise<void>;
}

const NON_RESOLVED: ReadonlySet<DebateState> = new Set<DebateState>([
  'open',
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
    if (row.state !== 'open' && row.state !== 'awaiting_verdict') return null;
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

  async listPastEditDeadline(nowIso: string, limit: number): Promise<DebateArenaRecord[]> {
    return [...this.#rows.values()]
      .filter((row) => row.state === 'open' && row.editDeadlineAt <= nowIso)
      .sort((a, b) => a.editDeadlineAt.localeCompare(b.editDeadlineAt))
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

  async listActiveForStory(storyId: string, limit: number): Promise<DebateArenaRecord[]> {
    const rows: DebateArenaRecord[] = [];
    for (const row of this.#rows.values()) {
      if (row.storyId === storyId && NON_RESOLVED.has(row.state)) rows.push(row);
    }
    rows.sort((a, b) => Date.parse(a.editDeadlineAt) - Date.parse(b.editDeadlineAt));
    return rows.slice(0, Math.max(0, limit));
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}
