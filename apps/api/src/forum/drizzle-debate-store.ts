// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T production Postgres adapter for the debate arena store (SPEC §15.4/§24.6),
// behind the SAME `DebateStore` interface as the in-memory adapter — the
// WS-G/WS-R house pattern.  Gated integration tests (DATABASE_URL) run this
// against the real migration chain (0056/0078/0079); the semantics mirror
// InMemoryDebateStore exactly:
//
//   • `open` relies on the two partial unique indexes (one live arena per
//     comment / story target); a 23505 resolves to `null`;
//   • `updatePosition` uses `jsonb_set` so a side's edit never clobbers the
//     OTHER side's concurrent draft (co-visible editing is concurrent);
//   • `lock`/`withdraw`/`concede` are `state = 'open'`-conditional CAS writes
//     (a change racing the lock loses; the material is locked in);
//   • the deadline sweeps read the `(state, *_deadline/_due_at)` indexes and
//     the both-sides-idle sweep reads the partial `greatest(...)` index.
import type { DbExecutor } from '@licio/db';
import { debateArenas as debateArenasTable } from '@licio/db';
import type { Citation, DebateState } from '@licio/shared';
import { and, asc, count, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { isUniqueViolation } from '../lib/pg-errors.js';
import { type ChallengerHistory, isGraceWithdrawal } from './challenge-policy.js';
import {
  type DebateArenaRecord,
  type DebateConcessionPatch,
  type DebateLockedContent,
  type DebateRemovalClosure,
  type DebateSidePosition,
  type DebateStore,
  type DebateVerdictPatch,
  PRE_VERDICT_STATES,
  TOMBSTONED_OPPONENT_KEY,
} from './debate-store.js';

type Db = DbExecutor;

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** Thrown inside the removal-close transaction to trigger a full rollback
 *  when any arena misses its `state = 'open'` CAS. */
class RemovalCloseConflict extends Error {
  constructor() {
    super('removal close conflict');
    this.name = 'RemovalCloseConflict';
  }
}

const NON_RESOLVED: readonly DebateState[] = ['open', 'locked', 'awaiting_verdict', 'judged'];

/** The states a verdict may still land on (the claim/record CAS window). */
const PRE_VERDICT: readonly DebateState[] = ['open', 'locked', 'awaiting_verdict'];

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
      resolveDueAt: iso(row.resolveDueAt),
      lockedAt: isoOrNull(row.lockedAt),
      lockedContent:
        row.lockedContent === null
          ? null
          : {
              target: {
                title: row.lockedContent.target.title,
                body: row.lockedContent.target.body,
                citations: row.lockedContent.target.citations as Citation[],
                updatedAt: row.lockedContent.target.updatedAt,
              },
              correction: {
                title: row.lockedContent.correction.title,
                body: row.lockedContent.correction.body,
                citations: row.lockedContent.correction.citations as Citation[],
                updatedAt: row.lockedContent.correction.updatedAt,
              },
            },
      incumbentLastActiveAt: iso(row.incumbentLastActiveAt),
      challengerLastActiveAt: iso(row.challengerLastActiveAt),
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
          resolveDueAt: new Date(record.resolveDueAt),
          lockedAt: record.lockedAt === null ? null : new Date(record.lockedAt),
          lockedContent: record.lockedContent,
          incumbentLastActiveAt: new Date(record.incumbentLastActiveAt),
          challengerLastActiveAt: new Date(record.challengerLastActiveAt),
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

  async getActiveForCorrection(contributionId: string): Promise<DebateArenaRecord | null> {
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.challengerContributionId, contributionId),
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
    // lifecycle tick locked/judged the arena between `postDebatePosition`'s
    // pre-read and this write, no row matches and the stale position is dropped
    // (never mutating a locked-in arena's positions out from under its verdict).
    // A rebuttal edit is side activity (the both-sides-idle expedited path).
    const activityAt = position.updatedAt === null ? new Date() : new Date(position.updatedAt);
    const rows = await this.#db
      .update(debateArenasTable)
      .set({
        positions: sql`jsonb_set(${debateArenasTable.positions}, ${`{${side}}`}, ${JSON.stringify(position)}::jsonb, true)`,
        ...(side === 'incumbent'
          ? { incumbentLastActiveAt: activityAt }
          : { challengerLastActiveAt: activityAt }),
        updatedAt: new Date(),
      })
      .where(and(eq(debateArenasTable.debateId, debateId), eq(debateArenasTable.state, 'open')))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async touchActivity(
    debateId: string,
    side: 'incumbent' | 'challenger',
    at: string,
  ): Promise<DebateArenaRecord | null> {
    const rows = await this.#db
      .update(debateArenasTable)
      .set({
        ...(side === 'incumbent'
          ? { incumbentLastActiveAt: new Date(at) }
          : { challengerLastActiveAt: new Date(at) }),
        updatedAt: new Date(),
      })
      .where(and(eq(debateArenasTable.debateId, debateId), eq(debateArenasTable.state, 'open')))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async lock(
    debateId: string,
    lockedAt: string,
    content: DebateLockedContent,
    resolveDueAt?: string,
  ): Promise<DebateArenaRecord | null> {
    // CAS: only an `open` arena locks (idempotent no-op on a later state).
    // The optional resolveDueAt pulls the queue-entry instant forward on the
    // both-sides-idle expedited path.
    const rows = await this.#db
      .update(debateArenasTable)
      .set({
        state: 'locked',
        lockedAt: new Date(lockedAt),
        lockedContent: content,
        ...(resolveDueAt !== undefined ? { resolveDueAt: new Date(resolveDueAt) } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(debateArenasTable.debateId, debateId), eq(debateArenasTable.state, 'open')))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async refreshLockedContent(
    debateId: string,
    content: DebateLockedContent,
  ): Promise<DebateArenaRecord | null> {
    // CAS: only a still-locked (unclaimed) arena's snapshot may be replaced —
    // the reconcile seam for an underlying edit that raced the lock.
    const rows = await this.#db
      .update(debateArenasTable)
      .set({ lockedContent: content, updatedAt: new Date() })
      .where(and(eq(debateArenasTable.debateId, debateId), eq(debateArenasTable.state, 'locked')))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async backfillLockedContent(
    debateId: string,
    lockedAt: string,
    content: DebateLockedContent,
  ): Promise<DebateArenaRecord | null> {
    // CAS: fill only a MISSING snapshot on a claimed arena (legacy / crash
    // recovery) — an existing snapshot is frozen for the judge.
    const rows = await this.#db
      .update(debateArenasTable)
      .set({ lockedAt: new Date(lockedAt), lockedContent: content, updatedAt: new Date() })
      .where(
        and(
          eq(debateArenasTable.debateId, debateId),
          eq(debateArenasTable.state, 'awaiting_verdict'),
          isNull(debateArenasTable.lockedContent),
        ),
      )
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async withdraw(debateId: string, closedAt: string): Promise<DebateArenaRecord | null> {
    // CAS: a withdrawal racing the lock loses (the material was locked in).
    const rows = await this.#db
      .update(debateArenasTable)
      .set({ state: 'withdrawn', resolvedAt: new Date(closedAt), updatedAt: new Date() })
      .where(and(eq(debateArenasTable.debateId, debateId), eq(debateArenasTable.state, 'open')))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async concede(debateId: string, patch: DebateConcessionPatch): Promise<DebateArenaRecord | null> {
    // CAS: a concession racing the lock loses (the material was locked in).
    const rows = await this.#db
      .update(debateArenasTable)
      .set({
        state: 'resolved',
        verdict: patch.verdict,
        winner: patch.winner,
        decidedBy: patch.decidedBy,
        rationale: patch.rationale,
        verdictAt: new Date(patch.verdictAt),
        resolvedAt: new Date(patch.resolvedAt),
        updatedAt: new Date(),
      })
      .where(and(eq(debateArenasTable.debateId, debateId), eq(debateArenasTable.state, 'open')))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async closeForRemoval(
    closures: readonly DebateRemovalClosure[],
  ): Promise<DebateArenaRecord[] | null> {
    if (closures.length === 0) return [];
    // ONE transaction over the per-arena `state = 'open'` CAS closes: any
    // arena that locked/closed concurrently misses its CAS and the whole set
    // rolls back — a removal never half-closes its arenas.
    try {
      return await this.#db.transaction(async (tx) => {
        const rows: DebateArenaRecord[] = [];
        for (const closure of closures) {
          const updated =
            closure.kind === 'withdraw'
              ? await tx
                  .update(debateArenasTable)
                  .set({
                    state: 'withdrawn',
                    resolvedAt: new Date(closure.closedAt),
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(debateArenasTable.debateId, closure.debateId),
                      eq(debateArenasTable.state, 'open'),
                    ),
                  )
                  .returning()
              : await tx
                  .update(debateArenasTable)
                  .set({
                    state: 'resolved',
                    verdict: closure.patch.verdict,
                    winner: closure.patch.winner,
                    decidedBy: closure.patch.decidedBy,
                    rationale: closure.patch.rationale,
                    verdictAt: new Date(closure.patch.verdictAt),
                    resolvedAt: new Date(closure.patch.resolvedAt),
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(debateArenasTable.debateId, closure.debateId),
                      eq(debateArenasTable.state, 'open'),
                    ),
                  )
                  .returning();
          const row = updated[0];
          if (!row) throw new RemovalCloseConflict();
          rows.push(this.#toRecord(row));
        }
        return rows;
      });
    } catch (error) {
      if (error instanceof RemovalCloseConflict) return null;
      throw error;
    }
  }

  async claimForVerdict(debateId: string): Promise<DebateArenaRecord | null> {
    // Atomic claim: only a pre-verdict arena flips; the RETURNING row is
    // the post-claim snapshot the judge scores (position writes are
    // rejected from this instant by updatePosition's `state = 'open'` guard).
    const rows = await this.#db
      .update(debateArenasTable)
      .set({ state: 'awaiting_verdict', updatedAt: new Date() })
      .where(
        and(
          eq(debateArenasTable.debateId, debateId),
          inArray(debateArenasTable.state, [...PRE_VERDICT]),
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
          inArray(debateArenasTable.state, [...PRE_VERDICT]),
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
      // State CAS (mirrors recordVerdict): only override a still-`judged` arena.
      // Without it, an override racing the finalize sweep (judged→resolved) would
      // corrupt a finalized outcome — the caller's state check is a TOCTOU.
      .where(and(eq(debateArenasTable.debateId, debateId), eq(debateArenasTable.state, 'judged')))
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

  async resolveIfUnchanged(
    debateId: string,
    resolvedAt: string,
    expectedUpdatedAt: string,
  ): Promise<DebateArenaRecord | null> {
    // The updatedAt token is millisecond-precision on both sides (every write
    // stamps an explicit JS Date), so the equality CAS round-trips exactly.
    const rows = await this.#db
      .update(debateArenasTable)
      .set({ state: 'resolved', resolvedAt: new Date(resolvedAt), updatedAt: new Date() })
      .where(
        and(
          eq(debateArenasTable.debateId, debateId),
          eq(debateArenasTable.state, 'judged'),
          eq(debateArenasTable.updatedAt, new Date(expectedUpdatedAt)),
        ),
      )
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async listDueForLock(nowIso: string, limit: number): Promise<DebateArenaRecord[]> {
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.state, 'open'),
          lte(debateArenasTable.editDeadlineAt, new Date(nowIso)),
        ),
      )
      .orderBy(asc(debateArenasTable.editDeadlineAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listPastResolveDeadline(nowIso: string, limit: number): Promise<DebateArenaRecord[]> {
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(
        and(
          // `open` included for lock-sweep catch-up; `awaiting_verdict` so a
          // claim whose judge crashed mid-flight is re-listed, never stranded.
          inArray(debateArenasTable.state, [...PRE_VERDICT]),
          lte(debateArenasTable.resolveDueAt, new Date(nowIso)),
        ),
      )
      .orderBy(asc(debateArenasTable.resolveDueAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listIdleSince(idleSinceIso: string, limit: number): Promise<DebateArenaRecord[]> {
    // The both-sides-idle expedited sweep, over the partial greatest(...) index.
    const lastActivity = sql`greatest(${debateArenasTable.incumbentLastActiveAt}, ${debateArenasTable.challengerLastActiveAt})`;
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.state, 'open'),
          sql`${lastActivity} <= ${idleSinceIso}::timestamptz`,
        ),
      )
      .orderBy(sql`${lastActivity} asc`)
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

  async debateIdsForCorrections(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const rows = await this.#db
      .select({
        challengerContributionId: debateArenasTable.challengerContributionId,
        debateId: debateArenasTable.debateId,
      })
      .from(debateArenasTable)
      .where(inArray(debateArenasTable.challengerContributionId, [...ids]));
    for (const row of rows) out.set(row.challengerContributionId, row.debateId);
    return out;
  }

  async pinnedStoryChallenger(storyId: string): Promise<string | null> {
    const rows = await this.#db
      .select({ challenger: debateArenasTable.challengerContributionId })
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.targetType, 'story'),
          eq(debateArenasTable.storyId, storyId),
          or(
            inArray(debateArenasTable.state, [...NON_RESOLVED]),
            and(
              eq(debateArenasTable.state, 'resolved'),
              eq(debateArenasTable.verdict, 'corrected'),
            ),
          ),
        ),
      )
      .limit(1);
    return rows[0]?.challenger ?? null;
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

  async countActiveCommentArenas(storyIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (storyIds.length === 0) return out;
    const rows = await this.#db
      .select({ storyId: debateArenasTable.storyId, value: count() })
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.targetType, 'comment'),
          inArray(debateArenasTable.storyId, [...storyIds]),
          inArray(debateArenasTable.state, [...NON_RESOLVED]),
        ),
      )
      .groupBy(debateArenasTable.storyId);
    for (const row of rows) out.set(row.storyId, row.value);
    return out;
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

  async listByParty(
    userId: string,
    after: { createdAt: string; debateId: string } | null,
    limit: number,
  ): Promise<DebateArenaRecord[]> {
    const party = or(
      eq(debateArenasTable.incumbentUserId, userId),
      eq(debateArenasTable.challengerUserId, userId),
    );
    // Keyset: strictly after (createdAt, debateId) in lexicographic tuple order.
    const keyset =
      after === null
        ? undefined
        : or(
            gt(debateArenasTable.createdAt, new Date(after.createdAt)),
            and(
              eq(debateArenasTable.createdAt, new Date(after.createdAt)),
              gt(debateArenasTable.debateId, after.debateId),
            ),
          );
    const rows = await this.#db
      .select()
      .from(debateArenasTable)
      .where(keyset === undefined ? party : and(party, keyset))
      .orderBy(asc(debateArenasTable.createdAt), asc(debateArenasTable.debateId))
      .limit(Math.max(0, limit));
    return rows.map((row) => this.#toRecord(row));
  }

  async challengerHistory(
    userId: string,
    opts: {
      nowIso: string;
      opensWindowMs: number;
      withdrawWindowMs: number;
      graceMs: number;
    },
  ): Promise<ChallengerHistory> {
    const nowMs = Date.parse(opts.nowIso);
    const opensCutoff = new Date(nowMs - opts.opensWindowMs);
    const withdrawCutoff = new Date(nowMs - opts.withdrawWindowMs);
    // Self-targeted legacy arenas sit outside the standing system in EVERY
    // derivation (no wins, no slots, no budget, no withdrawal consequences).
    const asChallenger = and(
      eq(debateArenasTable.challengerUserId, userId),
      or(isNull(debateArenasTable.incumbentUserId), ne(debateArenasTable.incumbentUserId, userId)),
    );
    // Adjudicated resolutions only.
    const adjudicated = and(
      asChallenger,
      eq(debateArenasTable.state, 'resolved'),
      inArray(debateArenasTable.decidedBy, ['ai', 'steward']),
    );
    const [winRows, lossRows, liveRows, openRows, withdrawnRows] = await Promise.all([
      this.#db
        .select({ opponent: debateArenasTable.incumbentUserId, wins: count() })
        .from(debateArenasTable)
        .where(and(adjudicated, eq(debateArenasTable.winner, 'challenger')))
        .groupBy(debateArenasTable.incumbentUserId),
      this.#db
        .select({ losses: count() })
        .from(debateArenasTable)
        .where(and(adjudicated, eq(debateArenasTable.winner, 'incumbent'))),
      this.#db
        .select({ live: count() })
        .from(debateArenasTable)
        .where(and(asChallenger, inArray(debateArenasTable.state, [...PRE_VERDICT_STATES]))),
      this.#db
        .select({
          createdAt: debateArenasTable.createdAt,
          state: debateArenasTable.state,
          resolvedAt: debateArenasTable.resolvedAt,
          incumbentLastActiveAt: debateArenasTable.incumbentLastActiveAt,
        })
        .from(debateArenasTable)
        .where(and(asChallenger, gt(debateArenasTable.createdAt, opensCutoff))),
      this.#db
        .select({
          createdAt: debateArenasTable.createdAt,
          resolvedAt: debateArenasTable.resolvedAt,
          incumbentLastActiveAt: debateArenasTable.incumbentLastActiveAt,
        })
        .from(debateArenasTable)
        .where(
          and(
            asChallenger,
            eq(debateArenasTable.state, 'withdrawn'),
            gt(debateArenasTable.resolvedAt, withdrawCutoff),
          ),
        ),
    ]);
    return {
      winsByOpponent: winRows.map((row) => ({
        opponentKey: row.opponent ?? TOMBSTONED_OPPONENT_KEY,
        wins: row.wins,
      })),
      adjudicatedLosses: lossRows[0]?.losses ?? 0,
      liveCount: liveRows[0]?.live ?? 0,
      // A GRACE withdrawal consumed nothing — the daily budget included.
      openTimesLast24h: openRows
        .filter(
          (row) =>
            !(
              row.state === 'withdrawn' &&
              row.resolvedAt !== null &&
              isGraceWithdrawal(
                {
                  createdAt: iso(row.createdAt),
                  resolvedAt: iso(row.resolvedAt),
                  incumbentEngaged: row.incumbentLastActiveAt.getTime() > row.createdAt.getTime(),
                },
                opts.graceMs,
              )
            ),
        )
        .map((row) => iso(row.createdAt)),
      withdrawals: withdrawnRows.flatMap((row) =>
        row.resolvedAt === null
          ? []
          : [
              {
                createdAt: iso(row.createdAt),
                resolvedAt: iso(row.resolvedAt),
                incumbentEngaged: row.incumbentLastActiveAt.getTime() > row.createdAt.getTime(),
              },
            ],
      ),
    };
  }

  async countUpheldDefensesForComment(contributionId: string, sinceIso: string): Promise<number> {
    return this.#countUpheldDefenses(
      and(
        eq(debateArenasTable.targetType, 'comment'),
        eq(debateArenasTable.targetContributionId, contributionId),
      ),
      sinceIso,
    );
  }

  async countUpheldDefensesForStory(storyId: string, sinceIso: string): Promise<number> {
    return this.#countUpheldDefenses(
      and(eq(debateArenasTable.targetType, 'story'), eq(debateArenasTable.storyId, storyId)),
      sinceIso,
    );
  }

  async #countUpheldDefenses(
    targetWhere: ReturnType<typeof and>,
    sinceIso: string,
  ): Promise<number> {
    const rows = await this.#db
      .select({ defenses: count() })
      .from(debateArenasTable)
      .where(
        and(
          targetWhere,
          eq(debateArenasTable.state, 'resolved'),
          eq(debateArenasTable.verdict, 'upheld'),
          // Keyed on the LOCK instant — which VERSION the verdict judged
          // (a null-lockedAt legacy row proves nothing and never matches).
          gt(debateArenasTable.lockedAt, new Date(sinceIso)),
          // Self-targeted legacy arenas never count toward settling.
          or(
            isNull(debateArenasTable.incumbentUserId),
            isNull(debateArenasTable.challengerUserId),
            ne(debateArenasTable.incumbentUserId, debateArenasTable.challengerUserId),
          ),
        ),
      );
    return rows[0]?.defenses ?? 0;
  }

  async latestConcludedChallengeAt(
    target: { contributionId: string } | { storyId: string },
    challengerUserId: string,
    graceMs: number,
  ): Promise<string | null> {
    const targetWhere =
      'contributionId' in target
        ? and(
            eq(debateArenasTable.targetType, 'comment'),
            eq(debateArenasTable.targetContributionId, target.contributionId),
          )
        : and(
            eq(debateArenasTable.targetType, 'story'),
            eq(debateArenasTable.storyId, target.storyId),
          );
    // The per-(target, challenger) terminal set is tiny; grace classification
    // stays in the shared pure predicate rather than a SQL re-encoding.
    const rows = await this.#db
      .select({
        state: debateArenasTable.state,
        createdAt: debateArenasTable.createdAt,
        lockedAt: debateArenasTable.lockedAt,
        resolvedAt: debateArenasTable.resolvedAt,
        incumbentLastActiveAt: debateArenasTable.incumbentLastActiveAt,
      })
      .from(debateArenasTable)
      .where(
        and(
          targetWhere,
          eq(debateArenasTable.challengerUserId, challengerUserId),
          inArray(debateArenasTable.state, ['resolved', 'withdrawn']),
        ),
      );
    let latest: string | null = null;
    for (const row of rows) {
      if (row.resolvedAt === null) continue;
      if (
        row.state === 'withdrawn' &&
        isGraceWithdrawal(
          {
            createdAt: iso(row.createdAt),
            resolvedAt: iso(row.resolvedAt),
            incumbentEngaged: row.incumbentLastActiveAt.getTime() > row.createdAt.getTime(),
          },
          graceMs,
        )
      ) {
        continue;
      }
      // A resolved arena consumes the VERSION its verdict judged — the lock
      // instant (legacy null-lockedAt rows fall back to the resolve instant);
      // a withdrawal consumes by its retraction instant (no snapshot exists).
      const concludedAt =
        row.state === 'resolved' ? iso(row.lockedAt ?? row.resolvedAt) : iso(row.resolvedAt);
      if (latest === null || concludedAt > latest) latest = concludedAt;
    }
    return latest;
  }

  async listChallengeOpens(
    challengerUserId: string,
    sinceIso: string,
    graceMs: number,
  ): Promise<{ debateId: string; createdAt: string; preVerdict: boolean }[]> {
    const rows = await this.#db
      .select({
        debateId: debateArenasTable.debateId,
        createdAt: debateArenasTable.createdAt,
        state: debateArenasTable.state,
        resolvedAt: debateArenasTable.resolvedAt,
        incumbentLastActiveAt: debateArenasTable.incumbentLastActiveAt,
      })
      .from(debateArenasTable)
      .where(
        and(
          eq(debateArenasTable.challengerUserId, challengerUserId),
          // The recheck counts the SAME set the account gates count: self-
          // targeted legacy arenas are outside the standing system.
          or(
            isNull(debateArenasTable.incumbentUserId),
            ne(debateArenasTable.incumbentUserId, challengerUserId),
          ),
          or(
            inArray(debateArenasTable.state, [...PRE_VERDICT_STATES]),
            gt(debateArenasTable.createdAt, new Date(sinceIso)),
          ),
        ),
      );
    return rows
      .filter(
        (row) =>
          // Grace withdrawals consumed nothing (the gates exempt them too).
          !(
            row.state === 'withdrawn' &&
            row.resolvedAt !== null &&
            isGraceWithdrawal(
              {
                createdAt: iso(row.createdAt),
                resolvedAt: iso(row.resolvedAt),
                incumbentEngaged: row.incumbentLastActiveAt.getTime() > row.createdAt.getTime(),
              },
              graceMs,
            )
          ),
      )
      .map((row) => ({
        debateId: row.debateId,
        createdAt: iso(row.createdAt),
        preVerdict: (PRE_VERDICT_STATES as readonly string[]).includes(row.state),
      }));
  }

  async anonymizeParty(userId: string): Promise<number> {
    // One statement, CASE per column: an arena where the user is incumbent AND
    // steward-override (or any combination) is NULLed everywhere and counted
    // once.  The rebuttal text in `positions` persists per §22.4.
    const rows = await this.#db
      .update(debateArenasTable)
      .set({
        incumbentUserId: sql`CASE WHEN ${debateArenasTable.incumbentUserId} = ${userId} THEN NULL ELSE ${debateArenasTable.incumbentUserId} END`,
        challengerUserId: sql`CASE WHEN ${debateArenasTable.challengerUserId} = ${userId} THEN NULL ELSE ${debateArenasTable.challengerUserId} END`,
        overriddenByUserId: sql`CASE WHEN ${debateArenasTable.overriddenByUserId} = ${userId} THEN NULL ELSE ${debateArenasTable.overriddenByUserId} END`,
        updatedAt: new Date(),
      })
      .where(
        or(
          eq(debateArenasTable.incumbentUserId, userId),
          eq(debateArenasTable.challengerUserId, userId),
          eq(debateArenasTable.overriddenByUserId, userId),
        ),
      )
      .returning({ id: debateArenasTable.debateId });
    return rows.length;
  }

  async shiftDeadlines(
    debateId: string,
    patch: { editDeadlineAt?: string; resolveDueAt?: string; overrideDeadlineAt?: string },
  ): Promise<DebateArenaRecord | null> {
    const rows = await this.#db
      .update(debateArenasTable)
      .set({
        ...(patch.editDeadlineAt !== undefined
          ? { editDeadlineAt: new Date(patch.editDeadlineAt) }
          : {}),
        ...(patch.resolveDueAt !== undefined ? { resolveDueAt: new Date(patch.resolveDueAt) } : {}),
        ...(patch.overrideDeadlineAt !== undefined
          ? { overrideDeadlineAt: new Date(patch.overrideDeadlineAt) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(debateArenasTable.debateId, debateId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(debateArenasTable).where(ne(debateArenasTable.debateId, ''));
  }
}
