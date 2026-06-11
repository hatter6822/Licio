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
  type createDbClient,
  invariantCalibrations,
  invariantPromotions,
  invariantRunMetadata,
  mfciCases,
} from '@licio/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import type {
  CalibrationRow,
  CalibrationStore,
  MfciCaseRowRecord,
  MfciCaseStatus,
  MfciCaseStore,
  PromotionRecordRow,
  PromotionStore,
  RunMetadataRow,
  RunMetadataStore,
} from './stores.js';

type Db = ReturnType<typeof createDbClient>;

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
    const rows = await this.#db
      .select()
      .from(mfciCases)
      .where(eq(mfciCases.status, 'open'))
      .orderBy(desc(mfciCases.openedAt))
      .limit(limit * 4);
    const severity: Record<string, number> = { severe: 3, high: 2, elevated: 1, normal: 0 };
    return rows
      .map((row) => this.#toRecord(row))
      .sort(
        (a, b) =>
          (severity[b.riskState] ?? 0) - (severity[a.riskState] ?? 0) ||
          Date.parse(b.openedAt) - Date.parse(a.openedAt),
      )
      .slice(0, limit);
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
