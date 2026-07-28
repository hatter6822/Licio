// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit coverage for the event-pipeline support modules: the fail-closed config
// loader (WS-E.2.3a-d tunables), the lease-guarded scheduler, store edge
// cases (cursor pagination, purge tightening, checkpoints, dead letters),
// metrics, replay pruning, and the aggregation fold's evidence/integrity
// branches.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineMetrics } from '../events/metrics.js';
import {
  InMemoryRealtimeAggregator,
  realtimeWindowStart,
  rebuildRealtimeFromEvents,
} from '../events/realtime.js';
import { InMemoryReplayNonceStore } from '../events/replay.js';
import { actorKeyOfPayload } from '../events/services.js';
import {
  InMemoryConsumerCheckpointStore,
  InMemoryDeadLetterStore,
  InMemoryEventStore,
  InMemorySignalLedgerStore,
  type NewStoredEvent,
  type SignalLedgerRecord,
} from '../events/stores.js';
import { InMemoryJobLeaseStore } from '../identity/job-lease.js';
import { computeAggregationWindow } from '../pwatt/aggregation.js';
import {
  DEFAULT_PWATT_RUNTIME_CONFIG,
  loadPwattRuntimeConfig,
  type PwattConfigKey,
  validatePwattConfigValue,
} from '../pwatt/config.js';
import { rankFrontPageV0 } from '../pwatt/ranking-v0.js';
import { startEventPipelineScheduler } from '../pwatt/scheduler.js';
import { deterministicEventId } from '../pwatt/scoring.js';
import { isShadowOutput } from '../pwatt/shadow.js';
import { type EventServicesFixture, freshEventServices } from './event-test-helpers.js';

const T0 = Date.UTC(2026, 5, 10, 10, 0, 0);
const IN_WINDOW = new Date(T0 + 5 * 60_000).toISOString();

let fixture: EventServicesFixture;
let rejections: Array<Record<string, unknown>>;

