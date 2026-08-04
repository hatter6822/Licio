// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapters for the WS-H platform stores, behind the
// same interfaces as the in-memory adapters (the WS-D/E/F/G policy), and
// covered by the gated integration tests that run the real migration chain.
// The session-topic-sequence store stays in-memory/Redis territory by
// design: sequences are SESSION-SCOPED ephemera (WS-H.6.1a) and never
// belong in durable Postgres.

import { randomUUID } from 'node:crypto';
import {
  bridgeAttempts,
  type DbExecutor,
  invariantCalibrations,
  invariantPromotions,
  invariantRunMetadata,
  mfciCases,
  mfciMargins,
  mfciRiskStates,
} from '@licio/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { isUniqueViolation } from '../lib/pg-errors.js';
import type {
  BridgeAttemptRecord,
  BridgeAttemptStatus,
  BridgeAttemptStore,
  CalibrationRow,
  CalibrationStore,
  MfciCaseRowRecord,
  MfciCaseStatus,
  MfciCaseStore,
  MfciMarginsRecord,
  MfciMarginsStore,
  MfciRiskStateRecord,
  MfciRiskStateStore,
  PromotionRecordRow,
  PromotionStore,
  RunMetadataRow,
  RunMetadataStore,
} from './stores.js';

/** The client OR an open transaction — a store a unit of work binds to one
 *  handle must accept the handle the unit is holding. */
type Db = DbExecutor;

const iso = (d: Date): string => d.toISOString();

export class DrizzlePromotionStore implements PromotionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(record: PromotionRecordRow): Promise<void> {
    await this.#db.insert(invariantPromotions).values({
      invariantType: record.invariantType,
      fromStatus: record.fromStatus,
      toStatus: record.toStatus,
      evidence: record.evidence,
      owner: record.owner,
      createdAt: new Date(record.createdAt),
    });
  }

  async listForInvariant(invariantType: string): Promise<PromotionRecordRow[]> {
    const rows = await this.#db
      .select()
      .from(invariantPromotions)
      .where(eq(invariantPromotions.invariantType, invariantType))
      .orderBy(asc(invariantPromotions.createdAt));
    return rows.map((row) => ({
      invariantType: row.invariantType,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      evidence: row.evidence,
      owner: row.owner,
      createdAt: iso(row.createdAt),
    }));
  }

  async clear(): Promise<void> {
    await this.#db.delete(invariantPromotions);
  }
}

export class DrizzleCalibrationStore implements CalibrationStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async upsert(row: CalibrationRow): Promise<void> {
    const values = {
      calibrationKey: row.calibrationKey,
      version: row.version,
      data: row.data,
      sampleCount: row.sampleCount,
      computedAt: new Date(row.computedAt),
    };
    await this.#db
      .insert(invariantCalibrations)
      .values(values)
      .onConflictDoUpdate({ target: invariantCalibrations.calibrationKey, set: values });
  }

  async get(calibrationKey: string): Promise<CalibrationRow | null> {
    const [row] = await this.#db
      .select()
      .from(invariantCalibrations)
      .where(eq(invariantCalibrations.calibrationKey, calibrationKey))
      .limit(1);
    if (!row) return null;
    return {
      calibrationKey: row.calibrationKey,
      version: row.version,
      data: row.data,
      sampleCount: row.sampleCount,
      computedAt: iso(row.computedAt),
    };
  }

  async clear(): Promise<void> {
    await this.#db.delete(invariantCalibrations);
  }
}

export class DrizzleRunMetadataStore implements RunMetadataStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(row: RunMetadataRow): Promise<void> {
    await this.#db.insert(invariantRunMetadata).values({
      invariantType: row.invariantType,
      tier: row.tier,
      targetCount: row.targetCount,
      durationMs: row.durationMs,
      success: row.success,
      failureReason: row.failureReason,
      startedAt: new Date(row.startedAt),
    });
  }

  async listRecent(invariantType: string, limit: number): Promise<RunMetadataRow[]> {
    const rows = await this.#db
      .select()
      .from(invariantRunMetadata)
      .where(eq(invariantRunMetadata.invariantType, invariantType))
      .orderBy(desc(invariantRunMetadata.startedAt))
      .limit(limit);
    return rows.map((row) => ({
      invariantType: row.invariantType,
      tier: row.tier as RunMetadataRow['tier'],
      targetCount: row.targetCount,
      durationMs: row.durationMs,
      success: row.success,
      failureReason: row.failureReason,
      startedAt: iso(row.startedAt),
    }));
  }

  async firstRunAt(invariantType: string): Promise<string | null> {
    const rows = await this.#db
      .select({ startedAt: invariantRunMetadata.startedAt })
      .from(invariantRunMetadata)
      .where(eq(invariantRunMetadata.invariantType, invariantType))
      .orderBy(asc(invariantRunMetadata.startedAt))
      .limit(1);
    const first = rows[0];
    return first ? iso(first.startedAt) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(invariantRunMetadata);
  }
}

