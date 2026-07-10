// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T production Postgres adapter for the debate arena store (SPEC §15.4/§24.6),
// behind the SAME `DebateStore` interface as the in-memory adapter — the
// WS-G/WS-R house pattern.  Gated integration tests (DATABASE_URL) run this
// against the real migration chain (0056); the semantics mirror
// InMemoryDebateStore exactly:
//
//   • `open` relies on the two partial unique indexes (one non-resolved arena
//     per comment / story target); a 23505 resolves to `null`;
//   • `updatePosition` uses `jsonb_set` so a side's edit never clobbers the
//     OTHER side's concurrent draft (co-visible editing is concurrent);
//   • the deadline sweeps read the `(state, *_deadline_at)` indexes.
import type { DbExecutor } from '@licio/db';
import { debateArenas as debateArenasTable } from '@licio/db';
import type { Citation, DebateState } from '@licio/shared';
import { and, asc, count, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import type {
  DebateArenaRecord,
  DebateSidePosition,
  DebateStore,
  DebateVerdictPatch,
} from './debate-store.js';

type Db = DbExecutor;

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const NON_RESOLVED: readonly DebateState[] = ['open', 'awaiting_verdict', 'judged'];

export class DrizzleDebateStore implements DebateStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof debateArenasTable.$inferSelect): DebateArenaRecord {
    const positions = row.positions;
    return {
      debateId: row.debateId,
      storyId: row.storyId,
      threadId: row.threadId,
      roomId: row.roomId,
      targetType: row.targetType,
      targetContributionId: row.targetContributionId,
      challengerContributionId: row.challengerContributionId,
      incumbentUserId: row.incumbentUserId,
      challengerUserId: row.challengerUserId,
      state: row.state,
      positions: {
        incumbent: {
          summary: positions.incumbent.summary,
          citations: positions.incumbent.citations as Citation[],
          updatedAt: positions.incumbent.updatedAt,
        },
        challenger: {
          summary: positions.challenger.summary,
          citations: positions.challenger.citations as Citation[],
          updatedAt: positions.challenger.updatedAt,
        },
      },
      editDeadlineAt: iso(row.editDeadlineAt),
      verdict: row.verdict,
      winner: row.winner,
      decidedBy: row.decidedBy,
      rationale: row.rationale,
      confidence: row.confidence,
      aiOutputId: row.aiOutputId,
      verdictAt: isoOrNull(row.verdictAt),
      overrideDeadlineAt: isoOrNull(row.overrideDeadlineAt),
      overriddenByUserId: row.overriddenByUserId,
      overrideReason: row.overrideReason,
      resolvedAt: isoOrNull(row.resolvedAt),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async open(
    record: Omit<DebateArenaRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<DebateArenaRecord | null> {
    try {
      const now = new Date();
      const rows = await this.#db
        .insert(debateArenasTable)
        .values({
          debateId: record.debateId,
          storyId: record.storyId,
          threadId: record.threadId,
          roomId: record.roomId,
          targetType: record.targetType,
          targetContributionId: record.targetContributionId,
          challengerContributionId: record.challengerContributionId,
          incumbentUserId: record.incumbentUserId,
          challengerUserId: record.challengerUserId,
          state: record.state,
          positions: record.positions,
          editDeadlineAt: new Date(record.editDeadlineAt),
          verdict: record.verdict,
          winner: record.winner,
          decidedBy: record.decidedBy,
          rationale: record.rationale,
          confidence: record.confidence,
          aiOutputId: record.aiOutputId,
          verdictAt: record.verdictAt === null ? null : new Date(record.verdictAt),
          overrideDeadlineAt:
            record.overrideDeadlineAt === null ? null : new Date(record.overrideDeadlineAt),
          overriddenByUserId: record.overriddenByUserId,
          overrideReason: record.overrideReason,
          resolvedAt: record.resolvedAt === null ? null : new Date(record.resolvedAt),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return rows[0] ? this.#toRecord(rows[0]) : null;
    } catch (error) {
      // The partial unique indexes enforce one non-resolved arena per target.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async getById(debateId: string): Promise<DebateArenaRecord | null> {
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(eq(debateArenasTable.debateId, debateId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async getActiveForComment(contributionId: string): Promise<DebateArenaRecord | null> {
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.targetType, 'comment'),
          eq(debateArenasTable.targetContributionId, contributionId),
          inArray(debateArenasTable.state, [...NON_RESOLVED]),
        ),
      )
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async getActiveForStory(storyId: string): Promise<DebateArenaRecord | null> {
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.targetType, 'story'),
          eq(debateArenasTable.storyId, storyId),
          inArray(debateArenasTable.state, [...NON_RESOLVED]),
        ),
      )
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async updatePosition(
    debateId: string,
    side: 'incumbent' | 'challenger',
    position: DebateSidePosition,
  ): Promise<DebateArenaRecord | null> {
    // jsonb_set ONLY the edited side, so it can never clobber the other side's
    // concurrent draft (co-visible editing is concurrent by design).  The
    // `state = 'open'` guard makes the write ATOMIC against the scheduler: if the
    // lifecycle tick judged the arena between `postDebatePosition`'s pre-read and
    // this write, no row matches and the stale position is dropped (never mutating
    // an already-judged arena's positions out from under its recorded verdict).
    const rows = await this.#db
      .update(debateArenasTable)
      .set({
        positions: sql`jsonb_set(${debateArenasTable.positions}, ${`{${side}}`}, ${JSON.stringify(position)}::jsonb, true)`,
        updatedAt: new Date(),
      })
      .where(and(eq(debateArenasTable.debateId, debateId), eq(debateArenasTable.state, 'open')))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async claimForVerdict(debateId: string): Promise<DebateArenaRecord | null> {
    // Atomic claim: only an open/awaiting arena flips; the RETURNING row is
    // the post-claim position snapshot the judge scores (position writes are
    // rejected from this instant by updatePosition's `state = 'open'` guard).
    const rows = await this.#db
      .update(debateArenasTable)
      .set({ state: 'awaiting_verdict', updatedAt: new Date() })
      .where(
        and(
          eq(debateArenasTable.debateId, debateId),
          inArray(debateArenasTable.state, ['open', 'awaiting_verdict']),
        ),
      )
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async recordVerdict(
    debateId: string,
    patch: DebateVerdictPatch,
  ): Promise<DebateArenaRecord | null> {
    const rows = await this.#db
      .update(debateArenasTable)
      .set({
        verdict: patch.verdict,
        winner: patch.winner,
        decidedBy: patch.decidedBy,
        rationale: patch.rationale,
        confidence: patch.confidence,
        aiOutputId: patch.aiOutputId,
        verdictAt: new Date(patch.verdictAt),
        overrideDeadlineAt: new Date(patch.overrideDeadlineAt),
        state: patch.state,
        updatedAt: new Date(),
      })
      // STATE-CONDITIONAL (the store-level CAS, mirroring the in-memory
      // adapter): a stale lease holder's verdict must never clobber an
      // already-judged arena or a steward override. The loser matches no row
      // and gets null (no-op).
      .where(
        and(
          eq(debateArenasTable.debateId, debateId),
          inArray(debateArenasTable.state, ['open', 'awaiting_verdict']),
        ),
      )
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async recordOverride(
    debateId: string,
    override: {
      verdict: DebateVerdictPatch['verdict'];
      winner: DebateVerdictPatch['winner'];
      overriddenByUserId: string;
      overrideReason: string;
    },
  ): Promise<DebateArenaRecord | null> {
    const rows = await this.#db
      .update(debateArenasTable)
      .set({
        verdict: override.verdict,
        winner: override.winner,
        decidedBy: 'steward',
        overriddenByUserId: override.overriddenByUserId,
        overrideReason: override.overrideReason,
        updatedAt: new Date(),
      })
      .where(eq(debateArenasTable.debateId, debateId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async setState(
    debateId: string,
    state: DebateState,
    resolvedAt?: string,
  ): Promise<DebateArenaRecord | null> {
    const rows = await this.#db
      .update(debateArenasTable)
      .set({
        state,
        ...(resolvedAt !== undefined ? { resolvedAt: new Date(resolvedAt) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(debateArenasTable.debateId, debateId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async listPastEditDeadline(nowIso: string, limit: number): Promise<DebateArenaRecord[]> {
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(
        and(
          // `awaiting_verdict` included: a claim whose judge crashed mid-flight
          // must be re-listed on a later tick, never stranded.
          inArray(debateArenasTable.state, ['open', 'awaiting_verdict']),
          lte(debateArenasTable.editDeadlineAt, new Date(nowIso)),
        ),
      )
      .orderBy(asc(debateArenasTable.editDeadlineAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listPastOverrideDeadline(nowIso: string, limit: number): Promise<DebateArenaRecord[]> {
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.state, 'judged'),
          lte(debateArenasTable.overrideDeadlineAt, new Date(nowIso)),
        ),
      )
      .orderBy(asc(debateArenasTable.overrideDeadlineAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async activeDebateIdsForContributions(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const rows = await this.#db
      .select({
        targetContributionId: debateArenasTable.targetContributionId,
        debateId: debateArenasTable.debateId,
      })
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.targetType, 'comment'),
          inArray(debateArenasTable.targetContributionId, [...ids]),
          inArray(debateArenasTable.state, [...NON_RESOLVED]),
        ),
      );
    for (const row of rows) {
      if (row.targetContributionId !== null) out.set(row.targetContributionId, row.debateId);
    }
    return out;
  }

  async countActiveForStory(storyId: string): Promise<number> {
    const rows = await this.#db
      .select({ value: count() })
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.storyId, storyId),
          inArray(debateArenasTable.state, [...NON_RESOLVED]),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  async listActiveForStory(storyId: string, limit: number): Promise<DebateArenaRecord[]> {
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.storyId, storyId),
          inArray(debateArenasTable.state, [...NON_RESOLVED]),
        ),
      )
      .orderBy(asc(debateArenasTable.editDeadlineAt))
      .limit(Math.max(0, limit));
    return rows.map((row) => this.#toRecord(row));
  }

  async clear(): Promise<void> {
    await this.#db.delete(debateArenasTable).where(ne(debateArenasTable.debateId, ''));
  }
}
