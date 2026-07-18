// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I branch-level acceptance for the paths the main suites reach only one
// way: the in-memory decision-log query dimensions, every config key branch,
// the feature-assembly joins (MERI gains/rank, redundancy hook, tropical,
// near-dup clusters, source reliability), the per-user PHI/GWEI service
// helpers, scheduler lease behavior, and the feed-mapping variants.

import { randomUUID } from 'node:crypto';
import {
  FEATURE_SCHEMA_VERSION,
  type FeatureVector,
  rankingDecisionLogSchema,
  retentionDeadline,
} from '@licio/ranking';
import { COMMONS_ROOM_ID, topicIdForSlug } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingestAttentionEvents } from '../events/ingest.js';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { signatureStory } from '../ingestion/dedup.js';
import { phiSessionTargetId } from '../invariants/services.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import { deterministicEventId } from '../pwatt/scoring.js';
import { loadRankingRuntimeConfig } from '../ranking/config.js';
import { assembleFeatureVector } from '../ranking/features.js';
import { runRankingTick, startRankingScheduler } from '../ranking/scheduler.js';
import { serveFeed } from '../ranking/service.js';
import type { FeatureStore } from '../ranking/stores.js';
import { InMemoryDecisionLogStore } from '../ranking/stores.js';
import { attentionEvent, seedUserWithSession } from './event-test-helpers.js';
import {
  freshRankingServices,
  type RankingFixture,
  seedInvariantOutput,
  seedStory,
} from './ranking-helpers.js';

let fixture: RankingFixture;

beforeEach(() => {
  fixture = freshRankingServices();
});

function featureDeps() {
  return {
    events: fixture.events,
    ingestion: fixture.ingestion,
    invariants: fixture.invariants,
    forum: fixture.forum,
    featureStore: fixture.ranking.featureStore,
    log: fixture.ranking.log,
    now: fixture.ranking.now,
  };
}

function decisionLog(overrides: Partial<Parameters<typeof rankingDecisionLogSchema.parse>[0]>) {
  const timestamp = new Date().toISOString();
  return rankingDecisionLogSchema.parse({
    request_id: randomUUID(),
    surface: 'front_page',
    user_privacy_bucket: 'anonymous',
    candidate_ids: [],
    selected_ids: [],
    score_components: {},
    feature_revisions: {},
    invariant_versions: {},
    constraints_applied: [],
    safety_exclusions: [],
    quota_outcomes: [],
    explanation_ids: {},
    experiment_ids: [],
    timestamp,
    profile_id: 'evergreen',
    profile_version: '1.0.0',
    feature_version: 1,
    fallback: true,
    fallback_reason: 'kill_switch',
    replay_inputs: null,
    retain_until: retentionDeadline(timestamp, 180),
    ...overrides,
  });
}