export class DrizzleMfciCaseStore implements MfciCaseStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof mfciCases.$inferSelect): MfciCaseRowRecord {
    return {
      caseId: row.caseId,
      targetType: row.targetType,
      targetId: row.targetId,
      riskState: row.riskState,
      statistic: row.statistic,
      mfciScore: row.mfciScore,
      pHat: row.pHat,
      sampleCount: row.sampleCount,
      fixedMarginsRef: row.fixedMarginsRef,
      summary: row.summary,
      appealSummary: row.appealSummary,
      status: row.status as MfciCaseStatus,
      openedAt: iso(row.openedAt),
      resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
      resolvedBy: row.resolvedBy,
    };
  }

  async insert(row: MfciCaseRowRecord): Promise<void> {
    await this.#db.insert(mfciCases).values({
      caseId: row.caseId || randomUUID(),
      targetType: row.targetType,
      targetId: row.targetId,
      riskState: row.riskState,
      statistic: row.statistic,
      mfciScore: row.mfciScore,
      pHat: row.pHat,
      sampleCount: row.sampleCount,
      fixedMarginsRef: row.fixedMarginsRef,
      summary: row.summary,
      appealSummary: row.appealSummary,
      status: row.status,
      openedAt: new Date(row.openedAt),
      resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
      resolvedBy: row.resolvedBy,
    });
  }

  async getById(caseId: string): Promise<MfciCaseRowRecord | null> {
    const [row] = await this.#db
      .select()
      .from(mfciCases)
      .where(eq(mfciCases.caseId, caseId))
      .limit(1);
    return row ? this.#toRecord(row) : null;
  }

  async listOpen(limit: number): Promise<MfciCaseRowRecord[]> {
    // Severity then recency IN SQL — the over-fetch-and-resort pattern
    // could drop a severe case older than `limit·4` newer elevated ones.
    const severityExpr = sql`case ${mfciCases.riskState}
      when 'severe' then 3 when 'high' then 2 when 'elevated' then 1 else 0 end`;
    const rows = await this.#db
      .select()
      .from(mfciCases)
      .where(eq(mfciCases.status, 'open'))
      .orderBy(desc(severityExpr), desc(mfciCases.openedAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async latestForTarget(targetId: string): Promise<MfciCaseRowRecord | null> {
    const [row] = await this.#db
      .select()
      .from(mfciCases)
      .where(eq(mfciCases.targetId, targetId))
      .orderBy(desc(mfciCases.openedAt))
      .limit(1);
    return row ? this.#toRecord(row) : null;
  }

  async resolve(
    caseId: string,
    status: Exclude<MfciCaseStatus, 'open'>,
    resolvedBy: string,
    resolvedAt: string,
  ): Promise<MfciCaseRowRecord | null> {
    const [row] = await this.#db
      .update(mfciCases)
      .set({ status, resolvedBy, resolvedAt: new Date(resolvedAt) })
      .where(and(eq(mfciCases.caseId, caseId), eq(mfciCases.status, 'open')))
      .returning();
    return row ? this.#toRecord(row) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(mfciCases);
  }
}

export class DrizzleMfciMarginsStore implements MfciMarginsStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(record: MfciMarginsRecord): Promise<void> {
    // Content-addressed: the same ref always names the same margins, so a
    // conflicting insert is a no-op recompute, never an overwrite.
    await this.#db
      .insert(mfciMargins)
      .values({
        marginsRef: record.marginsRef,
        windowStart: new Date(record.windowStart),
        margins: record.margins as unknown as Record<string, unknown>,
        createdAt: new Date(record.createdAt),
      })
      .onConflictDoNothing({ target: mfciMargins.marginsRef });
  }

  async get(marginsRef: string): Promise<MfciMarginsRecord | null> {
    const [row] = await this.#db
      .select()
      .from(mfciMargins)
      .where(eq(mfciMargins.marginsRef, marginsRef))
      .limit(1);
    if (!row) return null;
    return {
      marginsRef: row.marginsRef,
      windowStart: iso(row.windowStart),
      margins: row.margins as unknown as MfciMarginsRecord['margins'],
      createdAt: iso(row.createdAt),
    };
  }

  async clear(): Promise<void> {
    await this.#db.delete(mfciMargins);
  }
}

export class DrizzleBridgeAttemptStore implements BridgeAttemptStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof bridgeAttempts.$inferSelect): BridgeAttemptRecord {
    return {
      attemptId: row.attemptId,
      threadId: row.threadId,
      storyId: row.storyId,
      status: row.status as BridgeAttemptStatus,
      requestedBy: row.requestedBy,
      candidateUserIds: row.candidateUserIds,
      contributionId: row.contributionId,
      bridgeUserId: row.bridgeUserId,
      scoiBaseline: row.scoiBaseline,
      scoiAfter: row.scoiAfter,
      createdAt: iso(row.createdAt),
      resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
    };
  }

  async insert(record: BridgeAttemptRecord): Promise<void> {
    await this.#db.insert(bridgeAttempts).values({
      attemptId: record.attemptId || randomUUID(),
      threadId: record.threadId,
      storyId: record.storyId,
      status: record.status,
      requestedBy: record.requestedBy,
      candidateUserIds: [...record.candidateUserIds],
      contributionId: record.contributionId,
      bridgeUserId: record.bridgeUserId,
      scoiBaseline: record.scoiBaseline,
      scoiAfter: record.scoiAfter,
      createdAt: new Date(record.createdAt),
      resolvedAt: record.resolvedAt ? new Date(record.resolvedAt) : null,
    });
  }

  async insertIfNoneOpen(
    record: BridgeAttemptRecord,
  ): Promise<{ attempt: BridgeAttemptRecord; inserted: boolean }> {
    // The pre-check and the write are two statements, so POSTGRES decides:
    // `bridge_attempts_open_thread_uq` is partial on `status = 'requested'`, and
    // the loser of a concurrent pair sees 23505 and reads the winner's row —
    // the same answer it would have got a moment earlier.
    try {
      await this.insert(record);
      return { attempt: record, inserted: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const open = await this.openForThread(record.threadId);
      if (open === null) throw error;
      return { attempt: open, inserted: false };
    }
  }

  async openForThread(threadId: string): Promise<BridgeAttemptRecord | null> {
    const [row] = await this.#db
      .select()
      .from(bridgeAttempts)
      .where(and(eq(bridgeAttempts.threadId, threadId), eq(bridgeAttempts.status, 'requested')))
      .orderBy(desc(bridgeAttempts.createdAt))
      .limit(1);
    return row ? this.#toRecord(row) : null;
  }

  async listForThread(threadId: string, limit: number): Promise<BridgeAttemptRecord[]> {
    const rows = await this.#db
      .select()
      .from(bridgeAttempts)
      .where(eq(bridgeAttempts.threadId, threadId))
      .orderBy(desc(bridgeAttempts.createdAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async credit(
    attemptId: string,
    patch: {
      contributionId: string;
      bridgeUserId: string;
      scoiAfter: number;
      resolvedAt: string;
    },
  ): Promise<BridgeAttemptRecord | null> {
    const [row] = await this.#db
      .update(bridgeAttempts)
      .set({
        status: 'credited',
        contributionId: patch.contributionId,
        bridgeUserId: patch.bridgeUserId,
        scoiAfter: patch.scoiAfter,
        resolvedAt: new Date(patch.resolvedAt),
      })
      .where(and(eq(bridgeAttempts.attemptId, attemptId), eq(bridgeAttempts.status, 'requested')))
      .returning();
    return row ? this.#toRecord(row) : null;
  }

  async rebaseline(attemptId: string, scoiBaseline: number): Promise<BridgeAttemptRecord | null> {
    const [row] = await this.#db
      .update(bridgeAttempts)
      .set({ scoiBaseline })
      .where(and(eq(bridgeAttempts.attemptId, attemptId), eq(bridgeAttempts.status, 'requested')))
      .returning();
    return row ? this.#toRecord(row) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(bridgeAttempts);
  }
}

export class DrizzleMfciRiskStateStore implements MfciRiskStateStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(targetId: string): Promise<MfciRiskStateRecord | null> {
    const [row] = await this.#db
      .select()
      .from(mfciRiskStates)
      .where(eq(mfciRiskStates.targetId, targetId))
      .limit(1);
    if (!row) return null;
    return {
      targetId: row.targetId,
      state: row.state as MfciRiskStateRecord['state'],
      score: row.score,
      reason: row.reason,
      updatedAt: iso(row.updatedAt),
    };
  }

  async getMany(targetIds: readonly string[]): Promise<Map<string, MfciRiskStateRecord>> {
    const out = new Map<string, MfciRiskStateRecord>();
    if (targetIds.length === 0) return out;
    const rows = await this.#db
      .select()
      .from(mfciRiskStates)
      .where(inArray(mfciRiskStates.targetId, [...targetIds]));
    for (const row of rows) {
      out.set(row.targetId, {
        targetId: row.targetId,
        state: row.state as MfciRiskStateRecord['state'],
        score: row.score,
        reason: row.reason,
        updatedAt: iso(row.updatedAt),
      });
    }
    return out;
  }

  async set(record: MfciRiskStateRecord): Promise<void> {
    const values = {
      targetId: record.targetId,
      state: record.state,
      score: record.score,
      reason: record.reason,
      updatedAt: new Date(record.updatedAt),
    };
    await this.#db
      .insert(mfciRiskStates)
      .values(values)
      .onConflictDoUpdate({ target: mfciRiskStates.targetId, set: values });
  }

  async clear(): Promise<void> {
    await this.#db.delete(mfciRiskStates);
  }
}
