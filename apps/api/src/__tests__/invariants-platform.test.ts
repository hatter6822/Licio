// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1 platform tests: the fallback execution wrapper (failure/timeout →
// degraded envelope + gap record; ranking proceeds with one, two, or ALL
// invariants failing), score-vector validation before persistence, the
// shadow flag on every persisted row + the ranking-boundary rejection, the
// promotion service end-to-end (no advance without a valid record; demotion
// kill switch without redeploy), fail-closed config loading, the scheduler
// tick, and uniform health metrics.

import { randomUUID } from 'node:crypto';
import { InvariantType } from '@licio/invariants';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INVARIANTS_CONFIG,
  loadInvariantsConfig,
  validateInvariantsConfigValue,
} from '../invariants/config.js';
import { hourWindow, mapBounded, persistComputations, runGuarded } from '../invariants/runner.js';
import { runInvariantsTick } from '../invariants/scheduler.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import { rankFrontPageV0 } from '../pwatt/ranking-v0.js';
import { selectRankingInputs } from '../pwatt/shadow.js';
import { freshInvariantServices, seedStory } from './invariant-test-helpers.js';

function runnerDeps(fixture: ReturnType<typeof freshInvariantServices>) {
  return {
    runMetadata: fixture.invariants.runMetadata,
    metrics: fixture.events.metrics,
    log: () => {},
    now: Date.now,
  };
}

