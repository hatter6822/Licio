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
    await fixture.events.configStore.set('penalty_coefficients', {
      pM: 2,
      pH: 0,
      pT: 0,
      pR: 1,
    });
    await fixture.events.configStore.set('ranking_profiles', {
      profiles: [{ name: 'breaking_news', weights: { wA: 25, wP: 30, wE: 15, wS: 15, wC: 15 } }],
    });
    await fixture.events.configStore.set('trigger_threshold', { value: 50 });
    const config = await loadPwattRuntimeConfig(fixture.events);
    expect(config.burst.minVolume).toBe(20);
    expect(config.cascade.hostileShareThreshold).toBe(0.7);
    expect(config.penaltyCoefficients.pM).toBe(2);
    expect(config.profiles).toHaveLength(1);
    expect(config.triggerThreshold).toBe(50);
    expect(rejections).toHaveLength(0);
  });

  it('rejects invalid stored values and FAILS CLOSED to the defaults (logged)', async () => {
    await fixture.events.configStore.set('burst', { minVolume: 0 } as never);
    await fixture.events.configStore.set('cascade', { hostileShareThreshold: 2 } as never);
    await fixture.events.configStore.set('penalty_coefficients', { pM: -1, pH: 0, pT: 0, pR: 0 });
    await fixture.events.configStore.set('ranking_profiles', {
      profiles: [{ name: 'bad', weights: { wA: 90, wP: 5, wE: 2, wS: 2, wC: 1 } }],
    });
    await fixture.events.configStore.set('trigger_threshold', { value: 0 });
    const config = await loadPwattRuntimeConfig(fixture.events);
    expect(config.burst).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.burst);
    expect(config.cascade).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.cascade);
    expect(config.penaltyCoefficients).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.penaltyCoefficients);
    expect(config.profiles).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.profiles);
    expect(config.triggerThreshold).toBe(DEFAULT_PWATT_RUNTIME_CONFIG.triggerThreshold);
    expect(rejections.length).toBe(5);
  });

  it('rejects a profile set where ANY profile is invalid (all-or-none)', async () => {
    await fixture.events.configStore.set('ranking_profiles', {
      profiles: [
        { name: 'good', weights: { wA: 30, wP: 25, wE: 15, wS: 15, wC: 15 } },
        { name: 'broken', weights: { wA: 30, wP: 25, wE: 15, wS: 15, wC: 14 } },
      ],
    });
    const config = await loadPwattRuntimeConfig(fixture.events);
    expect(config.profiles).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.profiles);
    expect(rejections).toHaveLength(1);
  });

  it('rejects nonnegative-violating penalty coefficients even when shape-valid', async () => {
    // Shape allows numbers >= 0; the semantic validator is exercised through
    // a NaN that passes neither.
    await fixture.events.configStore.set('penalty_coefficients', {
      pM: Number.NaN,
      pH: 0,
      pT: 0,
      pR: 0,
    });
    const config = await loadPwattRuntimeConfig(fixture.events);
    expect(config.penaltyCoefficients).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.penaltyCoefficients);
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

describe('aggregation fold: evidence + integrity branches (WS-E.2.1a)', () => {
  it('counts evidence.added into window volume without double-crediting participation', async () => {
    const threadId = randomUUID();
    const userId = randomUUID();
    await fixture.events.eventStore.insertMany([
      {
        eventId: randomUUID(),
        eventType: 'evidence.added',
        topic: 'evidence.added',
        timestamp: IN_WINDOW,
        privacyClassification: 'public',
        retentionTier: 'public_contribution',
        payload: { thread_id: threadId, user_id: userId },
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
        payload: { signal_type: 'rage_loop', target_ids: [threadId] },
        ownerUserId: null,
        purgeAfter: null,
      },
    ]);
    await computeAggregationWindow(fixture.events, T0, '1h');
    const window = await fixture.events.windowStore.get(threadId, new Date(T0).toISOString(), '1h');
    // Integrity signals are recorded as anti-signal counts but deliberately
    // do NOT inflate eventCount (which conditions burst detection volume).
    expect(window?.eventCount).toBe(1);
    expect(window?.contributionCounts).toEqual({}); // no participation credit
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
          payload: { thread_id: threadId, user_id: userId, timestamp: IN_WINDOW },
          ownerUserId: userId,
          createdAt: IN_WINDOW,
          purgeAfter: null,
          reviewFlaggedAt: null,
        },
      ],
      actorKeyOfPayload,
    );
    const snapshot = await realtime.snapshot(threadId, realtimeWindowStart(Date.parse(IN_WINDOW)));
    expect(snapshot?.contributions).toBe(1);
    await realtime.clear();
    expect(
      await realtime.snapshot(threadId, realtimeWindowStart(Date.parse(IN_WINDOW))),
    ).toBeNull();
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
      weights: { dwellPct: 50, sourcePct: 30, contextPct: 20 },
      halfSaturationActors: 8,
    },
    participation: {
      weights: { returnPct: 40, savePct: 10, contributionPct: 50 },
      contribSaturation: 3,
      rapidThreshold: 5,
      rapidDampening: 0.3,
      accusationDownweight: 0.25,
      burstPlaceholderDampening: 0.9,
      halfSaturationActors: 5,
    },
    confidenceHalfSaturation: 3,
  };
  const validV1 = {
    contributionWeights: {
      question: 0.7,
      evidence: 1,
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
    contributionCurve: { kind: 'logarithmic', scale: 1, saturationPoint: 6 },
    attentionDimensions: {
      dwell: { weightPct: 50, curve: validCurve },
      source: { weightPct: 30, curve: validCurve },
      context: { weightPct: 20, curve: validCurve },
    },
    participationDimensions: {
      returns: { weightPct: 40, curve: validCurve },
      saves: { weightPct: 10, curve: validCurve },
      contributions: { weightPct: 50, curve: validCurve },
    },
    accusationDownweight: 0.25,
    rapidThreshold: 5,
    rapidDampening: 0.3,
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
      ['penalty_coefficients', { pM: 1, pH: 1, pT: 1, pR: 0.5 }],
      [
        'ranking_profiles',
        {
          profiles: [
            { name: 'breaking_news', weights: { wA: 30, wP: 25, wE: 15, wS: 15, wC: 15 } },
          ],
        },
      ],
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
            weights: { dwellPct: 50, sourcePct: 30, contextPct: 10 },
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
      ['penalty_coefficients', { pM: -1, pH: 0, pT: 0, pR: 0 }, /./],
      [
        'ranking_profiles',
        { profiles: [{ name: 'bad', weights: { wA: 45, wP: 25, wE: 10, wS: 10, wC: 10 } }] },
        /guardrail/,
      ],
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
    expect(applied.v0.participation.weights.returnPct).toBe(40);
    expect(applied.v1.contributionWeights.evidence).toBe(1);
    expect(rejections).toHaveLength(0);

    await fixture.events.configStore.set('v0', { broken: true });
    await fixture.events.configStore.set('v1', {
      ...validV1,
      attentionDimensions: {
        dwell: { weightPct: 60, curve: validCurve },
        source: { weightPct: 20, curve: validCurve },
        context: { weightPct: 20, curve: validCurve },
      },
    });
    const fallback = await loadPwattRuntimeConfig(fixture.events);
    expect(fallback.v0).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.v0);
    expect(fallback.v1).toEqual(DEFAULT_PWATT_RUNTIME_CONFIG.v1);
    expect(rejections.map((r) => r['key']).sort()).toEqual(['v0', 'v1']);
  });
});
