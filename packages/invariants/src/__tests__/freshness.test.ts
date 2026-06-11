// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.4g — freshness baseline math. Property-tests the documented
// guarantees: bounded (0, 1], strictly decreasing in every age, topic-cadence
// normalization (slower topic ⇒ never less fresh), graceful degradation when
// the event time / topic baseline are unknown, and config validation.
import { describe, expect, it } from 'vitest';
import {
  computeFreshnessScore,
  DEFAULT_FRESHNESS_CONFIG,
  FRESHNESS_FEATURE_VERSION,
  type FreshnessInput,
  topicTauMs,
  validateFreshnessConfig,
} from '../freshness/baseline.js';
import { forAll, int } from './prop.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-06-11T12:00:00.000Z');

function input(overrides: Partial<FreshnessInput> = {}): FreshnessInput {
  return {
    nowMs: NOW,
    submittedAtMs: NOW - 6 * HOUR,
    lastMaterialUpdateMs: NOW - 2 * HOUR,
    eventTimeMs: NOW - 12 * HOUR,
    topicMedianInterArrivalMs: 4 * HOUR,
    ...overrides,
  };
}

describe('computeFreshnessScore (WS-F.1.4g)', () => {
  it('pins the feature version for reproducibility (§21.4)', () => {
    expect(FRESHNESS_FEATURE_VERSION).toBe(1);
  });

  it('property: score is always in (0, 1] for arbitrary valid inputs', () => {
    forAll(
      11,
      400,
      (rng) =>
        input({
          submittedAtMs: NOW - int(rng, 0, 60 * DAY),
          lastMaterialUpdateMs: NOW - int(rng, 0, 60 * DAY),
          eventTimeMs: rng() < 0.3 ? undefined : NOW - int(rng, 0, 90 * DAY),
          topicMedianInterArrivalMs: rng() < 0.2 ? null : int(rng, 1, 7 * DAY),
        }),
      (value) => {
        const score = computeFreshnessScore(value);
        return (score > 0 && score <= 1) || `score ${score} out of (0, 1]`;
      },
    );
  });

  it('property: WEAKLY decreasing in every age over the full range (never increases)', () => {
    // Strict decrease cannot hold in IEEE-754 once a term decays below the
    // ulp of the score (e.g. exp(−60) added to 0.3 is absorbed) — see the
    // module header. Weak monotonicity is the exact float-level guarantee.
    forAll(
      12,
      400,
      (rng) => ({
        base: input({
          submittedAtMs: NOW - int(rng, 0, 90 * DAY),
          lastMaterialUpdateMs: NOW - int(rng, 0, 90 * DAY),
          eventTimeMs: NOW - int(rng, 0, 90 * DAY),
        }),
        extraAge: int(rng, 1_000, 30 * DAY),
      }),
      ({ base, extraAge }) => {
        const fresh = computeFreshnessScore(base);
        const olderSubmit = computeFreshnessScore({
          ...base,
          submittedAtMs: base.submittedAtMs - extraAge,
        });
        const olderUpdate = computeFreshnessScore({
          ...base,
          lastMaterialUpdateMs: (base.lastMaterialUpdateMs as number) - extraAge,
        });
        const olderEvent = computeFreshnessScore({
          ...base,
          eventTimeMs: (base.eventTimeMs as number) - extraAge,
        });
        if (olderSubmit > fresh) return `older submission scored higher`;
        if (olderUpdate > fresh) return `older update scored higher`;
        if (olderEvent > fresh) return `older event scored higher`;
        return true;
      },
    );
  });

  it('property: STRICTLY decreasing within the fresh regime (ages ≤ 3 days)', () => {
    // Within any practical ranking horizon every term is far above the ulp
    // of the score, so the exact-arithmetic strict decrease is observable.
    forAll(
      13,
      400,
      (rng) => ({
        base: input({
          submittedAtMs: NOW - int(rng, 0, 3 * DAY),
          lastMaterialUpdateMs: NOW - int(rng, 0, 3 * DAY),
          eventTimeMs: NOW - int(rng, 0, 3 * DAY),
        }),
        extraAge: int(rng, 60_000, DAY),
      }),
      ({ base, extraAge }) => {
        const fresh = computeFreshnessScore(base);
        const olderSubmit = computeFreshnessScore({
          ...base,
          submittedAtMs: base.submittedAtMs - extraAge,
        });
        const olderUpdate = computeFreshnessScore({
          ...base,
          lastMaterialUpdateMs: (base.lastMaterialUpdateMs as number) - extraAge,
        });
        const olderEvent = computeFreshnessScore({
          ...base,
          eventTimeMs: (base.eventTimeMs as number) - extraAge,
        });
        if (!(olderSubmit < fresh)) return `submission age did not strictly decrease score`;
        if (!(olderUpdate < fresh)) return `update age did not strictly decrease score`;
        if (!(olderEvent < fresh)) return `event age did not strictly decrease score`;
        return true;
      },
    );
  });

  it('property: a slower topic cadence never scores lower (topic normalization)', () => {
    forAll(
      14,
      300,
      (rng) => ({
        base: input({
          submittedAtMs: NOW - int(rng, 1, 20 * DAY),
          topicMedianInterArrivalMs: int(rng, HOUR, DAY),
        }),
        factor: 1 + int(rng, 1, 20),
      }),
      ({ base, factor }) => {
        const fast = computeFreshnessScore(base);
        const slow = computeFreshnessScore({
          ...base,
          topicMedianInterArrivalMs: (base.topicMedianInterArrivalMs as number) * factor,
        });
        return slow >= fast || `slower topic scored lower: ${slow} < ${fast}`;
      },
    );
  });

  it('high- vs low-cadence topics: the same 12h-old story is fresher in the slow topic', () => {
    const base = input({ submittedAtMs: NOW - 12 * HOUR, lastMaterialUpdateMs: NOW - 12 * HOUR });
    const fastTopic = computeFreshnessScore({ ...base, topicMedianInterArrivalMs: HOUR });
    const slowTopic = computeFreshnessScore({ ...base, topicMedianInterArrivalMs: 3 * DAY });
    expect(slowTopic).toBeGreaterThan(fastTopic);
  });

  it('unknown event time redistributes weight (never penalizes vs an ancient event)', () => {
    const unknown = computeFreshnessScore(input({ eventTimeMs: undefined }));
    const ancient = computeFreshnessScore(input({ eventTimeMs: NOW - 365 * DAY }));
    expect(unknown).toBeGreaterThan(ancient);
    // Exact redistribution: (w_s + w_e)·S + w_u·U.
    const config = DEFAULT_FRESHNESS_CONFIG;
    const tau = topicTauMs(4 * HOUR, config);
    const expected =
      (config.submitWeight + config.eventWeight) * Math.exp(-(6 * HOUR) / tau) +
      config.updateWeight * Math.exp(-(2 * HOUR) / config.updateTauMs);
    expect(unknown).toBeCloseTo(expected, 12);
  });

  it('clamps clock skew: a future timestamp behaves as age 0, score ≤ 1', () => {
    const skewed = computeFreshnessScore(
      input({
        submittedAtMs: NOW + DAY,
        lastMaterialUpdateMs: NOW + DAY,
        eventTimeMs: NOW + DAY,
      }),
    );
    expect(skewed).toBeLessThanOrEqual(1);
    expect(skewed).toBeCloseTo(1, 12);
  });

  it('is deterministic', () => {
    expect(computeFreshnessScore(input())).toBe(computeFreshnessScore(input()));
  });
});