describe('in-memory decision-log store (WS-I.2.5a/c)', () => {
  it('filters on every audit dimension, paginates, sweeps, and counts', async () => {
    const store = new InMemoryDecisionLogStore();
    const itemA = randomUUID();
    const t1 = new Date(Date.now() - 60_000).toISOString();
    const t2 = new Date().toISOString();
    const first = decisionLog({
      timestamp: t1,
      user_privacy_bucket: 'bucket:aa',
      candidate_ids: [itemA],
      invariant_versions: {
        MFCI: { version_string: '2.0.0', computation_timestamp: t1, config_hash: 'cafe' },
      },
      constraints_applied: [
        {
          constraint: 'scoi_context_required',
          item_id: itemA,
          threshold: 'medium',
          actual: 'medium',
          action: 'context_card',
          enforced: true,
        },
      ],
      experiment_ids: ['exp-9'],
      retain_until: retentionDeadline(t1, 180),
    });
    const second = decisionLog({ timestamp: t2 });
    await store.insert(first);
    await store.insert(second);
    await expect(store.insert(first)).rejects.toThrow(/duplicate/);

    expect((await store.query({ itemId: itemA, limit: 10 })).logs).toHaveLength(1);
    expect((await store.query({ userPrivacyBucket: 'bucket:aa', limit: 10 })).logs).toHaveLength(1);
    expect(
      (await store.query({ invariantName: 'MFCI', invariantVersion: '2.0.0', limit: 10 })).logs,
    ).toHaveLength(1);
    expect(
      (await store.query({ invariantName: 'MFCI', invariantVersion: '9.9.9', limit: 10 })).logs,
    ).toHaveLength(0);
    expect(
      (await store.query({ constraint: 'scoi_context_required', limit: 10 })).logs,
    ).toHaveLength(1);
    expect((await store.query({ experimentId: 'exp-9', limit: 10 })).logs).toHaveLength(1);
    expect((await store.query({ fromIso: t2, limit: 10 })).logs.map((l) => l.request_id)).toEqual([
      second.request_id,
    ]);
    expect((await store.query({ toIso: t2, limit: 10 })).logs.map((l) => l.request_id)).toEqual([
      first.request_id,
    ]);

    // Keyset pagination: newest first, cursor continues.
    const page1 = await store.query({ limit: 1 });
    expect(page1.logs[0]?.request_id).toBe(second.request_id);
    expect(page1.nextCursor).toBe(second.request_id);
    const page2 = await store.query({ limit: 1, afterRequestId: page1.nextCursor as string });
    expect(page2.logs[0]?.request_id).toBe(first.request_id);
    expect(page2.nextCursor).toBeNull();

    expect(await store.count()).toBe(2);
    const removed = await store.sweepExpired(
      new Date(Date.now() + 366 * 24 * 3_600_000).toISOString(),
    );
    expect(removed).toBe(2);
    expect(await store.count()).toBe(0);
  });
});

describe('runtime config branches (fail-closed per key)', () => {
  it('applies each valid scalar independently and rejects invalid profile sets', async () => {
    await fixture.events.configStore.set('ranking.scalars', {
      feature_batch_limit: 33,
      feature_stale_hours: 12,
    });
    await fixture.events.configStore.set('ranking.profiles', { profiles: [{ broken: true }] });
    const config = await loadRankingRuntimeConfig(fixture.events);
    expect(config.featureBatchLimit).toBe(33);
    expect(config.featureStaleHours).toBe(12);
    // Invalid stored profile set ⇒ the SHIPPED set stays in force.
    expect(config.profiles.map((p) => p.profile_id).sort()).toEqual(['breaking_news', 'evergreen']);
  });
});

describe('feature assembly joins (the remaining WS-I.2.1a sources)', () => {
  it('joins MERI gains + rank, the redundancy hook, tropical, and near-dup clusters', async () => {
    const { storyId } = await seedStory(fixture.ingestion, { topicIds: ['water'] });
    const other = await seedStory(fixture.ingestion, { topicIds: ['water'] });
    // MERI: the global feed-target row with per-story marginal gains.
    await seedInvariantOutput(fixture.events, {
      invariantType: 'MERI',
      targetId: GLOBAL_FEED_TARGET_ID,
      targetType: 'feed',
      scoreVector: {
        meri: 0.8,
        marginal_gains: { [storyId]: 0.25, [other.storyId]: 0.75 },
      },
    });
    // WS-E redundancy hook (MERI-maintained).
    fixture.events.hooks.redundancy = (itemId) => (itemId === storyId ? 0.6 : 0);
    // Tropical: a DETECTED per-topic cascade.
    await seedInvariantOutput(fixture.events, {
      invariantType: 'tropical_cascade',
      targetId: deterministicEventId('tropical:water'),
      targetType: 'story',
      scoreVector: { synchronized_fraction: 0.4, detected: true },
    });
    // Near-duplicate signatures: both stories share text ⇒ one cluster.
    await signatureStory(
      fixture.ingestion.signatures,
      storyId,
      'identical near duplicate body text for clustering purposes in this test',
      'submitted',
    );
    await signatureStory(
      fixture.ingestion.signatures,
      other.storyId,
      'identical near duplicate body text for clustering purposes in this test',
      'submitted',
    );
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    expect(vector?.exposure_independence).toBe(0.25);
    expect(vector?.meri_rank).toBe(2); // second-highest gain
    expect(vector?.redundancy_penalty).toBe(0.6);
    expect(vector?.tropical_cascade_rank).toBe(0.4);
    expect(vector?.invariant_versions['MERI']).toBeDefined();
    expect(vector?.invariant_versions['tropical_cascade']).toBeDefined();
    const cluster = [storyId, other.storyId].sort()[0];
    expect(vector?.duplicate_cluster_id).toBe(cluster);
  });

  it('UNDETECTED tropical rows and absent stories contribute nothing', async () => {
    expect(await assembleFeatureVector(featureDeps(), randomUUID())).toBeNull();
    const { storyId } = await seedStory(fixture.ingestion, { topicIds: ['calm'] });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'tropical_cascade',
      targetId: deterministicEventId('tropical:calm'),
      targetType: 'story',
      scoreVector: { synchronized_fraction: 0.9, detected: false },
    });
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    expect(vector?.tropical_cascade_rank).toBeUndefined();
  });

  it('source reliability flows from the source profile history', async () => {
    const source = await fixture.ingestion.sources.upsertByDomain('example.org', {
      name: 'Example',
    });
    await fixture.ingestion.sources.appendCorrection(source.sourceId, {
      correction_id: randomUUID(),
      summary: 'Corrected a date',
      acknowledged: true,
      created_at: new Date().toISOString(),
    } as never);
    const { storyId } = await seedStory(fixture.ingestion, { sourceId: source.sourceId });
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    expect(vector?.source_reliability).toBeGreaterThan(0);
    expect(vector?.source_reliability).toBeLessThanOrEqual(1);
  });
});