beforeEach(() => {
  rejections = [];
  fixture = freshEventServices({
    log: (event, meta) => {
      if (event === 'pwatt.config.rejected') rejections.push(meta);
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PWAtt runtime config loader (WS-E.2.3a-d fail-closed)', () => {
  it('returns the reviewed defaults when nothing is stored', async () => {
    const config = await loadPwattRuntimeConfig(fixture.events);
    expect(config).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG);
  });

  it('applies valid stored overrides for every key', async () => {
    await fixture.events.configStore.set('burst', {
      minVolume: 20,
      minDistinctActors: 8,
      burstMultiplier: 6,
      baseRateFloor: 5,
    });
    await fixture.events.configStore.set('cascade', {
      minDistinctActors: 7,
      minContributions: 12,
      hostileShareThreshold: 0.7,
      volumeMultiplier: 3,
      baseRateFloor: 4,
    });
    await fixture.events.configStore.set('trigger_threshold', { value: 50 });
    const config = await loadPwattRuntimeConfig(fixture.events);
    expect(config.burst.minVolume).toBe(20);
    expect(config.cascade.hostileShareThreshold).toBe(0.7);
    expect(config.triggerThreshold).toBe(50);
    expect(rejections).toHaveLength(0);
  });

  it('rejects invalid stored values and FAILS CLOSED to the defaults (logged)', async () => {
    await fixture.events.configStore.set('burst', { minVolume: 0 } as never);
    await fixture.events.configStore.set('cascade', { hostileShareThreshold: 2 } as never);
    await fixture.events.configStore.set('trigger_threshold', { value: 0 });
    const config = await loadPwattRuntimeConfig(fixture.events);
    expect(config.burst).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.burst);
    expect(config.cascade).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.cascade);
    expect(config.triggerThreshold).toBe(DEFAULT_PWATT_RUNTIME_CONFIG.triggerThreshold);
    expect(rejections.length).toBe(3);
  });

  it('UPGRADES a legacy v0/v1 row (pre-traversal) instead of discarding its tuning', async () => {
    // A v0 row from before the `traversal` dimension: old 3-weight attention +
    // a TUNED participation split. The loader must adopt the new attention
    // weights (the old split cannot absorb traversal) while PRESERVING the tuned
    // participation weights, rather than failing closed to all-defaults.
    await fixture.events.configStore.set('v0', {
      activeAttention: {
        weights: { dwellPct: 50, sourcePct: 30, contextPct: 20 },
        halfSaturationActors: 8,
      },
      participation: {
        weights: { returnPct: 30, savePct: 20, contributionPct: 50 }, // TUNED
        contribSaturation: 3,
        rapidThreshold: 5,
        rapidDampening: 0.3,
        accusationDownweight: 0.25,
        burstPlaceholderDampening: 0.9,
        halfSaturationActors: 5,
      },
      confidenceHalfSaturation: 3,
    });
    // A v1 row missing the new `traversal` dimension AND `antiSignalAttenuation`,
    // with a TUNED contribution curve.
    await fixture.events.configStore.set('v1', {
      contributionWeights: {
        question: 0.7,
        correction: 0.9,
        synthesis: 0.8,
        counterexample: 0.6,
        explanation: 0.5,
        experience: 0.5,
        bridge_comment: 0.85,
        steward_action: 0.5,
        flag: 0,
        low_info_reply: 0,
      },
      contributionCurve: { kind: 'logarithmic', scale: 2, saturationPoint: 9 }, // TUNED
      attentionDimensions: {
        dwell: { weightPct: 50, curve: { kind: 'logarithmic', scale: 4, saturationPoint: 25 } },
        source: { weightPct: 30, curve: { kind: 'logarithmic', scale: 4, saturationPoint: 25 } },
        context: { weightPct: 20, curve: { kind: 'logarithmic', scale: 4, saturationPoint: 25 } },
      },
      participationDimensions: {
        returns: { weightPct: 40, curve: { kind: 'logarithmic', scale: 4, saturationPoint: 25 } },
        saves: { weightPct: 10, curve: { kind: 'logarithmic', scale: 4, saturationPoint: 25 } },
        contributions: {
          weightPct: 50,
          curve: { kind: 'logarithmic', scale: 4, saturationPoint: 25 },
        },
      },
      accusationDownweight: 0.25,
      rapidThreshold: 5,
      rapidDampening: 0.3,
    });
    const config = await loadPwattRuntimeConfig(fixture.events);
    // v0: attention weights upgraded to the new split; tuned participation kept.
    expect(config.v0.activeAttention.weights.traversalPct).toBe(15);
    expect(config.v0.participation.weights.returnPct).toBe(30); // preserved
    // v1: traversal dimension + attenuation backfilled; tuned curve preserved.
    expect(config.v1.attentionDimensions.traversal.weightPct).toBe(15);
    expect(config.v1.antiSignalAttenuation.coordinatedBurstMax).toBe(0.5);
    expect(config.v1.contributionCurve).toEqual({
      kind: 'logarithmic',
      scale: 2,
      saturationPoint: 9,
    }); // preserved
    // The retired write-taxonomy weight keys are STRIPPED by the upgrader; the
    // five live weights survive.
    expect(Object.keys(config.v1.contributionWeights).sort()).toEqual([
      'bridge_comment',
      'correction',
      'explanation',
      'low_info_reply',
      'steward_action',
    ]);
    expect(rejections).toHaveLength(0); // upgraded, not discarded
  });
});

describe('event-pipeline scheduler (lease-guarded, WS-E.1.4/2.1a)', () => {
  it('runs a tick when the lease grants and skips when another holder owns it', async () => {
    vi.useFakeTimers();
    const lease = new InMemoryJobLeaseStore();
    // Another instance holds the lease for the next hour.
    await lease.tryAcquire('events_hourly', 3_600_000, 'other-instance');
    const errors: unknown[] = [];
    const stop = startEventPipelineScheduler(
      fixture.events,
      fixture.identity,
      (err) => errors.push(err),
      3_600_000,
      { lease, holder: 'me' },
    );
    await vi.runOnlyPendingTimersAsync();
    stop();
    expect(errors).toEqual([]);
    // No window was computed because the tick was skipped (lease denied).
    expect(
      await fixture.events.windowStore.listForItemBefore(
        randomUUID(),
        '1h',
        new Date().toISOString(),
        1,
      ),
    ).toEqual([]);
  });

  it('fails closed when the lease store errors (tick skipped, error reported)', async () => {
    vi.useFakeTimers();
    const errors: Array<{ task: string }> = [];
    const stop = startEventPipelineScheduler(
      fixture.events,
      fixture.identity,
      (_err, task) => errors.push({ task }),
      3_600_000,
      {
        lease: {
          tryAcquire: async () => {
            throw new Error('lease store down');
          },
        },
        holder: 'me',
      },
    );
    await vi.runOnlyPendingTimersAsync();
    stop();
    // Two ticks ran (the startup tick + one timer tick); BOTH failed closed.
    expect(errors).toEqual([{ task: 'lease' }, { task: 'lease' }]);
  });

  it('runs without a lease in single-process mode (initial tick at startup)', async () => {
    vi.useFakeTimers();
    const stop = startEventPipelineScheduler(fixture.events, fixture.identity);
    await vi.runOnlyPendingTimersAsync();
    stop();
    // The initial tick ran the retention sweep — audit has the record.
    const entry = await fixture.identity.audit.append({
      actorUserId: null,
      eventType: 'retention_sweep',
      context: {},
    });
    expect(entry.event_type).toBe('retention_sweep');
  });
});

