// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests for the WS-I ranking Drizzle
// adapters — the same interfaces the in-memory adapters satisfy, against
// the REAL migration chain (incl. 0012's composite PK, CHECKs, and
// retention index, and 0013's audit-enum extension). Run when DATABASE_URL
// is set (the CI test job provisions the service container).
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test

import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import {
  DeniedFinancialFieldError,
  FEATURE_SCHEMA_VERSION,
  type FeatureVector,
  type RankingDecisionLog,
  retentionDeadline,
} from '@licio/ranking';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DrizzleInvariantOutputStore,
  DrizzleItemSafetyStateStore,
} from '../events/drizzle-event-stores.js';
import { DrizzleStoryStore } from '../ingestion/drizzle-ingestion-stores.js';
import { DrizzleDecisionLogStore, DrizzleFeatureStore } from '../ranking/drizzle-ranking-stores.js';

const DB_URL = process.env['DATABASE_URL'];

function vectorOf(itemId: string, revision: number): FeatureVector {
  return {
    item_id: itemId,
    item_type: 'story',
    room_id: null,
    topic_ids: ['civics'],
    source_id: null,
    created_at: '2026-06-10T00:00:00.000Z',
    feature_version: FEATURE_SCHEMA_VERSION,
    revision,
    invariant_versions: {
      MFCI: {
        version_string: '1.0.0',
        computation_timestamp: '2026-06-10T00:30:00.000Z',
        config_hash: 'deadbeefcafef00d',
      },
    },
    updated_at: new Date().toISOString(),
    active_attention: 0.4,
    mfci_risk_state: 'elevated',
  };
}

function logOf(requestId: string, timestampIso: string): RankingDecisionLog {
  return {
    request_id: requestId,
    parent_request_id: null,
    surface: 'front_page',
    user_privacy_bucket: 'bucket:1f',
    candidate_ids: [randomUUID()],
    selected_ids: [],
    score_components: {},
    feature_revisions: {},
    invariant_versions: {
      MFCI: {
        version_string: '1.0.0',
        computation_timestamp: timestampIso,
        config_hash: 'deadbeefcafef00d',
      },
    },
    constraints_applied: [
      {
        constraint: 'mfci_severe_cross_community',
        item_id: null,
        threshold: 'severe',
        actual: 'severe',
        action: 'excluded',
        enforced: false,
      },
    ],
    safety_exclusions: [],
    quota_outcomes: [],
    explanation_ids: {},
    experiment_ids: ['exp-1'],
    timestamp: timestampIso,
    profile_id: 'evergreen',
    profile_version: '1.0.0',
    feature_version: 1,
    fallback: true,
    fallback_reason: 'kill_switch',
    replay_inputs: null,
    retain_until: retentionDeadline(timestampIso, 180),
  };
}

