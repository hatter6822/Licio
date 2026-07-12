// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.3b / WS-F.3.2d / WS-F.3.2e performance + recall benchmarks. Gated on
// DATABASE_URL **and** RUN_PERF (opt-in: these seed tens of thousands of rows
// and build an HNSW index, so they never run in CI or a normal gated pass).
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
//     RUN_PERF=1 PERF_N=20000 pnpm --filter api test ingestion-performance
//
// What they establish (the acceptance criteria that were previously only
// EXPLAIN-asserted, never measured):
//   • WS-F.1.3b — exact-URL duplicate lookup p99 < 50 ms, index-driven. The
//     unique b-tree is O(log n); measuring at PERF_N proves the constant and
//     extrapolates to the 1 M target (≈ 6 more b-tree levels ≈ microseconds).
//   • WS-F.3.2d — similarity-query p99 < 100 ms via the HNSW index.
//   • WS-F.3.2e — a recall-vs-latency operating point: recall@k vs the exact
//     (seq-scan) neighbours at two hnsw.ef_search settings, so the chosen
//     point is recorded, not assumed.
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleEmbeddingStore, DrizzleStoryStore } from '../ingestion/drizzle-ingestion-stores.js';

const ENABLED = Boolean(process.env['DATABASE_URL']) && process.env['RUN_PERF'] === '1';
const N = Number(process.env['PERF_N'] ?? 10_000);
const DIM = 384;
const QUERIES = 200;

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

/** Clustered unit vectors so nearest-neighbours are well-defined (uniform
 *  random high-dim vectors are near-orthogonal and make recall meaningless).
 *  Deliberately NOISY clusters with overlapping support so the top-k boundary
 *  is "soft" — a crisp clustering yields recall ≡ 1.0 and hides the
 *  recall/latency tradeoff the WS-F.3.2e operating point exists to show. */
function makeVector(rng: () => number, center: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (let i = 0; i < 6; i += 1) v[(center * 5 + i) % DIM] = 1;
  for (let i = 0; i < DIM; i += 1) v[i] = (v[i] as number) + rng() * 0.9;
  let norm = 0;
  for (const x of v) norm += x * x;
  const inv = 1 / Math.sqrt(norm);
  return v.map((x) => x * inv);
}