describe('per-user service helpers', () => {
  it('userPhiRisk reads the user’s own latest PHI output via the shared digest', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    expect(await fixture.ranking.userPhiRisk(userId)).toBeNull();
    const storyId = (await seedStory(fixture.ingestion)).storyId;
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [attentionEvent(userId, { storyId, timestamp: new Date().toISOString() })],
      { maxPastMs: Number.MAX_SAFE_INTEGER, maxFutureMs: Number.MAX_SAFE_INTEGER },
    );
    const aggregates = await fixture.events.attentionStore.listByUser(userId);
    const sessionBucket = aggregates[0]?.session_bucket as string;
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PHI',
      targetId: phiSessionTargetId(userId, sessionBucket),
      targetType: 'session',
      scoreVector: { phi: 1.7 },
    });
    expect(await fixture.ranking.userPhiRisk(userId)).toBe(1.7);
  });

  it('latestGweiDisparity takes the max gw2 over GWEI rows; null without any', async () => {
    expect(await fixture.ranking.latestGweiDisparity()).toBeNull();
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.1 },
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.3 },
    });
    expect(await fixture.ranking.latestGweiDisparity()).toBe(0.3);
  });

  it('privacy buckets are coarse, stable, and never identifiers', () => {
    expect(fixture.ranking.privacyBucket(null)).toBe('anonymous');
    const userId = randomUUID();
    const bucket = fixture.ranking.privacyBucket(userId);
    expect(bucket).toMatch(/^bucket:[0-9a-f]{2}$/);
    expect(fixture.ranking.privacyBucket(userId)).toBe(bucket);
  });

  it('userContext degrades honestly for anonymous and unknown users', async () => {
    const anonymous = await fixture.ranking.userContext(null);
    expect(anonymous.personalizationEnabled).toBe(false);
    const unknown = await fixture.ranking.userContext(randomUUID());
    expect(unknown.ageBand).toBeNull();
    expect(unknown.topicPreferences).toEqual([]);
  });

  it('userContext resolves stored preference SLUGS to catalog UUIDs (WS-I personalization)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity, { handle: 'prefuser' });
    const user = await fixture.identity.store.getUser(userId);
    if (user === null) throw new Error('seed failed');
    // A preference saved as the public slug must match a story's catalog-UUID
    // topic in topicRelevance, so it is resolved to the UUID here.
    await fixture.identity.store.updateUser(userId, {
      personalizationSettings: {
        ...user.personalizationSettings,
        topic_preferences: ['technology'],
      },
    });
    const ctx = await fixture.ranking.userContext(userId);
    expect(ctx.topicPreferences).toEqual([topicIdForSlug('technology')]);
  });

  it('enforcement reflects WS-H promotions (default all-shadow)', async () => {
    const shadow = await fixture.ranking.enforcement();
    expect(Object.values(shadow).every((flag) => flag === false)).toBe(true);
  });
});

