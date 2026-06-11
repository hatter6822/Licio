// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gated integration tests (DATABASE_URL) for the WS-H Drizzle adapters,
// run against the REAL migration chain — the same policy as WS-D/E/F/G.
// Also proves the 0009 time_window text→jsonb USING expression on live
// Postgres (a temp table seeded with the legacy label format), and the
// invariant_outputs CHECK vocabulary.
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleInvariantOutputStore } from '../../events/drizzle-event-stores.js';
import {
  DrizzleCalibrationStore,
  DrizzleMfciCaseStore,
  DrizzlePromotionStore,
  DrizzleRunMetadataStore,
} from '../drizzle-invariant-stores.js';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('WS-H Drizzle adapters (live Postgres)', () => {
  let db: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('promotion store: append-only history in createdAt order', async () => {
    const store = new DrizzlePromotionStore(db);
    const invariantType = `MERI`;
    await store.clear();
    await store.append({
      invariantType,
      fromStatus: 'shadow',
      toStatus: 'soft_constraint',
      evidence: { shadowDurationDays: 30 },
      owner: 'ranking-lead',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    await store.append({
      invariantType,
      fromStatus: 'soft_constraint',
      toStatus: 'shadow',
      evidence: { driftReportRef: 'incident-1' },
      owner: 'oncall',
      createdAt: '2026-06-02T00:00:00.000Z',
    });
    const history = await store.listForInvariant(invariantType);
    expect(history).toHaveLength(2);
    expect(history[1]?.toStatus).toBe('shadow');
    // The DB CHECK refuses unknown statuses.
    await expect(
      store.append({
        invariantType,
        fromStatus: 'shadow',
        toStatus: 'enforced',
        evidence: {},
        owner: 'x',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    await store.clear();
  });

  it('calibration store: keyed upsert round-trip', async () => {
    const store = new DrizzleCalibrationStore(db);
    const key = `test:${randomUUID()}`;
    await store.upsert({
      calibrationKey: key,
      version: 'v1',
      data: { buckets: [{ minVolume: 0, q50: 0.2, q90: 0.4, q99: 0.5, sampleCount: 100 }] },
      sampleCount: 100,
      computedAt: '2026-06-10T00:00:00.000Z',
    });
    await store.upsert({
      calibrationKey: key,
      version: 'v2',
      data: { buckets: [] },
      sampleCount: 200,
      computedAt: '2026-06-11T00:00:00.000Z',
    });
    const row = await store.get(key);
    expect(row?.version).toBe('v2');
    expect(row?.sampleCount).toBe(200);
  });

  it('run metadata: append + newest-first listing + tier CHECK', async () => {
    const store = new DrizzleRunMetadataStore(db);
    await store.clear();
    await store.append({
      invariantType: 'SCOI',
      tier: 'batch',
      targetCount: 5,
      durationMs: 120,
      success: true,
      failureReason: null,
      startedAt: '2026-06-10T01:00:00.000Z',
    });
    await store.append({
      invariantType: 'SCOI',
      tier: 'realtime',
      targetCount: 1,
      durationMs: 8,
      success: false,
      failureReason: 'TIMEOUT',
      startedAt: '2026-06-10T02:00:00.000Z',
    });
    const rows = await store.listRecent('SCOI', 10);
    expect(rows[0]?.tier).toBe('realtime');
    expect(rows[1]?.success).toBe(true);
    await expect(
      store.append({
        invariantType: 'SCOI',
        tier: 'warp' as never,
        targetCount: 0,
        durationMs: 0,
        success: true,
        failureReason: null,
        startedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    await store.clear();
  });

  it('mfci cases: open queue ordering, single-shot resolve, p̂ CHECK', async () => {
    const store = new DrizzleMfciCaseStore(db);
    await store.clear();
    const mkCase = (riskState: string, openedAt: string) => ({
      caseId: randomUUID(),
      targetType: 'story',
      targetId: randomUUID(),
      riskState,
      statistic: 'target_concentration',
      mfciScore: 6,
      pHat: 0.002,
      sampleCount: 100,
      fixedMarginsRef: 'margins:test',
      summary: 'Coordination signal',
      appealSummary: 'What was detected: …',
      status: 'open' as const,
      openedAt,
      resolvedAt: null,
      resolvedBy: null,
    });
    const high = mkCase('high', '2026-06-10T03:00:00.000Z');
    const severe = mkCase('severe', '2026-06-10T01:00:00.000Z');
    await store.insert(high);
    await store.insert(severe);
    const open = await store.listOpen(10);
    expect(open[0]?.riskState).toBe('severe'); // severity outranks recency
    const resolved = await store.resolve(
      severe.caseId,
      'cleared',
      'steward:test',
      new Date().toISOString(),
    );
    expect(resolved?.status).toBe('cleared');
    expect(
      await store.resolve(severe.caseId, 'confirmed', 'steward:test', new Date().toISOString()),
    ).toBeNull();
    expect(await store.latestForTarget(high.targetId)).toMatchObject({ riskState: 'high' });
    await expect(
      store.insert({ ...mkCase('high', new Date().toISOString()), pHat: 0 }),
    ).rejects.toThrow();
    await store.clear();
  });

  it('invariant outputs: WS-H envelope round-trip + vocabulary CHECKs', async () => {
    const store = new DrizzleInvariantOutputStore(db);
    const targetId = randomUUID();
    const window = { start: '2026-06-10T10:00:00.000Z', end: '2026-06-10T11:00:00.000Z' };
    await store.upsert({
      invariantType: 'SCOI',
      targetType: 'story',
      targetId,
      timeWindow: window,
      version: '1.0.0',
      scoreVector: { scoi: 0.4 },
      explanationSummary: 'split',
      confidence: 0.8,
      coverage: 0.75,
      reasonCodes: ['SAMPLER_NONCONVERGENCE'],
      fallbackUsed: false,
      versionMetadata: { lenses: 3 },
      shadowMode: true,
      createdAt: new Date().toISOString(),
    });
    const rows = await store.listForTarget(targetId);
    expect(rows[0]?.timeWindow).toEqual(window);
    expect(rows[0]?.coverage).toBe(0.75);
    expect(rows[0]?.reasonCodes).toEqual(['SAMPLER_NONCONVERGENCE']);
    expect(rows[0]?.versionMetadata).toEqual({ lenses: 3 });
    // The closed type/target vocabularies hold at rest.
    await expect(
      store.upsert({
        invariantType: 'made_up_invariant',
        targetType: 'story',
        targetId,
        timeWindow: window,
        version: '1.0.0',
        scoreVector: {},
        explanationSummary: null,
        confidence: 0,
        coverage: 0,
        reasonCodes: [],
        fallbackUsed: false,
        versionMetadata: null,
        shadowMode: true,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    const comparison = await store.listForVersionComparison('SCOI', '1.0.0', '1.1.0', window);
    expect(comparison.length).toBeGreaterThanOrEqual(1);
  });

  it('the 0009 time_window USING expression converts legacy labels on live PG', async () => {
    // Reproduce the migration's conversion on a temp table seeded with the
    // exact legacy "<start ISO>/<size>" formats the WS-E writer produced.
    await db.execute(sql`drop table if exists tw_conversion_check`);
    await db.execute(sql`create table tw_conversion_check (time_window text not null)`);
    await db.execute(
      sql`insert into tw_conversion_check values ('2026-06-10T10:00:00.000Z/1h'), ('2026-06-09T00:00:00.000Z/7d')`,
    );
    await db.execute(sql`
      ALTER TABLE tw_conversion_check ALTER COLUMN time_window SET DATA TYPE jsonb
        USING jsonb_build_object(
          'start', split_part(time_window, '/', 1),
          'end', to_char(
            ((split_part(time_window, '/', 1))::timestamptz + CASE split_part(time_window, '/', 2)
              WHEN '1h' THEN interval '1 hour'
              WHEN '6h' THEN interval '6 hours'
              WHEN '24h' THEN interval '24 hours'
              WHEN '7d' THEN interval '7 days'
              ELSE interval '0' END) AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        )
    `);
    const rows = await db.execute<{ time_window: { start: string; end: string } }>(
      sql`select time_window from tw_conversion_check order by time_window->>'start'`,
    );
    expect(rows[0]?.time_window).toEqual({
      start: '2026-06-09T00:00:00.000Z',
      end: '2026-06-16T00:00:00.000Z',
    });
    expect(rows[1]?.time_window).toEqual({
      start: '2026-06-10T10:00:00.000Z',
      end: '2026-06-10T11:00:00.000Z',
    });
    await db.execute(sql`drop table tw_conversion_check`);
  });
});