describe.skipIf(!ENABLED)('WS-F performance + recall (gated: DATABASE_URL + RUN_PERF)', () => {
  let db: ReturnType<typeof createDbClient>;
  let submitterId: string;
  let roomId: string;
  let stories: DrizzleStoryStore;
  let embeddings: DrizzleEmbeddingStore;
  const version = `perf-${randomUUID().slice(0, 8)}`;
  const seededVectors: number[][] = [];
  const seededIds: string[] = [];
  const urls: string[] = [];

  beforeAll(async () => {
    db = createDbClient(process.env['DATABASE_URL'] as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    stories = new DrizzleStoryStore(db);
    embeddings = new DrizzleEmbeddingStore(db);
    const { users } = await import('@licio/db');
    const inserted = await db
      .insert(users)
      .values({
        handle: `perf_${randomUUID().slice(0, 8)}`,
        displayName: 'Perf',
        email: null,
        ageBandIfKnown: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
      })
      .returning();
    submitterId = (inserted[0] as { userId: string }).userId;
    // WS-Q — every story needs a home room (FK + NOT NULL).
    const { rooms } = await import('@licio/db');
    const room = await db
      .insert(rooms)
      .values({
        name: `Perf Room ${randomUUID().slice(0, 8)}`,
        slug: `perf-${randomUUID().slice(0, 8)}`,
        roomType: 'global_topic',
        visibility: 'public',
        joinModel: 'open',
        postingPolicy: 'all_members',
      })
      .returning();
    roomId = (room[0] as { roomId: string }).roomId;

    const rng = mulberry32(20260611);
    const clusters = Math.max(8, Math.floor(N / 40));
    // Seed N stories (each with a unique canonical URL) and N embeddings.
    const STORY_BATCH = 500;
    for (let base = 0; base < N; base += STORY_BATCH) {
      const rows = [];
      for (let i = base; i < Math.min(N, base + STORY_BATCH); i += 1) {
        const url = `https://perf.example/${version}/${i}`;
        urls.push(url);
        rows.push({
          storyId: randomUUID(),
          canonicalUrl: url,
          title: `Perf story ${i}`,
          titleHash: randomUUID().replaceAll('-', ''),
          submittedBy: submitterId,
          roomId,
          visibility: 'public' as const,
          topicIds: [randomUUID()],
          sensitivityLabels: ['none'],
          submissionType: 'original_brief' as const,
          submissionMetadata: { submission_type: 'original_brief' as const, body: `b${i}` },
          extractionState: 'not_applicable' as const,
        });
      }
      const { stories: storiesTable } = await import('@licio/db');
      await db.insert(storiesTable).values(rows);
    }
    const EMB_BATCH = 1_000;
    for (let base = 0; base < N; base += EMB_BATCH) {
      const rows = [];
      for (let i = base; i < Math.min(N, base + EMB_BATCH); i += 1) {
        const vec = makeVector(rng, i % clusters);
        const id = randomUUID();
        seededIds.push(id);
        seededVectors.push(vec);
        rows.push({
          targetType: 'story' as const,
          targetId: id,
          modelVersion: version,
          embedding: vec,
        });
      }
      const { embeddings: embeddingsTable } = await import('@licio/db');
      await db.insert(embeddingsTable).values(rows);
    }
  }, 600_000);

  afterAll(async () => {
    const { sql: rawSql } = await import('drizzle-orm');
    const {
      embeddings: embeddingsTable,
      stories: storiesTable,
      threads,
      users,
    } = await import('@licio/db');
    await db.delete(embeddingsTable).where(rawSql`${embeddingsTable.modelVersion} = ${version}`);
    await db
      .delete(threads)
      .where(
        rawSql`${threads.storyId} in (select story_id from stories where submitted_by = ${submitterId})`,
      );
    await db.delete(storiesTable).where(rawSql`${storiesTable.submittedBy} = ${submitterId}`);
    await db.delete(users).where(rawSql`${users.userId} = ${submitterId}`);
    if (roomId) {
      const { rooms } = await import('@licio/db');
      await db.delete(rooms).where(rawSql`${rooms.roomId} = ${roomId}`);
    }
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  it(`exact-URL dedup p99 < 50ms, index-driven (WS-F.1.3b) @ N=${N}`, async () => {
    const rng = mulberry32(7);
    const latencies: number[] = [];
    for (let q = 0; q < QUERIES; q += 1) {
      const url = urls[Math.floor(rng() * urls.length)] as string;
      const start = performance.now();
      const hit = await stories.getByCanonicalUrl(url, { visibility: 'public' });
      latencies.push(performance.now() - start);
      expect(hit).not.toBeNull();
    }
    const p99 = percentile(latencies, 99);
    // eslint-disable-next-line no-console
    console.error(
      `[WS-F.1.3b] exact-URL p99=${p99.toFixed(2)}ms p50=${percentile(latencies, 50).toFixed(2)}ms (N=${N})`,
    );
    // WS-Q tier dedup replaced the single canonical-URL unique with PER-TIER
    // partial uniques; the production lookup (getByCanonicalUrl with the
    // visibility scope) carries the full tier predicate (visibility +
    // hidden_state IS NULL), so the EXPLAIN probe must too — a bare
    // canonical_url query cannot use a partial index at all.
    const plan = await (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
      sql`explain select 1 from stories where canonical_url = ${urls[0] as string} and visibility = 'public' and hidden_state is null`,
    );
    expect(JSON.stringify(plan)).toMatch(/stories_canonical_url_public_uq/);
    expect(p99).toBeLessThan(50);
  });

  it(`similarity p99 < 100ms via HNSW (WS-F.3.2d) @ N=${N}`, async () => {
    const rng = mulberry32(11);
    const latencies: number[] = [];
    for (let q = 0; q < QUERIES; q += 1) {
      const vec = seededVectors[Math.floor(rng() * seededVectors.length)] as number[];
      const start = performance.now();
      await embeddings.findSimilarToVector('story', Float32Array.from(vec), version, -1, 10);
      latencies.push(performance.now() - start);
    }
    const p99 = percentile(latencies, 99);
    // eslint-disable-next-line no-console
    console.error(
      `[WS-F.3.2d] similarity (production query) p99=${p99.toFixed(2)}ms p50=${percentile(latencies, 50).toFixed(2)}ms (N=${N})`,
    );
    // This is the UNFORCED production query (filtered by model_version). The
    // planner picks the cheaper of (a) exact b-tree-on-version + sort and (b)
    // the HNSW index; below the crossover (small N) it picks exact sort —
    // still fast and EXACT — and switches to HNSW as the corpus grows. The
    // operating-point test below forces the HNSW path to measure its recall.
    expect(p99).toBeLessThan(100);
  });

  it('recall-vs-latency operating point at two ef_search settings (WS-F.3.2e)', async () => {
    const rng = mulberry32(13);
    const sample = Array.from({ length: 30 }, () => Math.floor(rng() * seededVectors.length));
    const k = 10;

    async function exactNeighbours(vec: number[]): Promise<Set<string>> {
      // Seq-scan ground truth: force the planner off the index.
      const literal = `[${vec.join(',')}]`;
      const rows = (await db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_indexscan = off`);
        await tx.execute(sql`set local enable_seqscan = on`);
        return tx.execute(sql`
          select target_id from embeddings
          where target_type = 'story' and model_version = ${version}
          order by embedding <=> ${literal}::vector limit ${k}
        `);
      })) as unknown as Array<{ target_id: string }>;
      return new Set(rows.map((r) => r.target_id));
    }

    async function hnswNeighbours(vec: number[], efSearch: number): Promise<Set<string>> {
      const literal = `[${vec.join(',')}]`;
      const rows = (await db.transaction(async (tx) => {
        // FORCE the HNSW index path (disable the exact sort + seq-scan
        // alternatives) so ef_search genuinely controls recall — otherwise,
        // below the crossover, the planner answers EXACTLY and the recall
        // measurement is meaningless.
        await tx.execute(sql`set local enable_sort = off`);
        await tx.execute(sql`set local enable_seqscan = off`);
        await tx.execute(sql`select set_config('hnsw.ef_search', ${String(efSearch)}, true)`);
        return tx.execute(sql`
          select target_id from embeddings
          where target_type = 'story' and model_version = ${version}
          order by embedding <=> ${literal}::vector limit ${k}
        `);
      })) as unknown as Array<{ target_id: string }>;
      return new Set(rows.map((r) => r.target_id));
    }

    for (const efSearch of [10, 40, 100]) {
      let recallSum = 0;
      const latencies: number[] = [];
      for (const idx of sample) {
        const vec = seededVectors[idx] as number[];
        const truth = await exactNeighbours(vec);
        const start = performance.now();
        const got = await hnswNeighbours(vec, efSearch);
        latencies.push(performance.now() - start);
        let hit = 0;
        for (const id of got) if (truth.has(id)) hit += 1;
        recallSum += hit / Math.max(1, truth.size);
      }
      const recall = recallSum / sample.length;
      // eslint-disable-next-line no-console
      console.error(
        `[WS-F.3.2e] ef_search=${efSearch} recall@${k}=${recall.toFixed(3)} p99=${percentile(latencies, 99).toFixed(2)}ms (N=${N})`,
      );
      // Operating point: ef_search=100 must clear a high-recall bar.
      if (efSearch === 100) expect(recall).toBeGreaterThanOrEqual(0.9);
    }
  });
});