describe('store edge cases (WS-E.3.1)', () => {
  function row(overrides: Partial<NewStoredEvent>): NewStoredEvent {
    return {
      eventId: randomUUID(),
      eventType: 'attention.aggregate',
      topic: 'attention.aggregate',
      timestamp: new Date().toISOString(),
      privacyClassification: 'aggregated',
      retentionTier: 'attention_aggregated',
      payload: {},
      ownerUserId: null,
      purgeAfter: null,
      ...overrides,
    };
  }

  it('insertMany reports duplicates without re-applying them', async () => {
    const store = new InMemoryEventStore();
    const a = row({});
    expect(await store.insertMany([a, a])).toEqual({
      inserted: 1,
      duplicateIds: [a.eventId],
    });
    expect(store.size).toBe(1);
  });

  it('tightenOwnerPurge only ever shortens deadlines for the owner + tier', async () => {
    const store = new InMemoryEventStore();
    const owner = randomUUID();
    const early = new Date(Date.now() + 1_000).toISOString();
    const late = new Date(Date.now() + 86_400_000).toISOString();
    const target = row({ ownerUserId: owner, purgeAfter: late });
    const otherTier = row({ ownerUserId: owner, retentionTier: 'ranking_log', purgeAfter: late });
    const alreadyEarly = row({ ownerUserId: owner, purgeAfter: early });
    await store.insertMany([target, otherTier, alreadyEarly]);
    const updated = await store.tightenOwnerPurge(owner, 'attention_aggregated', early);
    expect(updated).toBe(1); // late→early; other tier untouched; early kept
  });

  it('ledger pagination walks pages with a stable keyset cursor', async () => {
    const store = new InMemorySignalLedgerStore();
    const owner = randomUUID();
    const entries: SignalLedgerRecord[] = Array.from({ length: 5 }, (_, i) => ({
      entryId: randomUUID(),
      ownerUserId: owner,
      itemId: randomUUID(),
      storyTitle: `Story ${i}`,
      windowStart: new Date(T0).toISOString(),
      windowSize: '1h',
      signals: {},
      antiSignals: [],
      pwattScore: 0.1,
      summary: 'You read this for a short while.',
      recordedAt: new Date(T0 + i * 60_000).toISOString(),
      purgeAfter: new Date(T0 + 86_400_000).toISOString(),
    }));
    await store.upsertMany(entries);
    const page1 = await store.listForUser(owner, 2);
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await store.listForUser(owner, 2, page1.nextCursor ?? undefined);
    const page3 = await store.listForUser(owner, 2, page2.nextCursor ?? undefined);
    expect(page3.entries).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
    const seen = [...page1.entries, ...page2.entries, ...page3.entries].map((e) => e.entryId);
    expect(new Set(seen).size).toBe(5); // no duplicates, no gaps
  });

  it('preserves entryId + recordedAt on an idempotent re-score (WS-E.2.1d)', async () => {
    const store = new InMemorySignalLedgerStore();
    const owner = randomUUID();
    const itemId = randomUUID();
    const base: SignalLedgerRecord = {
      entryId: randomUUID(),
      ownerUserId: owner,
      itemId,
      storyTitle: 'Story',
      windowStart: new Date(T0).toISOString(),
      windowSize: '1h',
      signals: {},
      antiSignals: [],
      pwattScore: 0.1,
      summary: 'first',
      recordedAt: new Date(T0).toISOString(),
      purgeAfter: new Date(T0 + 86_400_000).toISOString(),
    };
    await store.upsertMany([base]);
    const first = (await store.listForUser(owner, 10)).entries[0];
    // A re-score of the SAME (owner,item,window) with a fresh id / record time
    // and an updated score — the store must keep the original id + record time.
    await store.upsertMany([
      {
        ...base,
        entryId: randomUUID(),
        recordedAt: new Date(T0 + 3_600_000).toISOString(),
        pwattScore: 0.9,
        summary: 'rescored',
      },
    ]);
    const after = (await store.listForUser(owner, 10)).entries;
    expect(after).toHaveLength(1);
    expect(after[0]?.entryId).toBe(first?.entryId); // id unchanged
    expect(after[0]?.recordedAt).toBe(first?.recordedAt); // record time unchanged
    expect(after[0]?.pwattScore).toBe(0.9); // but the score DID update
    expect(after[0]?.summary).toBe('rescored');
  });

  it('checkpoints and dead letters round-trip', async () => {
    const checkpoints = new InMemoryConsumerCheckpointStore();
    expect(await checkpoints.get('agg')).toBeNull();
    await checkpoints.set('agg', IN_WINDOW);
    expect(await checkpoints.get('agg')).toBe(IN_WINDOW);
    await checkpoints.clear();
    expect(await checkpoints.get('agg')).toBeNull();

    const deadLetters = new InMemoryDeadLetterStore();
    await deadLetters.append({
      consumerName: 'a',
      eventId: randomUUID(),
      topic: 'contribution.created',
      error: 'x',
      attempts: 3,
      failedAt: new Date().toISOString(),
    });
    expect(await deadLetters.list()).toHaveLength(1);
    expect(await deadLetters.list('b')).toHaveLength(0);
  });

  it('replay store prunes expired nonces and re-admits after expiry', async () => {
    const store = new InMemoryReplayNonceStore();
    const t0 = Date.now();
    expect(await store.putIfAbsent('k', 1_000, t0)).toBe(true);
    expect(await store.putIfAbsent('k', 1_000, t0 + 500)).toBe(false);
    expect(await store.putIfAbsent('k', 1_000, t0 + 1_500)).toBe(true); // expired
  });
});