describe.skipIf(!DB_URL)('WS-I ranking Drizzle adapters (live Postgres)', () => {
  let db: ReturnType<typeof createDbClient>;
  let features: DrizzleFeatureStore;
  let decisions: DrizzleDecisionLogStore;
  const itemIds: string[] = [];
  const requestIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    features = new DrizzleFeatureStore(db);
    decisions = new DrizzleDecisionLogStore(db);
  });

  afterAll(async () => {
    const { rankingDecisionLogs, rankingFeatureVectors } = await import('@licio/db');
    const { inArray } = await import('drizzle-orm');
    if (itemIds.length > 0) {
      await db.delete(rankingFeatureVectors).where(inArray(rankingFeatureVectors.itemId, itemIds));
    }
    if (requestIds.length > 0) {
      await db
        .delete(rankingDecisionLogs)
        .where(inArray(rankingDecisionLogs.requestId, requestIds));
    }
  });

  it('appends monotonic revisions; the PK rejects stale writers; snapshots round-trip', async () => {
    const itemId = randomUUID();
    itemIds.push(itemId);
    const r0 = vectorOf(itemId, 0);
    expect((await features.upsert(r0))?.revision).toBe(0);
    expect((await features.upsert(vectorOf(itemId, 1)))?.revision).toBe(1);
    // Stale writer (revision 1 again) loses on the composite PK.
    expect(await features.upsert(vectorOf(itemId, 1))).toBeNull();
    // Exact snapshots, latest, and the WS-I.2.1c version map round-trip.
    const snapshot = await features.getRevision(itemId, 0);
    expect(snapshot?.invariant_versions['MFCI']?.config_hash).toBe('deadbeefcafef00d');
    expect((await features.getLatest(itemId))?.revision).toBe(1);
    const many = await features.getLatestMany([itemId, randomUUID()]);
    expect(many.size).toBe(1);
  });

  it('the denylist gate holds in front of SQL (no privileged write path)', async () => {
    const itemId = randomUUID();
    itemIds.push(itemId);
    await expect(
      features.upsert({
        ...vectorOf(itemId, 0),
        wallet_balance: 7,
      } as unknown as FeatureVector),
    ).rejects.toThrow(DeniedFinancialFieldError);
    expect(await features.getLatest(itemId)).toBeNull();
  });

  it('decision logs insert once, query on the audit dimensions, and sweep at retention', async () => {
    const now = Date.now();
    const requestId = randomUUID();
    requestIds.push(requestId);
    const log = logOf(requestId, new Date(now).toISOString());
    await decisions.insert(log);
    // Duplicate request id rejected (exactly one log per request).
    await expect(decisions.insert(log)).rejects.toThrow();
    expect((await decisions.getByRequestId(requestId))?.request_id).toBe(requestId);
    // The six audit dimensions (WS-I.2.5c).
    const byItem = await decisions.query({ itemId: log.candidate_ids[0] as string, limit: 10 });
    expect(byItem.logs.map((l) => l.request_id)).toContain(requestId);
    const byBucket = await decisions.query({ userPrivacyBucket: 'bucket:1f', limit: 10 });
    expect(byBucket.logs.map((l) => l.request_id)).toContain(requestId);
    const byInvariant = await decisions.query({
      invariantName: 'MFCI',
      invariantVersion: '1.0.0',
      limit: 10,
    });
    expect(byInvariant.logs.map((l) => l.request_id)).toContain(requestId);
    const byConstraint = await decisions.query({
      constraint: 'mfci_severe_cross_community',
      limit: 10,
    });
    expect(byConstraint.logs.map((l) => l.request_id)).toContain(requestId);
    const byExperiment = await decisions.query({ experimentId: 'exp-1', limit: 10 });
    expect(byExperiment.logs.map((l) => l.request_id)).toContain(requestId);
    const byTime = await decisions.query({
      fromIso: new Date(now - 60_000).toISOString(),
      toIso: new Date(now + 60_000).toISOString(),
      limit: 10,
    });
    expect(byTime.logs.map((l) => l.request_id)).toContain(requestId);
    // §22.4 sweep: past the deadline the row deletes.
    const removed = await decisions.sweepExpired(
      new Date(now + 181 * 24 * 3_600_000).toISOString(),
    );
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await decisions.getByRequestId(requestId)).toBeNull();
  });

  it('the privacy-bucket CHECK rejects raw identifiers at the storage layer', async () => {
    const { rankingDecisionLogs } = await import('@licio/db');
    const requestId = randomUUID();
    requestIds.push(requestId);
    await expect(
      db.insert(rankingDecisionLogs).values({
        requestId,
        surface: 'front_page',
        userPrivacyBucket: randomUUID(), // a raw id shape — must be rejected
        fallback: true,
        profileId: 'evergreen',
        profileVersion: '1.0.0',
        featureVersion: 1,
        payload: {},
        timestamp: new Date(),
        retainUntil: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('getLatestMany is ONE DISTINCT ON query; getAt resolves by-timestamp snapshots', async () => {
    const itemA = randomUUID();
    const itemB = randomUUID();
    itemIds.push(itemA, itemB);
    const at = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000).toISOString();
    for (const [itemId, offsets] of [
      [itemA, [-30, -20, -10]],
      [itemB, [-30, -20]],
    ] as const) {
      for (const [revision, offset] of offsets.entries()) {
        expect(
          await features.upsert({ ...vectorOf(itemId, revision), updated_at: at(offset) }),
        ).not.toBeNull();
      }
    }
    // DISTINCT ON returns exactly the highest revision per item.
    const many = await features.getLatestMany([itemA, itemB, randomUUID()]);
    expect(many.size).toBe(2);
    expect(many.get(itemA)?.revision).toBe(2);
    expect(many.get(itemB)?.revision).toBe(1);
    // getAt: the NEWEST revision at-or-before the timestamp (WS-I.2.5c
    // "feature snapshot by item and timestamp" admin read).
    expect((await features.getAt(itemA, at(-15)))?.revision).toBe(1);
    expect((await features.getAt(itemA, at(-25)))?.revision).toBe(0);
    expect((await features.getAt(itemA, at(0)))?.revision).toBe(2);
    expect(await features.getAt(itemA, at(-45))).toBeNull(); // predates coverage
  });

  it('decision-log keyset pagination pages completely, in order, without overlap', async () => {
    // A unique experiment id scopes this test's rows (gated suites share the
    // live database; an unfiltered query would see parallel writers).
    const experimentId = `exp-keyset-${randomUUID().slice(0, 8)}`;
    const base = Date.now();
    const inserted: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const requestId = randomUUID();
      requestIds.push(requestId);
      inserted.push(requestId);
      await decisions.insert({
        ...logOf(requestId, new Date(base + i * 1_000).toISOString()),
        experiment_ids: [experimentId],
      });
    }
    // Two SAME-timestamp rows exercise the composite (timestamp, request_id)
    // row comparison — the tie breaks on request_id desc, deterministically.
    const tieA = randomUUID();
    const tieB = randomUUID();
    requestIds.push(tieA, tieB);
    for (const requestId of [tieA, tieB]) {
      await decisions.insert({
        ...logOf(requestId, new Date(base + 10_000).toISOString()),
        experiment_ids: [experimentId],
      });
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await decisions.query({
        experimentId,
        limit: 2,
        ...(cursor !== undefined ? { afterRequestId: cursor } : {}),
      });
      collected.push(...result.logs.map((log) => log.request_id));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    // Complete (all 7), no duplicates, ordered newest-first with the id
    // tie-break on the equal-timestamp pair.
    expect(collected).toHaveLength(7);
    expect(new Set(collected).size).toBe(7);
    const expectedTieOrder = [tieA, tieB].sort().reverse();
    expect(collected.slice(0, 2)).toEqual(expectedTieOrder);
    expect(collected.slice(2)).toEqual([...inserted].reverse());
    // An unknown cursor yields an empty page, never an error or a full scan.
    expect(
      (await decisions.query({ experimentId, limit: 2, afterRequestId: randomUUID() })).logs,
    ).toEqual([]);
  });
});

describe.skipIf(!DB_URL)('WS-I serving-path reads on the WS-E/WS-F Drizzle adapters', () => {
  let db: ReturnType<typeof createDbClient>;
  let invariantStore: DrizzleInvariantOutputStore;
  let safetyStore: DrizzleItemSafetyStateStore;
  let stories: DrizzleStoryStore;
  let submitterId: string;
  const safetyItemIds: string[] = [];
  // The invariant_outputs type vocabulary is a CLOSED db CHECK — synthetic
  // types are impossible. The gate-read test uses the real 'GWEI' type with
  // UNIQUE target ids and scopes every assertion to them (parallel gated
  // suites share the live database).
  const gweiTargetIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    invariantStore = new DrizzleInvariantOutputStore(db);
    safetyStore = new DrizzleItemSafetyStateStore(db);
    stories = new DrizzleStoryStore(db);
    const { users } = await import('@licio/db');
    const inserted = await db
      .insert(users)
      .values({
        handle: `wsiapi_${randomUUID().slice(0, 8)}`,
        displayName: 'WS-I API Integration',
        email: null,
        ageBandIfKnown: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
        reputationSummaryPrivate: emptyReputationSummary(),
      })
      .returning();
    submitterId = (inserted[0] as { userId: string }).userId;
  });

  afterAll(async () => {
    const dbSchema = await import('@licio/db');
    const { inArray, sql } = await import('drizzle-orm');
    if (gweiTargetIds.length > 0) {
      await db
        .delete(dbSchema.invariantOutputs)
        .where(inArray(dbSchema.invariantOutputs.targetId, gweiTargetIds));
    }
    if (safetyItemIds.length > 0) {
      await db
        .delete(dbSchema.itemSafetyStates)
        .where(inArray(dbSchema.itemSafetyStates.itemId, safetyItemIds));
    }
    const storyIds = (
      await db
        .select({ id: dbSchema.stories.storyId })
        .from(dbSchema.stories)
        .where(sql`${dbSchema.stories.submittedBy} = ${submitterId}`)
    ).map((r) => r.id);
    if (storyIds.length > 0) {
      await db.delete(dbSchema.threads).where(inArray(dbSchema.threads.storyId, storyIds));
      await db.delete(dbSchema.stories).where(inArray(dbSchema.stories.storyId, storyIds));
    }
    await db.delete(dbSchema.users).where(sql`${dbSchema.users.userId} = ${submitterId}`);
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  it('listByTypeSince windows on created_at, newest first, capped (the GWEI gate read)', async () => {
    const row = (offsetHours: number, gw2: number) => {
      const targetId = randomUUID();
      gweiTargetIds.push(targetId);
      return {
        invariantType: 'GWEI',
        targetType: 'cohort',
        targetId,
        timeWindow: { start: '2026-06-10T00:00:00.000Z', end: '2026-06-10T01:00:00.000Z' },
        version: '1.0.0',
        scoreVector: { gw2 },
        explanationSummary: null,
        confidence: 1,
        coverage: 1,
        reasonCodes: [],
        fallbackUsed: false,
        versionMetadata: null,
        shadowMode: true,
        createdAt: new Date(Date.now() - offsetHours * 3_600_000).toISOString(),
      };
    };
    await invariantStore.upsert(row(48, 0.9)); // outside a 24h window
    await invariantStore.upsert(row(2, 0.2));
    await invariantStore.upsert(row(1, 0.3));
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    // Assertions scope to THIS suite's target ids: other gated suites may
    // write GWEI rows into the same live table concurrently.
    const mine = (rows: Awaited<ReturnType<typeof invariantStore.listByTypeSince>>) =>
      rows.filter((r) => gweiTargetIds.includes(r.targetId));
    const recent = mine(await invariantStore.listByTypeSince('GWEI', since, 500));
    expect(recent).toHaveLength(2); // the 48h-old row is outside the window
    expect(recent.map((r) => r.scoreVector['gw2'])).toEqual([0.3, 0.2]); // newest first
    const capped = await invariantStore.listByTypeSince('GWEI', since, 1);
    expect(capped.length).toBeLessThanOrEqual(1);
  });

  it('safety getMany returns one bulk map (the batched safety-filter read)', async () => {
    const frozen = randomUUID();
    const removed = randomUUID();
    // case_id is a uuid COLUMN (the WS-J case reference) — opaque strings
    // are rejected at the storage layer.
    const frozenCase = randomUUID();
    const removedCase = randomUUID();
    safetyItemIds.push(frozen, removed);
    await safetyStore.set({
      itemId: frozen,
      safetyState: 'frozen',
      frozenScore: 0.4,
      caseId: frozenCase,
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    });
    await safetyStore.set({
      itemId: removed,
      safetyState: 'removed',
      frozenScore: null,
      caseId: removedCase,
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    });
    const many = await safetyStore.getMany([frozen, removed, randomUUID()]);
    expect(many.size).toBe(2);
    expect(many.get(frozen)?.safetyState).toBe('frozen');
    expect(many.get(removed)?.caseId).toBe(removedCase);
    expect(await safetyStore.getMany([])).toEqual(new Map());
  });

  it('story getByIds + getThreadsByStoryIds are single bulk reads (feed mapping)', async () => {
    const ids: string[] = [];
    const threadIds = new Map<string, string>();
    for (let i = 0; i < 3; i += 1) {
      const storyId = randomUUID();
      const threadId = randomUUID();
      ids.push(storyId);
      threadIds.set(storyId, threadId);
      const outcome = await stories.createWithThread(
        {
          storyId,
          canonicalUrl: null,
          title: `Bulk-read story ${i} about the reservoir audit`,
          titleHash: randomUUID().replaceAll('-', ''),
          submittedBy: submitterId,
          sourceId: null,
          language: 'en',
          topicIds: [randomUUID()],
          locationScope: null,
          sensitivityLabels: ['none'],
          lifecycleState: 'submitted',
          submissionType: 'original_brief',
          submissionMetadata: {
            submission_type: 'original_brief',
            body: 'The reservoir audit results were published this week.',
          } as never,
          excerpt: 'The reservoir audit results were published this week.',
          publisher: null,
          author: null,
          publishedAt: null,
          mediaType: null,
          extractionState: 'not_applicable',
          hiddenState: null,
        },
        threadId,
      );
      expect(outcome.ok).toBe(true);
    }
    const byId = await stories.getByIds([...ids, randomUUID()]);
    expect(byId.size).toBe(3);
    expect(byId.get(ids[0] as string)?.storyId).toBe(ids[0]);
    const threads = await stories.getThreadsByStoryIds(ids);
    expect(threads.size).toBe(3);
    for (const storyId of ids) {
      expect(threads.get(storyId)?.threadId).toBe(threadIds.get(storyId));
    }
    expect(await stories.getByIds([])).toEqual(new Map());
  });
});
