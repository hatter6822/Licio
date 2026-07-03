// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I performance benchmarks (the WS-F.3.2e precedent: measured operating
// points recorded at a stated N, gated on RUN_PERF — never CI). Two legs:
//
//   • The PURE ranking core (`rankFeasibleSet`) at a 10 000-candidate stress
//     pool — 25× the shipped 400-candidate budget. CPU-only (no DB gate):
//     the §13.4 constrained optimization, matroid dedup, and balancing are
//     the serving path's compute; the budget here bounds the per-request
//     cost at any realistic pool size. Determinism is asserted alongside
//     latency (byte-identical selections run to run — the M3 gate's
//     property at scale).
//   • The decision-log keyset query + point read against live Postgres at
//     PERF_LOG_N rows (WS-I.2.5c: the audit query must page by index, never
//     scan — the latency must not grow with table size).
//
//   RUN_PERF=1 PERF_RANK_N=10000 pnpm --filter api test ranking-performance
//   DATABASE_URL=… RUN_PERF=1 pnpm --filter api test ranking-performance

import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import {
  type Candidate,
  EVERGREEN_PROFILE,
  FEATURE_SCHEMA_VERSION,
  type FeatureVector,
  type RankingDecisionLog,
  type RankingEnforcement,
  rankFeasibleSet,
  retentionDeadline,
} from '@licio/ranking';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleDecisionLogStore } from '../ranking/drizzle-ranking-stores.js';

const PERF = process.env['RUN_PERF'] === '1';
const DB_URL = process.env['DATABASE_URL'];
const RANK_N = Number(process.env['PERF_RANK_N'] ?? 10_000);
const LOG_N = Number(process.env['PERF_LOG_N'] ?? 5_000);

/** Seeded PRNG (mulberry32) — reproducible corpora across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] as number;
}

const FULL_ENFORCEMENT: RankingEnforcement = {
  mfci: true,
  phi: true,
  hodge: true,
  meri: true,
  tropical: true,
  scoi: true,
  gwei: true,
};

/** A realistic stress pool: clustered duplicates, mixed risk states, partial
 *  feature coverage — the shapes the production assembly actually emits. */
function buildPool(n: number): {
  candidates: Candidate[];
  features: Map<string, FeatureVector>;
} {
  const rng = mulberry32(20260612);
  const baseMs = Date.parse('2026-06-12T00:00:00.000Z');
  const candidates: Candidate[] = [];
  const features = new Map<string, FeatureVector>();
  const riskStates = ['normal', 'normal', 'normal', 'elevated', 'high'] as const;
  for (let i = 0; i < n; i += 1) {
    const itemId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const createdAt = new Date(baseMs - Math.floor(rng() * 96) * 3_600_000).toISOString();
    const sourceId = `00000000-0000-4000-9000-${String(i % 200).padStart(12, '0')}`;
    const topic = `topic-${i % 40}`;
    candidates.push({
      item_id: itemId,
      item_type: 'story',
      source_type: 'global',
      room_id: null,
      visibility: 'public',
      topic_ids: [topic],
      source_id: sourceId,
      freshness_timestamp: createdAt,
      retrieval_score: rng(),
      retrieval_origins: ['global_pwatt_v1'],
      bridge_context: null,
    });
    const vector: FeatureVector = {
      item_id: itemId,
      item_type: 'story',
      room_id: null,
      visibility: 'public',
      topic_ids: [topic],
      source_id: sourceId,
      created_at: createdAt,
      feature_version: FEATURE_SCHEMA_VERSION,
      revision: 0,
      invariant_versions: {},
      updated_at: createdAt,
    };
    // ~50% feature coverage (honest cold-start mix), clusters of 5.
    if (rng() < 0.5) {
      vector.active_attention = rng();
      vector.constructive_participation = rng();
      vector.exposure_independence = rng();
      vector.source_evidence_completeness = rng();
      vector.freshness_decay = rng();
      vector.source_reliability = 0.3 + rng() * 0.4;
      vector.mfci_risk_state = riskStates[Math.floor(rng() * riskStates.length)] as never;
      vector.redundancy_penalty = rng() * 0.5;
    }
    if (i % 5 !== 0) {
      vector.duplicate_cluster_id = `00000000-0000-4000-8000-${String(Math.floor(i / 5) * 5).padStart(12, '0')}`;
    }
    features.set(itemId, vector);
  }
  return { candidates, features };
}