describe('topicTauMs', () => {
  it('clamps to [min, max] and falls back to the geometric midpoint when unknown', () => {
    const config = DEFAULT_FRESHNESS_CONFIG;
    expect(topicTauMs(1, config)).toBe(config.topicTauMinMs);
    expect(topicTauMs(365 * DAY, config)).toBe(config.topicTauMaxMs);
    const midpoint = Math.sqrt(config.topicTauMinMs * config.topicTauMaxMs);
    expect(topicTauMs(null, config)).toBeCloseTo(midpoint, 6);
    expect(topicTauMs(undefined, config)).toBeCloseTo(midpoint, 6);
    expect(topicTauMs(Number.NaN, config)).toBeCloseTo(midpoint, 6);
  });
});

describe('validateFreshnessConfig', () => {
  it('accepts the default config', () => {
    expect(validateFreshnessConfig(DEFAULT_FRESHNESS_CONFIG)).toBeNull();
  });

  it('rejects weights that do not sum to 1, negatives, and bad taus', () => {
    expect(validateFreshnessConfig({ ...DEFAULT_FRESHNESS_CONFIG, submitWeight: 0.9 })).toMatch(
      /sum to 1/,
    );
    expect(
      validateFreshnessConfig({
        ...DEFAULT_FRESHNESS_CONFIG,
        submitWeight: -0.1,
        updateWeight: 0.9,
        eventWeight: 0.2,
      }),
    ).toMatch(/non-negative/);
    expect(validateFreshnessConfig({ ...DEFAULT_FRESHNESS_CONFIG, topicTauMinMs: 0 })).toMatch(
      /clamp/,
    );
    expect(validateFreshnessConfig({ ...DEFAULT_FRESHNESS_CONFIG, updateTauMs: 0 })).toMatch(/tau/);
  });
});