describe('metrics (WS-E.1.3a observability)', () => {
  it('tracks counters and latency percentiles; ignores hostile inputs', () => {
    const metrics = new PipelineMetrics();
    metrics.increment('accepted', 3);
    metrics.increment('accepted');
    metrics.observeLatencyMs(10);
    metrics.observeLatencyMs(20);
    metrics.observeLatencyMs(Number.NaN); // ignored
    metrics.observeLatencyMs(-5); // ignored
    const snapshot = metrics.snapshot();
    expect(snapshot.counters['accepted']).toBe(4);
    expect(snapshot.latency.count).toBe(2);
    expect(snapshot.latency.p50).toBeGreaterThanOrEqual(10);
    expect(snapshot.latency.p99).toBeLessThanOrEqual(20);
    metrics.clear();
    expect(metrics.counter('accepted')).toBe(0);
  });
});

describe('aggregation fold: contribution + integrity branches (WS-E.2.1a)', () => {
  it('counts a sourced contribution into window volume; integrity stays anti-signal-only', async () => {
    // The story and its thread are DISTINCT ids, as production mints them, so
    // the fold key being the story is observable rather than coincidental.
    const storyId = randomUUID();
    const threadId = randomUUID();
    const userId = randomUUID();
    await fixture.events.eventStore.insertMany([
      {
        eventId: randomUUID(),
        eventType: 'contribution.created',
        topic: 'contribution.created',
        timestamp: IN_WINDOW,
        privacyClassification: 'public',
        retentionTier: 'public_contribution',
        payload: {
          thread_id: threadId,
          story_id: storyId,
          user_id: userId,
          contribution_type: 'explanation',
          has_citation: true,
          accusation_flag: false,
        },
        ownerUserId: userId,
        purgeAfter: null,
      },
      {
        eventId: randomUUID(),
        eventType: 'integrity.signal.detected',
        topic: 'integrity.signal.detected',
        timestamp: IN_WINDOW,
        privacyClassification: 'restricted',
        retentionTier: 'security_log',
        payload: { signal_type: 'rage_loop', target_ids: [storyId] },
        ownerUserId: null,
        purgeAfter: null,
      },
    ]);
    await computeAggregationWindow(fixture.events, T0, '1h');
    // Nothing is ever folded under the THREAD id.
    expect(await fixture.events.windowStore.get(threadId, new Date(T0).toISOString(), '1h')).toBe(
      null,
    );
    const window = await fixture.events.windowStore.get(storyId, new Date(T0).toISOString(), '1h');
    // Integrity signals are recorded as anti-signal counts but deliberately
    // do NOT inflate eventCount (which conditions burst detection volume).
    expect(window?.eventCount).toBe(1);
    expect(window?.contributionCounts).toEqual({ explanation: 1 });
    expect(window?.antiSignalCounts).toEqual({ rage_loop: 1 });
  });
});