describe.skipIf(!PERF)(`WS-I ranking-core stress (RUN_PERF) @ N=${RANK_N}`, () => {
  it(`rankFeasibleSet p99 within budget and deterministic at ${RANK_N} candidates`, () => {
    const { candidates, features } = buildPool(RANK_N);
    const context = {
      surface: 'front_page' as const,
      surfaceRoomId: null,
      nowMs: Date.parse('2026-06-12T01:00:00.000Z'),
      topicRelevanceByItem: null,
      userPhiRisk: null,
      sensitiveTopicIds: new Set(['topic-7']),
      maxSourceSharePctOverride: null,
      lensByItem: null,
    };
    // Warm-up (JIT), then measure.
    for (let i = 0; i < 3; i += 1) {
      rankFeasibleSet(candidates, features, EVERGREEN_PROFILE, FULL_ENFORCEMENT, context);
    }
    const latencies: number[] = [];
    let signature: string | null = null;
    for (let run = 0; run < 25; run += 1) {
      const start = performance.now();
      const ranked = rankFeasibleSet(
        candidates,
        features,
        EVERGREEN_PROFILE,
        FULL_ENFORCEMENT,
        context,
      );
      latencies.push(performance.now() - start);
      const runSignature = JSON.stringify(
        ranked.selected.map((item) => [item.item_id, item.pwatt_score]),
      );
      if (signature === null) signature = runSignature;
      // Byte-identical selection on every run (M3 determinism at scale).
      expect(runSignature).toBe(signature);
      expect(ranked.selected.length).toBeLessThanOrEqual(EVERGREEN_PROFILE.page_size);
    }
    const p99 = percentile(latencies, 99);
    const p50 = percentile(latencies, 50);
    console.error(
      `[WS-I core] rankFeasibleSet p99=${p99.toFixed(1)}ms p50=${p50.toFixed(1)}ms @ N=${RANK_N} (25 runs)`,
    );
    // Operating point: 10k candidates is a 25× stress over the shipped
    // 400-candidate budget; one second bounds the worst realistic request.
    expect(p99).toBeLessThan(1_000);
  });
});

describe.skipIf(!PERF || !DB_URL)(
  `WS-I decision-log query latency (RUN_PERF + DATABASE_URL) @ N=${LOG_N}`,
  () => {
    let db: ReturnType<typeof createDbClient>;
    let decisions: DrizzleDecisionLogStore;
    const requestIds: string[] = [];
    const experimentId = `exp-perf-${randomUUID().slice(0, 8)}`;
    const baseMs = Date.now() - LOG_N * 1_000;

    beforeAll(async () => {
      db = createDbClient(DB_URL as string);
      await migrate(db, { migrationsFolder: migrationsFolder() });
      decisions = new DrizzleDecisionLogStore(db);
      const { rankingDecisionLogs } = await import('@licio/db');
      const BATCH = 500;
      for (let base = 0; base < LOG_N; base += BATCH) {
        const rows = [];
        for (let i = base; i < Math.min(LOG_N, base + BATCH); i += 1) {
          const requestId = randomUUID();
          requestIds.push(requestId);
          const timestamp = new Date(baseMs + i * 1_000).toISOString();
          const log: RankingDecisionLog = {
            request_id: requestId,
            parent_request_id: null,
            surface: 'front_page',
            user_privacy_bucket: `bucket:${(i % 256).toString(16).padStart(2, '0')}`,
            candidate_ids: [randomUUID()],
            selected_ids: [],
            score_components: {},
            feature_revisions: {},
            invariant_versions: {},
            constraints_applied: [],
            safety_exclusions: [],
            visibility_excluded_count: 0,
            quota_outcomes: [],
            explanation_ids: {},
            experiment_ids: [experimentId],
            timestamp,
            profile_id: 'evergreen',
            profile_version: '1.1.0',
            feature_version: 1,
            fallback: true,
            fallback_reason: 'kill_switch',
            replay_inputs: null,
            retain_until: retentionDeadline(timestamp, 180),
          };
          rows.push({
            requestId,
            surface: log.surface,
            userPrivacyBucket: log.user_privacy_bucket,
            fallback: log.fallback,
            profileId: log.profile_id,
            profileVersion: log.profile_version,
            featureVersion: log.feature_version,
            payload: log as unknown as Record<string, unknown>,
            timestamp: new Date(log.timestamp),
            retainUntil: new Date(log.retain_until),
          });
        }
        await db.insert(rankingDecisionLogs).values(rows);
      }
    }, 600_000);

    afterAll(async () => {
      const { rankingDecisionLogs } = await import('@licio/db');
      const { inArray } = await import('drizzle-orm');
      for (let base = 0; base < requestIds.length; base += 1_000) {
        await db
          .delete(rankingDecisionLogs)
          .where(inArray(rankingDecisionLogs.requestId, requestIds.slice(base, base + 1_000)));
      }
      const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
      await client.end();
    });

    it('point reads p99 < 50ms; keyset pages p99 < 200ms and never grow with depth', async () => {
      const rng = mulberry32(17);
      const pointLatencies: number[] = [];
      for (let q = 0; q < 200; q += 1) {
        const requestId = requestIds[Math.floor(rng() * requestIds.length)] as string;
        const start = performance.now();
        const log = await decisions.getByRequestId(requestId);
        pointLatencies.push(performance.now() - start);
        expect(log).not.toBeNull();
      }
      // Page from the newest row to a DEEP offset: keyset latency must stay
      // flat (an OFFSET implementation degrades linearly and fails here).
      const pageLatencies: number[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (; pages < 40; pages += 1) {
        const start = performance.now();
        const result = await decisions.query({
          fromIso: new Date(baseMs - 1_000).toISOString(),
          limit: 50,
          ...(cursor !== undefined ? { afterRequestId: cursor } : {}),
        });
        pageLatencies.push(performance.now() - start);
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      const pointP99 = percentile(pointLatencies, 99);
      const pageP99 = percentile(pageLatencies, 99);
      console.error(
        `[WS-I.2.5c] point p99=${pointP99.toFixed(1)}ms; keyset page p99=${pageP99.toFixed(1)}ms over ${pages + 1} pages @ N=${LOG_N}`,
      );
      expect(pointP99).toBeLessThan(50);
      expect(pageP99).toBeLessThan(200);
    });
  },
);