describe('scheduler lease behavior', () => {
  it('runs the tick only while holding the lease; stop() clears the timer', async () => {
    const acquisitions: boolean[] = [true, false];
    const lease: JobLeaseStore = {
      tryAcquire: async () => acquisitions.shift() ?? false,
    };
    let ticks = 0;
    const counting = {
      ...fixture.ranking,
      reloadConfig: async () => {
        ticks += 1;
        return fixture.ranking.config();
      },
    };
    const stop = startRankingScheduler(counting as typeof fixture.ranking, () => {}, 5, {
      lease,
      holder: 'test-holder',
    });
    // Poll with a generous deadline (interval timers lag under load).
    const deadline = Date.now() + 5_000;
    while (ticks < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stop();
    const after = ticks;
    expect(after).toBeGreaterThanOrEqual(1); // ran while leased
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ticks).toBe(after); // stopped cleanly
  });

  it('a lease-store failure is reported as task=lease and skips the tick (fail closed)', async () => {
    const lease: JobLeaseStore = {
      tryAcquire: async () => {
        throw new Error('lease store down');
      },
    };
    let ticks = 0;
    const counting = {
      ...fixture.ranking,
      reloadConfig: async () => {
        ticks += 1;
        return fixture.ranking.config();
      },
    };
    const failures: string[] = [];
    const stop = startRankingScheduler(
      counting as typeof fixture.ranking,
      (_err, task) => failures.push(task),
      5,
      { lease, holder: 'test-holder' },
    );
    const deadline = Date.now() + 5_000;
    while (failures.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stop();
    // Reported through onError (never an unhandled rejection from the timer);
    // the tick body never ran.
    expect(failures[0]).toBe('lease');
    expect(ticks).toBe(0);
  });

  it('the replay-regression sample flags mismatches as metrics', async () => {
    // A clearly nonzero age: at age 0 every decay curve gives freshness
    // exactly 1, so a tampered curve would (correctly) replay to a match.
    await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    if (log === null || log.replay_inputs === null) throw new Error('expected a ranked log');
    // Tamper a copy so the sampled replay disagrees.
    await fixture.ranking.decisionLogs.insert({
      ...log,
      request_id: randomUUID(),
      replay_inputs: {
        ...log.replay_inputs,
        profile_snapshot: {
          ...log.replay_inputs.profile_snapshot,
          decay_curves: {
            breaking: { half_life_hours: 0.01 },
            evergreen: { half_life_hours: 0.01 },
          },
        },
      },
    });
    await runRankingTick(fixture.ranking, () => {});
    expect(
      fixture.events.metrics.counter('ranking.replay.regression_mismatch'),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('replay + serving edge branches', () => {
  it('replay reports unavailable feature revisions (past retention)', async () => {
    await seedStory(fixture.ingestion);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    // Drop the feature store (simulating revision retention expiry).
    await fixture.ranking.featureStore.clear();
    const { replayDecision } = await import('../ranking/service.js');
    const result = await replayDecision(fixture.ranking, served.requestId);
    expect(result.match).toBe(false);
    expect(result.problems.some((p) => p.includes('feature revision unavailable'))).toBe(true);
  });

  it('fallback replay flags structural violations (selection outside the pool)', async () => {
    const timestamp = new Date().toISOString();
    const ghost = randomUUID();
    const log = decisionLog({
      timestamp,
      candidate_ids: [randomUUID()],
      selected_ids: [ghost, ghost],
      retain_until: retentionDeadline(timestamp, 180),
    });
    await fixture.ranking.decisionLogs.insert(log);
    const { replayDecision } = await import('../ranking/service.js');
    const result = await replayDecision(fixture.ranking, log.request_id);
    expect(result.match).toBe(false);
    expect(result.problems.some((p) => p.includes('selected outside the pool'))).toBe(true);
    expect(result.problems.some((p) => p.includes('duplicate selection'))).toBe(true);
  });

  it('a failed decision-log write is an incident, never a serving failure', async () => {
    await seedStory(fixture.ingestion);
    const failing = {
      ...fixture.ranking,
      decisionLogs: {
        ...fixture.ranking.decisionLogs,
        insert: async () => {
          throw new Error('log store outage');
        },
      },
    };
    const served = await serveFeed(failing as typeof fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.items.length).toBeGreaterThan(0); // the feed still served
    expect(
      fixture.events.metrics.counter('ranking.decision_log.write_failed'),
    ).toBeGreaterThanOrEqual(1);
  });

  it('an all-excluded pool serves the honest empty fallback', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    await fixture.events.safetyStore.set({
      itemId: storyId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: null,
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    });
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.fallback).toBe(true);
    expect(served.items).toEqual([]);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('empty_pool');
  });

  it('a steward hold and a jurisdiction restriction exclude through the seam', async () => {
    const { applySafetyFilter } = await import('../ranking/safety-filter.js');
    const candidate = {
      item_id: randomUUID(),
      item_type: 'story' as const,
      source_type: 'global' as const,
      room_id: null,
      visibility: 'public' as const,
      topic_ids: [],
      source_id: null,
      freshness_timestamp: new Date().toISOString(),
      retrieval_score: 0.5,
      retrieval_origins: ['global_pwatt_v1'],
      bridge_context: null,
    };
    const held = await applySafetyFilter(
      [candidate],
      {
        itemPolicyStates: async (ids) =>
          new Map(
            ids.map((id) => [
              id,
              {
                removed: false,
                removalReason: null,
                moderationCaseRef: 'hold-1',
                sensitivityLabels: [],
                legallyRestrictedIn: [],
                stewardHold: true,
              },
            ]),
          ),
      },
      { ageBand: 'adult', jurisdiction: null },
    );
    expect(held.exclusions[0]?.policy_reason).toBe('steward_hold');
    const restricted = await applySafetyFilter(
      [candidate],
      {
        itemPolicyStates: async (ids) =>
          new Map(
            ids.map((id) => [
              id,
              {
                removed: false,
                removalReason: null,
                moderationCaseRef: null,
                sensitivityLabels: [],
                legallyRestrictedIn: ['DE'],
                stewardHold: false,
              },
            ]),
          ),
      },
      { ageBand: 'adult', jurisdiction: 'DE' },
    );
    expect(restricted.exclusions[0]?.policy_reason).toBe('jurisdiction_restricted');
  });

  it('a throwing config store reads as an ENGAGED kill switch (fail closed)', async () => {
    const { killSwitchDecision } = await import('../ranking/killswitch.js');
    const throwing = {
      ...fixture.events,
      configStore: {
        ...fixture.events.configStore,
        get: async () => {
          throw new Error('config store outage');
        },
      },
    };
    const decision = await killSwitchDecision(
      throwing as typeof fixture.events,
      'front_page',
      'evergreen',
    );
    expect(decision).toEqual({ engaged: true, scope: 'unreadable_state' });
  });

  it('feature-store staleness listing orders oldest first and respects the cap', async () => {
    const a = await seedStory(fixture.ingestion);
    const b = await seedStory(fixture.ingestion);
    const deps = featureDeps();
    const va = await assembleFeatureVector(deps, a.storyId);
    const vb = await assembleFeatureVector(deps, b.storyId);
    if (va === null || vb === null) throw new Error('assembly failed');
    await fixture.ranking.featureStore.upsert({
      ...va,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    await fixture.ranking.featureStore.upsert({
      ...vb,
      updated_at: '2026-01-02T00:00:00.000Z',
    });
    const horizon = '2026-02-01T00:00:00.000Z';
    expect(await fixture.ranking.featureStore.listStaleItems(horizon, 10)).toEqual([
      a.storyId,
      b.storyId,
    ]);
    expect(await fixture.ranking.featureStore.listStaleItems(horizon, 1)).toEqual([a.storyId]);
    expect(await fixture.ranking.featureStore.getRevision(a.storyId, 99)).toBeNull();
  });

  it('rebuilds a stale-schema feature row before scoring it (WS-I.2.1d)', async () => {
    const { storyId } = await seedStory(fixture.ingestion, { topicIds: ['realtopic'] });
    const real = fixture.ranking.featureStore;
    // A row persisted before a FEATURE_SCHEMA_VERSION bump: version 1, a
    // pre-catalog topic id, no sensitivity_labels. `upsert` rejects it (the
    // schema literal), so inject it only through getLatestMany on the first serve.
    const staleRow = {
      item_id: storyId,
      item_type: 'story',
      room_id: COMMONS_ROOM_ID,
      visibility: 'public',
      topic_ids: ['stale-random-topic'],
      source_id: null,
      created_at: new Date().toISOString(),
      feature_version: 1,
      revision: 0,
      invariant_versions: {},
      updated_at: new Date().toISOString(),
    } as unknown as FeatureVector;
    let serveCount = 0;
    const staleStore: FeatureStore = {
      upsert: (v) => real.upsert(v),
      getLatest: (id) => real.getLatest(id),
      getRevision: (id, r) => real.getRevision(id, r),
      getAt: (id, t) => real.getAt(id, t),
      listStaleItems: (b, l) => real.listStaleItems(b, l),
      clear: () => real.clear(),
      getLatestMany: async (ids) => {
        serveCount += 1;
        if (serveCount === 1) return new Map([[storyId, staleRow]]);
        return real.getLatestMany(ids);
      },
    };
    await serveFeed(
      { ...fixture.ranking, featureStore: staleStore },
      {
        userId: null,
        surface: 'front_page',
        surfaceRoomId: null,
        surfaceTopicId: null,
        mode: undefined,
      },
    );
    // The staleness guard rebuilt the row at the current schema in the REAL store
    // — scoring never ran on the v1 field set.
    const rebuilt = await real.getLatest(storyId);
    expect(rebuilt?.feature_version).toBe(FEATURE_SCHEMA_VERSION);
    expect(rebuilt?.topic_ids).not.toContain('stale-random-topic');
  });
});

describe('admin route edge branches', () => {
  it('serves decision detail, 404s unknown ids on detail + replay, reads the switch', async () => {
    const { createV1Routes } = await import('../routes/v1.js');
    const { Hono } = await import('hono');
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const app = new Hono().route('/v1', createV1Routes());
    await seedStory(fixture.ingestion);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const detail = await app.request(`/v1/ranking/admin/decisions/${served.requestId}`, {
      headers: { cookie: steward.cookie },
    });
    expect(detail.status).toBe(200);
    expect(
      ((await detail.json()) as { decision: { request_id: string } }).decision.request_id,
    ).toBe(served.requestId);
    const missingDetail = await app.request(`/v1/ranking/admin/decisions/${randomUUID()}`, {
      headers: { cookie: steward.cookie },
    });
    expect(missingDetail.status).toBe(404);
    const missingReplay = await app.request(`/v1/ranking/admin/replay/${randomUUID()}`, {
      method: 'POST',
      headers: { cookie: steward.cookie },
    });
    expect(missingReplay.status).toBe(404);
    const switchState = await app.request('/v1/ranking/admin/killswitch', {
      headers: { cookie: steward.cookie },
    });
    expect(switchState.status).toBe(200);
    expect(((await switchState.json()) as { state: unknown }).state).toBeNull();
  });

  it('the lazy test-fallback getter composes singletons once', async () => {
    const { getRankingServices, resetRankingServices, setRankingServices } = await import(
      '../ranking/services.js'
    );
    resetRankingServices();
    const lazy = getRankingServices();
    expect(lazy.retrievers.origins()).toHaveLength(8);
    expect(getRankingServices()).toBe(lazy);
    // Restore the fixture singleton for the rest of the suite.
    setRankingServices(fixture.ranking);
  });
});

describe('remaining retrieval branches', () => {
  it('expert explanations also surface expert-led ROOM threads', async () => {
    const { ExpertExplanationsRetriever } = await import('../ranking/retrievers.js');
    const { createCandidateDataPorts } = await import('../ranking/services.js');
    const roomId = randomUUID();
    await fixture.forum.rooms.insert({
      roomId,
      name: 'Hydrology experts',
      slug: 'hydrology-experts',
      description: null,
      roomType: 'professional_domain',
      // WS-Q — the successor to legacy expert_led on the front page is a PUBLIC
      // room with the experts_and_stewards posting policy.
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'experts_and_stewards',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    const inRoom = await seedStory(fixture.ingestion, { roomId });
    await seedStory(fixture.ingestion); // not expert-led, no summary
    const retriever = new ExpertExplanationsRetriever(
      createCandidateDataPorts(fixture.events, fixture.ingestion, fixture.forum, fixture.identity),
    );
    const candidates = await retriever.retrieve({
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      nowMs: Date.now(),
      limit: 10,
    });
    expect(candidates.map((c) => c.item_id)).toEqual([inRoom.storyId]);
    expect(candidates[0]?.source_type).toBe('expert_explanation');
  });

  it('the orchestrator classifies syndication copies as non-independent (cached)', async () => {
    const { assembleCandidatePool } = await import('../ranking/orchestrator.js');
    const { EVERGREEN_PROFILE } = await import('@licio/ranking');
    const sourceId = randomUUID();
    await seedStory(fixture.ingestion, { sourceId });
    await seedStory(fixture.ingestion, { sourceId });
    let lookups = 0;
    const result = await assembleCandidatePool(
      fixture.ranking.retrievers,
      {
        seenSourceIds: async () => new Set([sourceId]),
        isSyndicationCopy: async () => {
          lookups += 1;
          return true;
        },
      },
      EVERGREEN_PROFILE,
      { userId: null, surface: 'front_page', surfaceRoomId: null, nowMs: Date.now(), limit: 20 },
      () => {},
      'anonymous',
    );
    expect(result.pool).toHaveLength(2);
    expect(lookups).toBe(1); // one lookup per source, cached
    const independent = result.quotaOutcomes.find((q) => q.quota_type === 'independent');
    expect(independent?.shortfall).toBe(true); // every candidate is a copy
    const fresh = result.quotaOutcomes.find((q) => q.quota_type === 'fresh');
    expect(fresh?.shortfall).toBe(true); // the user has seen the source
  });
});

describe('feed mapping variants', () => {
  it('frozen items surface as under-review; room lenses no longer become a card chip', async () => {
    const roomId = randomUUID();
    await fixture.forum.rooms.insert({
      roomId,
      name: 'Lens room',
      slug: 'lens-room',
      description: null,
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    for (const lensType of ['local_resident', 'expert'] as const) {
      await fixture.forum.lenses.insert({
        lensId: randomUUID(),
        roomId,
        name: lensType,
        lensType,
        description: null,
      });
    }
    const { storyId } = await seedStory(fixture.ingestion, { roomId });
    await fixture.events.safetyStore.set({
      itemId: storyId,
      safetyState: 'frozen',
      frozenScore: 0.4,
      caseId: null,
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    });
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const item = served.items.find((i) => i.story_id === storyId);
    expect(item?.safety_state).toBe('under-review');
    // The "N lenses" chip was removed from story cards: a room's lens count is
    // still used for WS-I.2.4b lens balancing, but it is no longer surfaced as a
    // per-card chip.
    expect(item?.context_chips.some((c) => c.id === 'lenses')).toBe(false);
    expect(item?.context_chips.some((c) => /lenses/.test(c.label))).toBe(false);
  });

  // The former `source-diverse` balancing override and `local` quota boost
  // were removed with the sort-mode redesign; the legacy wire values now
  // normalize to the ranked pipeline — see ranking-sort-modes.test.ts.
});