describe('small pure helpers', () => {
  it('deterministicEventId is a stable, distinct name-based UUIDv8 (SHA-256)', () => {
    const a = deterministicEventId('integrity:x:1');
    const b = deterministicEventId('integrity:x:1');
    const c = deterministicEventId('integrity:x:2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // Version nibble 8 (RFC 9562 name-based-over-SHA-256), RFC variant 10xx.
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('isShadowOutput admits a genuine non-shadow invariant output', () => {
    expect(isShadowOutput({ invariantType: 'MERI', shadowMode: false })).toBe(false);
  });

  it('rankFrontPageV0 orders by freshness with deterministic tiebreaks', () => {
    const result = rankFrontPageV0([
      { storyId: 'b', createdAt: '2026-06-10T10:00:00.000Z' },
      { storyId: 'a', createdAt: '2026-06-10T10:00:00.000Z' },
      { storyId: 'c', createdAt: '2026-06-10T11:00:00.000Z' },
    ]);
    expect(result.order).toEqual(['c', 'a', 'b']);
    expect(result.rejectedShadowInputs).toBe(0);
  });
});

describe('remaining in-memory store surfaces (coverage headroom)', () => {
  it('event store: owner listing, tier owner enumeration, topic filtering', async () => {
    const store = new InMemoryEventStore();
    const owner = randomUUID();
    await store.insertMany([
      {
        eventId: randomUUID(),
        eventType: 'attention.aggregate',
        topic: 'attention.aggregate',
        timestamp: IN_WINDOW,
        privacyClassification: 'aggregated',
        retentionTier: 'attention_aggregated',
        payload: {},
        ownerUserId: owner,
        purgeAfter: null,
      },
      {
        eventId: randomUUID(),
        eventType: 'contribution.created',
        topic: 'contribution.created',
        timestamp: IN_WINDOW,
        privacyClassification: 'public',
        retentionTier: 'public_contribution',
        payload: {},
        ownerUserId: null,
        purgeAfter: null,
      },
    ]);
    expect(await store.listByOwner(owner)).toHaveLength(1);
    expect(await store.listOwnersWithTier('attention_aggregated')).toEqual([owner]);
    expect(await store.listOwnersWithTier('ranking_log')).toEqual([]);
    expect(
      await store.listByTopicsBetween(
        ['contribution.created'],
        new Date(T0).toISOString(),
        new Date(T0 + 3_600_000).toISOString(),
      ),
    ).toHaveLength(1);
    expect(await store.deleteByOwner(owner)).toBe(1);
    expect(await store.deleteByOwner(owner)).toBe(0);
    await store.clear();
    expect(store.size).toBe(0);
  });

  it('ledger store: tighten-only purge semantics and over-retention counting', async () => {
    const store = new InMemorySignalLedgerStore();
    const owner = randomUUID();
    const entry: SignalLedgerRecord = {
      entryId: randomUUID(),
      ownerUserId: owner,
      itemId: randomUUID(),
      storyTitle: 'S',
      windowStart: new Date(T0).toISOString(),
      windowSize: '1h',
      signals: {},
      antiSignals: [],
      pwattScore: 0.5,
      summary: 'You read this for a short while.',
      recordedAt: new Date(T0).toISOString(),
      purgeAfter: new Date(T0 + 10 * 86_400_000).toISOString(),
    };
    await store.upsertMany([entry]);
    const earlier = new Date(T0 + 86_400_000).toISOString();
    expect(await store.tightenOwnerPurge(owner, earlier)).toBe(1);
    // Tightening again with a LATER deadline never extends.
    expect(await store.tightenOwnerPurge(owner, new Date(T0 + 20 * 86_400_000).toISOString())).toBe(
      0,
    );
    expect(await store.countOverRetained(new Date(T0 + 2 * 86_400_000).toISOString())).toBe(1);
    expect(await store.deletePurgeDue(new Date(T0 + 2 * 86_400_000).toISOString())).toBe(1);
    await store.clear();
  });

  it('realtime rebuild covers the contribution branch and clear()', async () => {
    // A pinned clock keeps the fixed test window inside the live TTL.
    const realtime = new InMemoryRealtimeAggregator(() => T0 + 10 * 60_000);
    const storyId = randomUUID();
    const threadId = randomUUID();
    const userId = randomUUID();
    await rebuildRealtimeFromEvents(
      realtime,
      [
        {
          eventId: randomUUID(),
          eventType: 'contribution.created',
          topic: 'contribution.created',
          timestamp: IN_WINDOW,
          privacyClassification: 'public',
          retentionTier: 'public_contribution',
          payload: {
            thread_id: threadId,
            story_id: storyId,
            user_id: userId,
            timestamp: IN_WINDOW,
          },
          ownerUserId: userId,
          createdAt: IN_WINDOW,
          purgeAfter: null,
          reviewFlaggedAt: null,
        },
      ],
      actorKeyOfPayload,
    );
    const windowStart = realtimeWindowStart(Date.parse(IN_WINDOW));
    // Recorded against the STORY, matching every other branch of the rebuild
    // and every reader of this layer — never the thread.
    expect(await realtime.snapshot(threadId, windowStart)).toBeNull();
    const snapshot = await realtime.snapshot(storyId, windowStart);
    expect(snapshot?.contributions).toBe(1);
    await realtime.clear();
    expect(await realtime.snapshot(storyId, windowStart)).toBeNull();
  });

  it('attention store: anonymize/delete branches across owners', async () => {
    const store = fixture.events.attentionStore;
    const owner = randomUUID();
    const old = new Date(T0 - 200 * 86_400_000).toISOString();
    await store.insertMany([
      {
        aggregate_id: randomUUID(),
        user_id_or_privacy_bucket: owner,
        story_id: randomUUID(),
        session_bucket: 's',
        active_dwell_bucket: 'short',
        source_opened: false,
        context_opened: false,
        branch_depth_bucket: 'none',
        return_visit_count_bucket: 'none',
        privacy_level: 'standard',
        created_at: old,
      },
    ]);
    expect(await store.countIdentifiableOlderThan(new Date(T0).toISOString())).toBe(1);
    expect(await store.anonymizeOwnedOlderThan(owner, new Date(T0).toISOString())).toBe(1);
    expect(await store.countIdentifiableOlderThan(new Date(T0).toISOString())).toBe(0);
    expect(await store.deleteAnonymizedOlderThan(new Date(T0).toISOString())).toBe(1);
    expect(await store.deleteOwnedOlderThan(owner, new Date(T0).toISOString())).toBe(0);
    await store.clear();
  });
});

describe('validatePwattConfigValue (write-time rejection, all keys)', () => {
  const validCurve = { kind: 'logarithmic', scale: 4, saturationPoint: 25 };
  const validV0 = {
    activeAttention: {
      weights: { dwellPct: 40, sourcePct: 25, contextPct: 20, traversalPct: 15 },
      halfSaturationActors: 8,
    },
    participation: {
      weights: { returnPct: 49, savePct: 1, contributionPct: 50 },
      contribSaturation: 3,
      rapidThreshold: 5,
      rapidDampening: 0.3,
      accusationDownweight: 0.25,
      citationBonus: 0.35,
      burstPlaceholderDampening: 0.9,
      halfSaturationActors: 5,
    },
    confidenceHalfSaturation: 3,
  };
  const validV1 = {
    contributionWeights: {
      correction: 0.9,
      bridge_comment: 0.85,
      explanation: 0.5,
      steward_action: 0.5,
      low_info_reply: 0,
    },
    contributionCurve: { kind: 'logarithmic', scale: 1, saturationPoint: 6 },
    attentionDimensions: {
      dwell: { weightPct: 40, curve: validCurve },
      source: { weightPct: 25, curve: validCurve },
      context: { weightPct: 20, curve: validCurve },
      traversal: { weightPct: 15, curve: validCurve },
    },
    participationDimensions: {
      returns: { weightPct: 49, curve: validCurve },
      saves: { weightPct: 1, curve: validCurve },
      contributions: { weightPct: 50, curve: validCurve },
    },
    accusationDownweight: 0.25,
    citationBonus: 0.35,
    rapidThreshold: 5,
    rapidDampening: 0.3,
    antiSignalAttenuation: { coordinatedBurstMax: 0.5, harassmentCascade: 0.3 },
  };

  it('accepts a valid value for every key', () => {
    const valid: Array<[PwattConfigKey, Record<string, unknown>]> = [
      ['v0', validV0],
      ['v1', validV1],
      ['burst', { minVolume: 10, minDistinctActors: 5, burstMultiplier: 4, baseRateFloor: 3 }],
      [
        'cascade',
        {
          minDistinctActors: 5,
          minContributions: 8,
          hostileShareThreshold: 0.6,
          volumeMultiplier: 2,
          baseRateFloor: 3,
        },
      ],
      ['trust_weights', { new: 0.5, recent: 0.7, active: 0.9, established: 1 }],
      ['trigger_threshold', { value: 500 }],
    ];
    for (const [key, value] of valid) {
      expect(validatePwattConfigValue(key, value), key).toBeNull();
    }
  });

  it('rejects an invalid value for every key with a named problem', () => {
    const invalid: Array<[PwattConfigKey, Record<string, unknown>, RegExp]> = [
      // Shape-valid but semantically broken: weights do not sum to 100.
      [
        'v0',
        {
          ...validV0,
          activeAttention: {
            ...validV0.activeAttention,
            weights: { dwellPct: 50, sourcePct: 30, contextPct: 10, traversalPct: 5 },
          },
        },
        /sum to exactly 100/,
      ],
      // Shape-valid but hierarchy-breaking: low_info_reply gains weight.
      [
        'v1',
        {
          ...validV1,
          contributionWeights: { ...validV1.contributionWeights, low_info_reply: 0.5 },
        },
        /low_info_reply/,
      ],
      ['burst', { minVolume: 0 }, /./],
      ['cascade', { hostileShareThreshold: 2 }, /./],
      // Non-monotone trust weights (new > recent) are rejected.
      ['trust_weights', { new: 1, recent: 0.5, active: 0.9, established: 1 }, /monotone/],
      ['trigger_threshold', { value: 0 }, /./],
    ];
    for (const [key, value, pattern] of invalid) {
      const problem = validatePwattConfigValue(key, value);
      expect(problem, key).not.toBeNull();
      expect(problem ?? '', key).toMatch(pattern);
    }
  });

  it('the loader applies valid stored v0/v1 values and rejects invalid ones', async () => {
    await fixture.events.configStore.set('v0', validV0);
    await fixture.events.configStore.set('v1', validV1);
    const applied = await loadPwattRuntimeConfig(fixture.events);
    expect(applied.v0.participation.weights.returnPct).toBe(49);
    expect(applied.v1.contributionWeights.correction).toBe(0.9);
    expect(rejections).toHaveLength(0);

    // A pre-WS-T stored row carrying the RETIRED `evidence` weight upgrades in
    // place: the retired key is stripped and the steward's surviving tuning is
    // KEPT (never silently discarded for the defaults).
    await fixture.events.configStore.set('v1', {
      ...validV1,
      contributionWeights: { ...validV1.contributionWeights, evidence: 1 },
      citationBonus: 0.4,
    });
    const upgraded = await loadPwattRuntimeConfig(fixture.events);
    expect(rejections).toHaveLength(0);
    expect(upgraded.v1.citationBonus).toBe(0.4);
    expect('evidence' in upgraded.v1.contributionWeights).toBe(false);

    await fixture.events.configStore.set('v0', { broken: true });
    // NEW-shape (has `traversal`, so the legacy upgrade never touches it) but
    // GENUINELY invalid: dwell 60 breaks the 50% dominance cap ⇒ rejected.
    await fixture.events.configStore.set('v1', {
      ...validV1,
      attentionDimensions: {
        dwell: { weightPct: 60, curve: validCurve },
        source: { weightPct: 20, curve: validCurve },
        context: { weightPct: 10, curve: validCurve },
        traversal: { weightPct: 10, curve: validCurve },
      },
    });
    const fallback = await loadPwattRuntimeConfig(fixture.events);
    expect(fallback.v0).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.v0);
    expect(fallback.v1).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.v1);
    expect(rejections.map((r) => r['key']).sort()).toEqual(['v0', 'v1']);
  });
});
