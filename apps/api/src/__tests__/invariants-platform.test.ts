// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1 platform tests: the fallback execution wrapper (failure/timeout →
// degraded envelope + gap record; ranking proceeds with one, two, or ALL
// invariants failing), score-vector validation before persistence, the
// shadow flag on every persisted row + the ranking-boundary rejection, the
// promotion service end-to-end (no advance without a valid record; demotion
// kill switch without redeploy), fail-closed config loading, the scheduler
// tick, and uniform health metrics.

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
import { freshWsHServices, seedStory } from './ws-h-helpers.js';

function runnerDeps(fixture: ReturnType<typeof freshWsHServices>) {
  return {
    runMetadata: fixture.invariants.runMetadata,
    metrics: fixture.events.metrics,
    log: () => {},
    now: Date.now,
  };
}

describe('WS-H.1.2c fallback execution wrapper', () => {
  it('a throwing invariant yields a degraded envelope and a gap record', async () => {
    const fixture = freshWsHServices();
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
    const fixture = freshWsHServices();
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
    const fixture = freshWsHServices();
    const candidates = [
      { storyId: '11111111-1111-4111-8111-111111111111', createdAt: '2026-06-10T10:00:00.000Z' },
      { storyId: '22222222-2222-4222-8222-222222222222', createdAt: '2026-06-11T10:00:00.000Z' },
    ];
    const failures: string[] = [];
    for (const failing of [1, 2, 11]) {
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
    expect(failures.length).toBe(14);
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
    const fixture = freshWsHServices();
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
    const fixture = freshWsHServices();
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

  it('status starts shadow; effects stay disabled without a valid promotion', async () => {
    const fixture = freshWsHServices();
    expect(await fixture.invariants.promotionService.statusOf('MERI')).toBe('shadow');
    expect(await fixture.invariants.promotionService.effectsEnabled('MERI')).toBe(false);
    const rejected = await fixture.invariants.promotionService.apply(
      {
        invariantType: 'MERI',
        fromStatus: 'shadow',
        toStatus: 'soft_constraint',
        evidence: { ...evidence, shadowDurationDays: 2 },
        owner: 'ranking-lead',
        createdAt: new Date().toISOString(),
      },
      14,
    );
    expect(rejected).toMatch(/shadow days/);
    expect(await fixture.invariants.promotionService.effectsEnabled('MERI')).toBe(false);
  });

  it('promotion enables effects; demotion (kill switch) disables without redeploy', async () => {
    const fixture = freshWsHServices();
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
    const fixture = freshWsHServices();
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
});

describe('WS-H.1.2f scheduler tick', () => {
  it('runs the batch tier for all invariants, persists shadow rows, records health', async () => {
    const fixture = freshWsHServices();
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
  });
});