describe('WS-H.1.2c fallback execution wrapper', () => {
  it('a throwing invariant yields a degraded envelope and a gap record', async () => {
    const fixture = freshInvariantServices();
    const result = await runGuarded(
      runnerDeps(fixture),
      'MERI',
      '1.0.0',
      'batch',
      { targetType: 'feed', targetId: GLOBAL_FEED_TARGET_ID },
      5_000,
      async () => {
        throw new Error('store unavailable');
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.degraded.confidence).toBe(0);
      expect(result.degraded.reason_codes).toContain('COMPUTE_ERROR');
      expect(result.degraded.fallback_used).toBe(true);
      expect(result.gap.invariantType).toBe('MERI');
      expect(result.gap.failureReason).toBe('Error');
    }
    const runs = await fixture.invariants.runMetadata.listRecent('MERI', 5);
    expect(runs[0]?.success).toBe(false);
    expect(fixture.events.metrics.counter('invariants.gap.MERI')).toBe(1);
  });

  it('a timeout triggers the fallback path with the TIMEOUT reason code', async () => {
    const fixture = freshInvariantServices();
    const result = await runGuarded(
      runnerDeps(fixture),
      'GWEI',
      '1.0.0',
      'batch',
      null,
      20,
      () => new Promise(() => {}), // never resolves
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.degraded.reason_codes).toEqual(['TIMEOUT']);
      expect(result.gap.failureReason).toBe('TIMEOUT');
    }
  });

  it('ranking produces valid output when one, two, or ALL invariants fail', async () => {
    const fixture = freshInvariantServices();
    const candidates = [
      { storyId: '11111111-1111-4111-8111-111111111111', createdAt: '2026-06-10T10:00:00.000Z' },
      { storyId: '22222222-2222-4222-8222-222222222222', createdAt: '2026-06-11T10:00:00.000Z' },
    ];
    const failures: string[] = [];
    // one, two, and ALL TWELVE invariants failing (the current family count).
    for (const failing of [1, 2, 12]) {
      for (let i = 0; i < failing; i += 1) {
        const result = await runGuarded(
          runnerDeps(fixture),
          `inv-${i}`,
          '1.0.0',
          'batch',
          null,
          50,
          async () => {
            throw new Error('down');
          },
        );
        if (!result.ok) failures.push(result.gap.invariantType);
      }
      // The feed still ranks — failed invariants contribute NOTHING (their
      // features are omitted, never defaulted).
      const ranking = rankFrontPageV0(candidates, await fixture.events.invariantStore.listAll());
      expect(ranking.order).toEqual([
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
      ]);
    }
    expect(failures.length).toBe(15);
  });

  it('mapBounded respects the concurrency cap (batch back-pressure)', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapBounded([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('WS-H.1.1d score-vector validation at persistence', () => {
  it('rejects an invalid vector (never lands) and accepts a valid one', async () => {
    const fixture = freshInvariantServices();
    const window = hourWindow(Date.now());
    const written = await persistComputations(
      fixture.events.invariantStore,
      { log: () => {}, metrics: fixture.events.metrics },
      [
        {
          invariantType: InvariantType.SCOI,
          target: { targetType: 'story', targetId: '33333333-3333-4333-8333-333333333333' },
          window,
          score_vector: { scoi: 42 }, // out of range AND missing fields
          confidence: 0.5,
          coverage: 1,
          reason_codes: [],
          fallback_used: false,
          version: '1.0.0',
          explanationSummary: null,
        },
        {
          invariantType: InvariantType.SCOI,
          target: { targetType: 'story', targetId: '33333333-3333-4333-8333-333333333333' },
          window,
          score_vector: {
            scoi: 0.4,
            normalizer: 8,
            overlap_count: 1,
            lens_count: 2,
            context_state: 'split',
            per_overlap_energy: { 'a~b': 3.2 },
          },
          confidence: 0.7,
          coverage: 0.9,
          reason_codes: [],
          fallback_used: false,
          version: '1.0.0',
          explanationSummary: 'ok',
        },
      ],
    );
    expect(written).toBe(1);
    expect(fixture.events.metrics.counter('invariants.score_vector_rejected')).toBe(1);
    const rows = await fixture.events.invariantStore.listForTarget(
      '33333333-3333-4333-8333-333333333333',
    );
    expect(rows).toHaveLength(1);
    // EVERY persisted WS-H row is shadow (WS-H.1.2e / M2 gate).
    expect(rows[0]?.shadowMode).toBe(true);
    expect(rows[0]?.coverage).toBe(0.9);
  });

  it('the ranking boundary rejects WS-H shadow rows even if handed in directly', async () => {
    const fixture = freshInvariantServices();
    await persistComputations(
      fixture.events.invariantStore,
      { log: () => {}, metrics: fixture.events.metrics },
      [
        {
          invariantType: InvariantType.MERI,
          target: { targetType: 'feed', targetId: GLOBAL_FEED_TARGET_ID },
          window: hourWindow(Date.now()),
          score_vector: {
            meri: 0.9,
            marginal_gains: {},
            approximation: false,
            per_class_bounds: {},
            group_ids: [],
          },
          confidence: 1,
          coverage: 1,
          reason_codes: [],
          fallback_used: false,
          version: '1.0.0',
          explanationSummary: null,
        },
      ],
    );
    const { allowed, rejected } = selectRankingInputs(
      await fixture.events.invariantStore.listAll(),
    );
    expect(allowed).toHaveLength(0);
    expect(rejected.length).toBeGreaterThan(0);
  });
});

describe('WS-H.1.2e promotion service', () => {
  const evidence = {
    shadowDurationDays: 30,
    driftReportRef: 'regression-2026-06-10',
    observedCoverage: 0.95,
    observedConfidence: 0.9,
  };

  // Seed the SERVER-MEASURED shadow evidence an upward promotion now gates on: a
  // (backdated) first run + observed health.  The self-reported evidence numbers are
  // ignored — the gate derives duration from the first run and coverage/confidence
  // from the invariant's rolling health.
  const seedShadow = async (
    fixture: ReturnType<typeof freshInvariantServices>,
    type: string,
    service: {
      health: {
        observe: (
          ms: number,
          o: { coverage: number; confidence: number; fallback_used: boolean }[],
        ) => void;
      };
    },
    daysAgo: number,
  ): Promise<void> => {
    await fixture.invariants.runMetadata.append({
      invariantType: type,
      tier: 'batch',
      targetCount: 1,
      durationMs: 1,
      success: true,
      failureReason: null,
      startedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    });
    service.health.observe(1, [{ coverage: 0.95, confidence: 0.9, fallback_used: false }]);
  };

  it('gates on the MEASURED shadow duration, not the self-reported one', async () => {
    const fixture = freshInvariantServices();
    expect(await fixture.invariants.promotionService.statusOf('MERI')).toBe('shadow');
    expect(await fixture.invariants.promotionService.effectsEnabled('MERI')).toBe(false);
    // Only 2 days of REAL shadow, though the steward CLAIMS 30 — the gate must use 2.
    await seedShadow(fixture, 'MERI', fixture.invariants.meri, 2);
    const rejected = await fixture.invariants.promotionService.apply(
      {
        invariantType: 'MERI',
        fromStatus: 'shadow',
        toStatus: 'soft_constraint',
        evidence: { ...evidence, shadowDurationDays: 30 },
        owner: 'ranking-lead',
        createdAt: new Date().toISOString(),
      },
      14,
    );
    expect(rejected).toMatch(/shadow days/);
    expect(await fixture.invariants.promotionService.effectsEnabled('MERI')).toBe(false);
  });

  it('promotion enables effects; demotion (kill switch) disables without redeploy', async () => {
    const fixture = freshInvariantServices();
    await seedShadow(fixture, 'SCOI', fixture.invariants.scoi, 30);
    const promote = await fixture.invariants.promotionService.apply(
      {
        invariantType: 'SCOI',
        fromStatus: 'shadow',
        toStatus: 'soft_constraint',
        evidence,
        owner: 'ranking-lead',
        createdAt: new Date().toISOString(),
      },
      14,
    );
    expect(promote).toBeNull();
    expect(await fixture.invariants.promotionService.effectsEnabled('SCOI')).toBe(true);
    const demote = await fixture.invariants.promotionService.apply(
      {
        invariantType: 'SCOI',
        fromStatus: 'soft_constraint',
        toStatus: 'shadow',
        evidence: { ...evidence, shadowDurationDays: 0, driftReportRef: 'incident-7' },
        owner: 'oncall',
        createdAt: new Date().toISOString(),
      },
      14,
    );
    expect(demote).toBeNull();
    expect(await fixture.invariants.promotionService.effectsEnabled('SCOI')).toBe(false);
    expect(await fixture.invariants.promotionService.statusOf('SCOI')).toBe('shadow');
  });
});

describe('WS-H runtime config (fail closed)', () => {
  it('write-time validation rejects bad values; loader keeps defaults on bad rows', async () => {
    const fixture = freshInvariantServices();
    expect(validateInvariantsConfigValue('invariants.mfciSamples', 50)).toMatch(/>=100|100/);
    expect(validateInvariantsConfigValue('invariants.nope', 1)).toMatch(/unknown/);
    expect(
      validateInvariantsConfigValue('invariants.phiThresholds', {
        baseThreshold: 1,
        sensitiveTopicFactor: 2, // would WEAKEN protection
        minorFactor: 0.5,
        baseRepeatThreshold: 3,
        repeatReduction: 1,
      }),
    ).not.toBeNull();
    // Poison a stored row directly; the loader must keep the default.
    await fixture.events.configStore.set('invariants.batchConcurrency', { value: 99 });
    const rejections: string[] = [];
    const config = await loadInvariantsConfig(fixture.events.configStore, (key) => {
      rejections.push(key);
    });
    expect(config.batchConcurrency).toBe(DEFAULT_INVARIANTS_CONFIG.batchConcurrency);
    expect(rejections).toEqual(['invariants.batchConcurrency']);
    // A valid stored value IS applied.
    await fixture.events.configStore.set('invariants.batchConcurrency', { value: 4 });
    const updated = await loadInvariantsConfig(fixture.events.configStore);
    expect(updated.batchConcurrency).toBe(4);
  });

  it('validates and round-trips the threshold-hugging meta-monitor keys (WS-O.4.5)', async () => {
    const fixture = freshInvariantServices();
    // Out-of-range values are rejected at write time.
    expect(
      validateInvariantsConfigValue('invariants.thresholdHuggingBandFraction', 1.5),
    ).not.toBeNull();
    expect(
      validateInvariantsConfigValue('invariants.thresholdHuggingMinPopulation', 1),
    ).not.toBeNull();
    expect(validateInvariantsConfigValue('invariants.thresholdHuggingExcess', 0.5)).not.toBeNull();
    // Valid values round-trip through the fail-closed loader.
    await fixture.events.configStore.set('invariants.thresholdHuggingBandFraction', { value: 0.2 });
    await fixture.events.configStore.set('invariants.thresholdHuggingExcess', { value: 3 });
    const config = await loadInvariantsConfig(fixture.events.configStore);
    expect(config.thresholdHuggingBandFraction).toBe(0.2);
    expect(config.thresholdHuggingExcess).toBe(3);
    // A poisoned row keeps the reviewed default.
    await fixture.events.configStore.set('invariants.thresholdHuggingMinPopulation', { value: 0 });
    const rejected: string[] = [];
    const reloaded = await loadInvariantsConfig(fixture.events.configStore, (key) =>
      rejected.push(key),
    );
    expect(reloaded.thresholdHuggingMinPopulation).toBe(
      DEFAULT_INVARIANTS_CONFIG.thresholdHuggingMinPopulation,
    );
    expect(rejected).toContain('invariants.thresholdHuggingMinPopulation');
  });
});

describe('WS-H.1.2f scheduler tick', () => {
  it('runs the batch tier for all invariants, persists shadow rows, records health', async () => {
    const fixture = freshInvariantServices();
    await seedStory(fixture, { canonicalUrl: 'https://example.org/a' });
    await seedStory(fixture, { canonicalUrl: 'https://example.org/b' });
    const errors: unknown[] = [];
    await runInvariantsTick(fixture.invariants, fixture.events, fixture.ingestion, (err) =>
      errors.push(err),
    );
    expect(errors).toEqual([]);
    // MERI ran over the feed pool and persisted a shadow output.
    const meri = await fixture.events.invariantStore.latest('MERI', GLOBAL_FEED_TARGET_ID);
    expect(meri).not.toBeNull();
    expect(meri?.shadowMode).toBe(true);
    expect(meri?.coverage).toBeGreaterThanOrEqual(0);
    // Health metrics observed at least one MERI run (WS-H.1.2g).
    expect(fixture.invariants.meri.getHealthMetrics().outputCount).toBeGreaterThan(0);
    const runs = await fixture.invariants.runMetadata.listRecent('MERI', 5);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.tier).toBe('batch');
    // Every persisted row carries the invariant's CONFIG SNAPSHOT in
    // version_metadata (WS-H.1.1b: configuration drift is distinguishable
    // from algorithm drift).
    const snapshot = meri?.versionMetadata as { config?: Record<string, unknown> } | null;
    expect(snapshot?.config).toMatchObject({
      candidate_limit: fixture.invariants.config().meriCandidateLimit,
    });
  });
});

describe('upward promotions are regression-gated (WS-H.1.2e + WS-H.1.2d)', () => {
  const evidence = {
    shadowDurationDays: 30,
    driftReportRef: 'regression-2026-06-11',
    observedCoverage: 0.95,
    observedConfidence: 0.9,
  };

  it('a failing regression suite blocks promotion but never the kill switch', async () => {
    const { createPromotionService } = await import('../invariants/promotion.js');
    const { InMemoryPromotionStore } = await import('../invariants/stores.js');
    const { INVARIANT_CARDS } = await import('../invariants/cards.js');
    const store = new InMemoryPromotionStore();
    const failing = createPromotionService(
      store,
      (t) => Object.values(INVARIANT_CARDS).find((c) => c.invariant_type === t) ?? null,
      () => {},
      () => ({ pass: false, failures: [{ invariant: 'MERI' }] }),
    );
    const blocked = await failing.apply(
      {
        invariantType: 'MERI',
        fromStatus: 'shadow',
        toStatus: 'soft_constraint',
        evidence,
        owner: 'ranking-lead',
        createdAt: new Date().toISOString(),
      },
      14,
    );
    expect(blocked).toMatch(/regression suite failing/);
    expect(await failing.statusOf('MERI')).toBe('shadow');
    // Seed an enforced state directly, then demote THROUGH the failing
    // gate: the kill switch must never be blocked by drift.
    await store.append({
      invariantType: 'SCOI',
      fromStatus: 'shadow',
      toStatus: 'soft_constraint',
      evidence: { ...evidence },
      owner: 'ranking-lead',
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });
    const demoted = await failing.apply(
      {
        invariantType: 'SCOI',
        fromStatus: 'soft_constraint',
        toStatus: 'shadow',
        evidence: { ...evidence, driftReportRef: 'incident-9' },
        owner: 'oncall',
        createdAt: new Date().toISOString(),
      },
      14,
    );
    expect(demoted).toBeNull();
    expect(await failing.statusOf('SCOI')).toBe('shadow');
    // The REAL gate (production regression suite) passes today, so a valid
    // upward promotion goes through the default-constructed service.
    const real = createPromotionService(
      store,
      (t) => Object.values(INVARIANT_CARDS).find((c) => c.invariant_type === t) ?? null,
      () => {},
    );
    const promoted = await real.apply(
      {
        invariantType: 'MERI',
        fromStatus: 'shadow',
        toStatus: 'soft_constraint',
        evidence,
        owner: 'ranking-lead',
        createdAt: new Date().toISOString(),
      },
      14,
    );
    expect(promoted).toBeNull();
  });
});

describe('real-time tier latency budget (WS-H.1.2f)', () => {
  it('a slow computation times out at the budget into the degraded path', async () => {
    const fixture = freshInvariantServices();
    await fixture.events.configStore.set('invariants.realtimeLatencyBudgetMs', { value: 50 });
    await fixture.invariants.reloadConfig();
    const { runRealtimeTier } = await import('../invariants/scheduler.js');
    const target = { targetType: 'story' as const, targetId: randomUUID() };
    // Make MERI slow: the budget must cut it off and record the error.
    fixture.invariants.meri.computeRealtime = () =>
      new Promise((resolve) => setTimeout(() => resolve(undefined as never), 500));
    const slow = await runRealtimeTier(fixture.invariants, fixture.events, 'MERI', target);
    expect(slow.ok).toBe(false);
    if (!slow.ok) expect(slow.reasonCodes).toContain('TIMEOUT');
    expect(fixture.invariants.meri.getHealthMetrics().errorCount).toBeGreaterThan(0);
    const runs = await fixture.invariants.runMetadata.listRecent('MERI', 1);
    expect(runs[0]?.tier).toBe('realtime');
    expect(runs[0]?.success).toBe(false);
    // A batch-only service answers within budget via its honest default.
    const batchOnly = await runRealtimeTier(
      fixture.invariants,
      fixture.events,
      'braid_dynamics',
      target,
    );
    expect(batchOnly.ok).toBe(true);
    if (batchOnly.ok) expect(batchOnly.output.reason_codes).toContain('INSUFFICIENT_COVERAGE');
    // Unknown invariant types fail closed.
    const unknown = await runRealtimeTier(fixture.invariants, fixture.events, 'nope', target);
    expect(unknown.ok).toBe(false);
  });
});

describe('tropical → MFCI feature feed (WS-H.7.2b)', () => {
  it('a detected synchronized cascade routes the topic through the MFCI intake', async () => {
    const fixture = freshInvariantServices();
    const sources: Array<{ sourceId: string }> = [];
    for (const domain of ['wire-a.example', 'wire-b.example', 'wire-c.example']) {
      sources.push(await fixture.ingestion.sources.upsertByDomain(domain, { name: domain }));
    }
    // Two content families each reached near-simultaneously from two
    // DISTINCT seeds (three seeds total): a synchronized cascade.
    const mk = async (sourceIdx: number, family: string): Promise<string> => {
      const { storyId } = await seedStory(fixture, {
        topicIds: ['cascade-topic'],
        sourceId: sources[sourceIdx]?.sourceId ?? null,
      });
      await fixture.ingestion.claims.insert({
        claimId: randomUUID(),
        storyId,
        canonicalText: `Claim of family ${family}.`,
        normalizedTextHash: randomUUID().replaceAll('-', ''),
        claimStatus: 'candidate',
        firstSeenStoryId: storyId,
        independenceGroupId: family,
        createdBy: null,
        extractionSource: 'system',
        extractionConfidence: 0.9,
        modelVersion: null,
      });
      return storyId;
    };
    const fed = [
      await mk(0, 'fam-1'),
      await mk(1, 'fam-1'),
      await mk(1, 'fam-2'),
      await mk(2, 'fam-2'),
    ];
    const captured: string[][] = [];
    fixture.events.hooks.mfci = async (event) => {
      captured.push([...(event as unknown as { target_ids: string[] }).target_ids]);
    };
    const { runBatchTier } = await import('../invariants/scheduler.js');
    await runBatchTier(fixture.invariants, fixture.events, fixture.ingestion, Date.now());
    // The tropical output itself is shadow; the FEED is intake routing only.
    expect(captured.length).toBeGreaterThan(0);
    const routed = new Set(captured.flat());
    for (const storyId of fed) expect(routed.has(storyId)).toBe(true);
  });
});

describe('nightly MFCI calibration rebuild (WS-H.3.1a)', () => {
  it('builds volume-conditioned nulls from trailing organic windows', async () => {
    const fixture = freshInvariantServices();
    const { rebuildMfciCalibrations } = await import('../invariants/scheduler.js');
    const nowMs = Date.now();
    const { storyId } = await seedStory(fixture);
    // Ten nonempty hourly windows of organic activity, varied volumes.
    const rows = [];
    for (let h = 1; h <= 10; h += 1) {
      const windowStart = nowMs - h * 3_600_000;
      const count = 5 + (h % 3) * 4;
      for (let i = 0; i < count; i += 1) {
        rows.push({
          eventId: randomUUID(),
          eventType: 'contribution.created',
          topic: 'contribution.created',
          timestamp: new Date(windowStart + 60_000 + i * 90_000).toISOString(),
          privacyClassification: 'public' as const,
          retentionTier: 'public_contribution' as const,
          payload: { story_id: storyId },
          ownerUserId: null,
          purgeAfter: null,
        });
      }
    }
    await fixture.events.eventStore.insertMany(rows);
    await rebuildMfciCalibrations(fixture.invariants, fixture.events, nowMs);
    for (const statistic of ['target_concentration', 'synchrony'] as const) {
      const row = await fixture.invariants.calibrations.get(`mfci:${statistic}`);
      expect(row).not.toBeNull();
      expect(row?.version).toMatch(/^auto:\d{4}-\d{2}-\d{2}$/);
      expect(row?.sampleCount).toBeGreaterThanOrEqual(10);
      const data = row?.data as { buckets: Array<{ sampleCount: number }> };
      expect(data.buckets.length).toBeGreaterThan(0);
    }
  });

  it('keeps the previous calibration when the baseline is too thin', async () => {
    const fixture = freshInvariantServices();
    const { rebuildMfciCalibrations } = await import('../invariants/scheduler.js');
    await fixture.invariants.calibrations.upsert({
      calibrationKey: 'mfci:target_concentration',
      version: 'v-previous',
      data: { buckets: [] },
      sampleCount: 4,
      computedAt: new Date().toISOString(),
    });
    await rebuildMfciCalibrations(fixture.invariants, fixture.events, Date.now());
    const kept = await fixture.invariants.calibrations.get('mfci:target_concentration');
    expect(kept?.version).toBe('v-previous');
  });

  // WS-O.4.5 — a contribution.created event on `storyId` at `atMs`.
  const calibEvent = (storyId: string, atMs: number) => ({
    eventId: randomUUID(),
    eventType: 'contribution.created' as const,
    topic: 'contribution.created',
    timestamp: new Date(atMs).toISOString(),
    privacyClassification: 'public' as const,
    retentionTier: 'public_contribution' as const,
    payload: { story_id: storyId },
    ownerUserId: null,
    purgeAfter: null,
  });

  it('EXCLUDES windows touching an under-case target (anti-poisoning, WS-O.4.5)', async () => {
    const fixture = freshInvariantServices();
    const { rebuildMfciCalibrations } = await import('../invariants/scheduler.js');
    // Hour-aligned so each window's events stay within ONE hour bucket
    // (otherwise the wall-clock phase can straddle a boundary nondeterministically).
    const nowMs = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const organic = await seedStory(fixture);
    const attacked = await seedStory(fixture);
    // An OPEN case on the attacked target → its windows must be dropped.
    await fixture.invariants.mfciCases.insert({
      caseId: randomUUID(),
      targetType: 'story',
      targetId: attacked.storyId,
      riskState: 'high',
      statistic: 'target_concentration',
      mfciScore: 6,
      pHat: 0.002,
      sampleCount: 100,
      fixedMarginsRef: 'cheap:test',
      summary: '{}',
      appealSummary: '',
      status: 'open',
      openedAt: new Date(nowMs).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    });
    const rows = [];
    for (let h = 1; h <= 8; h += 1) {
      const windowStart = nowMs - h * 3_600_000;
      for (let i = 0; i < 6; i += 1)
        rows.push(calibEvent(organic.storyId, windowStart + i * 90_000));
    }
    // One poisoned window: a concentrated burst on the under-case target.
    const poisonStart = nowMs - 9 * 3_600_000;
    for (let i = 0; i < 20; i += 1)
      rows.push(calibEvent(attacked.storyId, poisonStart + i * 60_000));
    await fixture.events.eventStore.insertMany(rows);
    await rebuildMfciCalibrations(fixture.invariants, fixture.events, nowMs);
    // Only the 8 organic windows contributed; the poisoned window was excluded.
    const row = await fixture.invariants.calibrations.get('mfci:target_concentration');
    expect(row?.sampleCount).toBe(8);
  });

  it('ALERTS and RETAINS the previous calibration on a poisoning q99 jump (WS-O.4.5)', async () => {
    const fixture = freshInvariantServices();
    const { rebuildMfciCalibrations } = await import('../invariants/scheduler.js');
    const nowMs = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    // A SENSITIVE previous calibration (low q99 in the small-volume bucket).
    await fixture.invariants.calibrations.upsert({
      calibrationKey: 'mfci:target_concentration',
      version: 'v-sensitive',
      data: {
        statistic: 'target_concentration',
        version: 'v-sensitive',
        computedAtMs: nowMs,
        buckets: [{ minVolume: 0, q50: 0.1, q90: 0.15, q99: 0.2, sampleCount: 50 }],
      },
      sampleCount: 50,
      computedAt: new Date(nowMs).toISOString(),
    });
    // A POISONED baseline: every window concentrates on one target →
    // target_concentration ≈ 1 → the new q99 ≫ 1.5 × 0.2.
    const story = await seedStory(fixture);
    const rows = [];
    for (let h = 1; h <= 8; h += 1) {
      const windowStart = nowMs - h * 3_600_000;
      for (let i = 0; i < 6; i += 1) rows.push(calibEvent(story.storyId, windowStart + i * 90_000));
    }
    await fixture.events.eventStore.insertMany(rows);
    await rebuildMfciCalibrations(fixture.invariants, fixture.events, nowMs);
    // The drift alert fired and the SENSITIVE calibration was retained.
    expect(fixture.events.metrics.counter('invariants.mfci.calibration_drift')).toBeGreaterThan(0);
    const kept = await fixture.invariants.calibrations.get('mfci:target_concentration');
    expect(kept?.version).toBe('v-sensitive');
  });
});
