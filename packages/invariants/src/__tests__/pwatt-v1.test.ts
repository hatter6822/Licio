// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PWAtt v1 acceptance + property tests (WS-E.2.3a-e): saturation curves,
// weight normalization with guardrails, the contribution hierarchy, penalty
// separation (can drive below zero), and the safety-state machine.
import { describe, expect, it } from 'vitest';
import {
  applyPenalties,
  applySafetyStateToComponents,
  applySafetyStateToScore,
  applySaturation,
  assertV1HierarchyOrder,
  assertValidRankingProfile,
  computePwattV1,
  DEFAULT_PENALTY_COEFFICIENTS,
  DEFAULT_RANKING_PROFILES,
  DIMENSION_DOMINANCE_CAP_PCT,
  type ProfileSelectionContext,
  type RankingProfile,
  type SaturationCurve,
  saturate,
  selectRankingProfile,
  transitionItemSafetyState,
  V1_CONTRIBUTION_WEIGHTS,
  V1_PLACEHOLDER_PENALTY_INPUTS,
  validateRankingProfile,
  validateSaturationDimensions,
  WEIGHT_GUARDRAILS,
} from '../index.js';
import { float, forAll, int, pick } from './prop.js';

const LOG_CURVE: SaturationCurve = { kind: 'logarithmic', scale: 2, saturationPoint: 20 };
const SIG_CURVE: SaturationCurve = { kind: 'sigmoid', scale: 4 };

describe('saturation curves (WS-E.2.3a)', () => {
  it('first instance contributes more than the second, which more than the third', () => {
    for (const curve of [LOG_CURVE, SIG_CURVE]) {
      const m1 = saturate(1, curve) - saturate(0, curve);
      const m2 = saturate(2, curve) - saturate(1, curve);
      const m3 = saturate(3, curve) - saturate(2, curve);
      expect(m1).toBeGreaterThan(m2);
      expect(m2).toBeGreaterThan(m3);
    }
  });

  it('f(0) = 0 and totality on hostile inputs', () => {
    for (const curve of [LOG_CURVE, SIG_CURVE]) {
      expect(saturate(0, curve)).toBe(0);
      expect(saturate(-5, curve)).toBe(0);
      expect(saturate(Number.NaN, curve)).toBe(0);
      expect(saturate(Number.POSITIVE_INFINITY, curve)).toBeLessThanOrEqual(1);
    }
  });

  it('property: monotone, bounded, and concave (diminishing marginals)', () => {
    forAll(
      606,
      400,
      (rng) => ({
        curve: (rng() < 0.5
          ? { kind: 'logarithmic', scale: float(rng, 0.5, 10), saturationPoint: float(rng, 5, 100) }
          : { kind: 'sigmoid', scale: float(rng, 0.5, 10) }) as SaturationCurve,
        n: int(rng, 0, 200),
      }),
      ({ curve, n }) => {
        const fN = saturate(n, curve);
        const fN1 = saturate(n + 1, curve);
        const fN2 = saturate(n + 2, curve);
        if (!(fN >= 0 && fN <= 1)) return `out of range: f(${n})=${fN}`;
        if (fN1 < fN) return `not monotone at ${n}`;
        // Concavity (allowing exact equality on the flat cap segment).
        const m1 = fN1 - fN;
        const m2 = fN2 - fN1;
        return m2 <= m1 + 1e-12 || `marginals increased at ${n}: ${m1} -> ${m2}`;
      },
    );
  });

  it('enforces the 50% dominance cap and exact-100 sum at config time', () => {
    expect(DIMENSION_DOMINANCE_CAP_PCT).toBe(50);
    expect(() =>
      validateSaturationDimensions({
        a: { weightPct: 60, curve: LOG_CURVE },
        b: { weightPct: 40, curve: LOG_CURVE },
      }),
    ).toThrow(/dominance cap/);
    expect(() =>
      validateSaturationDimensions({
        a: { weightPct: 50, curve: LOG_CURVE },
        b: { weightPct: 40, curve: LOG_CURVE },
      }),
    ).toThrow(/sum to exactly 100/);
    expect(() =>
      validateSaturationDimensions({
        a: { weightPct: 50, curve: LOG_CURVE },
        b: { weightPct: 30, curve: SIG_CURVE },
        c: { weightPct: 20, curve: LOG_CURVE },
      }),
    ).not.toThrow();
  });

  it('property: no dimension ever exceeds 50% of the total positive budget', () => {
    const dimensions = {
      dwell: { weightPct: 50, curve: LOG_CURVE },
      source: { weightPct: 30, curve: SIG_CURVE },
      context: { weightPct: 20, curve: LOG_CURVE },
    } as const;
    forAll(
      707,
      300,
      (rng) => ({
        dwell: int(rng, 0, 1_000_000),
        source: int(rng, 0, 1_000_000),
        context: int(rng, 0, 1_000_000),
      }),
      (counts) => {
        const { perDimension, total } = applySaturation(counts, dimensions);
        for (const [name, value] of Object.entries(perDimension)) {
          if (value > 0.5) return `${name} exceeded 50% cap: ${value}`;
        }
        return (total >= 0 && total <= 1) || `total out of range: ${total}`;
      },
    );
  });

  it('property: adding more of any signal never decreases the total', () => {
    const dimensions = {
      a: { weightPct: 50, curve: LOG_CURVE },
      b: { weightPct: 50, curve: SIG_CURVE },
    } as const;
    forAll(
      808,
      300,
      (rng) => ({ a: int(rng, 0, 500), b: int(rng, 0, 500), bump: pick(rng, ['a', 'b'] as const) }),
      ({ a, b, bump }) => {
        const before = applySaturation({ a, b }, dimensions).total;
        const after = applySaturation(
          { a: a + (bump === 'a' ? 5 : 0), b: b + (bump === 'b' ? 5 : 0) },
          dimensions,
        ).total;
        return after >= before - 1e-12 || `total decreased ${before} -> ${after}`;
      },
    );
  });
});

describe('contribution-type hierarchy (WS-E.2.3b)', () => {
  it('orders evidence > correction > synthesis > question > counterexample > explanation > low_info_reply', () => {
    expect(() => assertV1HierarchyOrder()).not.toThrow();
    const w = V1_CONTRIBUTION_WEIGHTS;
    expect(w.evidence).toBeGreaterThan(w.correction);
    expect(w.correction).toBeGreaterThan(w.synthesis);
    expect(w.synthesis).toBeGreaterThan(w.question);
    expect(w.question).toBeGreaterThan(w.counterexample);
    expect(w.counterexample).toBeGreaterThan(w.explanation);
    expect(w.explanation).toBeGreaterThan(w.low_info_reply);
    expect(w.low_info_reply).toBe(0);
  });

  it('gives bridge comments strong positive weight and stewards thread-health weight', () => {
    expect(V1_CONTRIBUTION_WEIGHTS.bridge_comment).toBeGreaterThanOrEqual(0.8);
    expect(V1_CONTRIBUTION_WEIGHTS.steward_action).toBeGreaterThan(0);
  });

  it('rejects a broken hierarchy', () => {
    expect(() => assertV1HierarchyOrder({ ...V1_CONTRIBUTION_WEIGHTS, correction: 1.5 })).toThrow(
      /evidence must outweigh correction/,
    );
    expect(() =>
      assertV1HierarchyOrder({ ...V1_CONTRIBUTION_WEIGHTS, low_info_reply: 0.1 }),
    ).toThrow(/low_info_reply/);
  });
});

describe('weight normalization (WS-E.2.3c)', () => {
  it('accepts the two default profiles (sum 100, in guardrails)', () => {
    expect(DEFAULT_RANKING_PROFILES).toHaveLength(2);
    for (const profile of DEFAULT_RANKING_PROFILES) {
      expect(validateRankingProfile(profile).ok, profile.name).toBe(true);
    }
  });

  it('rejects profiles that do not sum to 100', () => {
    const bad: RankingProfile = {
      name: 'bad',
      weights: { wA: 30, wP: 30, wE: 15, wS: 15, wC: 15 },
    };
    const result = validateRankingProfile(bad);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/sum to exactly 100, got 105/);
  });

  it('rejects out-of-guardrail weights', () => {
    const bad: RankingProfile = {
      name: 'bad',
      weights: { wA: 45, wP: 25, wE: 10, wS: 10, wC: 10 },
    };
    const result = validateRankingProfile(bad);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/wA=45 outside guardrail \[20, 30\]/);
    expect(() => assertValidRankingProfile(bad)).toThrow(/invalid ranking profile/);
  });

  it('guardrails are jointly satisfiable (min sum <= 100 <= max sum)', () => {
    const minSum = Object.values(WEIGHT_GUARDRAILS).reduce((s, g) => s + g.min, 0);
    const maxSum = Object.values(WEIGHT_GUARDRAILS).reduce((s, g) => s + g.max, 0);
    expect(minSum).toBeLessThanOrEqual(100);
    expect(maxSum).toBeGreaterThanOrEqual(100);
  });

  it('selects by context; sensitive/elevated contexts use the conservative profile', () => {
    const breaking: ProfileSelectionContext = {
      surface: 'feed',
      freshness: 'breaking',
      topicSensitivity: 'standard',
      riskState: 'normal',
    };
    expect(selectRankingProfile(breaking).name).toBe('breaking_news');
    expect(selectRankingProfile({ ...breaking, topicSensitivity: 'sensitive' }).name).toBe(
      'evergreen_science',
    );
    expect(selectRankingProfile({ ...breaking, riskState: 'elevated' }).name).toBe(
      'evergreen_science',
    );
    expect(selectRankingProfile({ ...breaking, freshness: 'evergreen' }).name).toBe(
      'evergreen_science',
    );
  });

  it('profile selection context carries NO payment/wallet field (type firewall)', () => {
    const context: ProfileSelectionContext = {
      surface: 'feed',
      freshness: 'recent',
      topicSensitivity: 'standard',
      riskState: 'normal',
    };
    // Runtime mirror of the compile-time guarantee: the context type has
    // exactly these four keys — adding a wallet/payment input would fail here.
    expect(Object.keys(context).sort()).toEqual(
      ['freshness', 'riskState', 'surface', 'topicSensitivity'].sort(),
    );
  });
});

describe('penalty integration (WS-E.2.3d)', () => {
  it('subtracts penalties outside the convex combination and can go below zero', () => {
    const result = applyPenalties(
      0.6,
      { pM: 2, pH: 1, pT: 1, pR: 1 },
      { coordination: 0.9, holonomy: 0, tension: 0, redundancy: 0.4 },
    );
    expect(result.total).toBeCloseTo(0.6 - 2 * 0.9 - 0.4, 10);
    expect(result.total).toBeLessThan(0);
  });

  it('rejects negative coefficients (a penalty can never become a reward)', () => {
    expect(() =>
      applyPenalties(0.5, { pM: -1, pH: 0, pT: 0, pR: 0 }, V1_PLACEHOLDER_AND_ZERO),
    ).toThrow(/finite and >= 0/);
  });

  const V1_PLACEHOLDER_AND_ZERO = {
    coordination: 0,
    redundancy: 0,
    ...V1_PLACEHOLDER_PENALTY_INPUTS,
  };

  it('placeholder pH/pT inputs are zero and have no effect (v1)', () => {
    const withPlaceholders = applyPenalties(0.8, DEFAULT_PENALTY_COEFFICIENTS, {
      coordination: 0.2,
      redundancy: 0.1,
      ...V1_PLACEHOLDER_PENALTY_INPUTS,
    });
    const explicit = applyPenalties(0.8, DEFAULT_PENALTY_COEFFICIENTS, {
      coordination: 0.2,
      redundancy: 0.1,
      holonomy: 0,
      tension: 0,
    });
    expect(withPlaceholders.total).toBe(explicit.total);
    const holonomy = withPlaceholders.applied.find((p) => p.name === 'holonomy');
    expect(holonomy?.delta).toBe(0);
  });

  it('logs every penalty application (name, coefficient, input, delta)', () => {
    const { applied } = applyPenalties(1, DEFAULT_PENALTY_COEFFICIENTS, {
      coordination: 0.5,
      holonomy: 0,
      tension: 0,
      redundancy: 0.2,
    });
    expect(applied.map((p) => p.name)).toEqual([
      'coordination',
      'holonomy',
      'tension',
      'redundancy',
    ]);
    for (const term of applied) {
      expect(term.delta).toBeCloseTo(term.coefficient * term.input, 12);
      expect(term.delta).toBeGreaterThanOrEqual(0);
    }
  });

  it('property: penalties never increase the score', () => {
    forAll(
      909,
      300,
      (rng) => ({
        positive: float(rng, 0, 2),
        coeffs: {
          pM: float(rng, 0, 3),
          pH: float(rng, 0, 3),
          pT: float(rng, 0, 3),
          pR: float(rng, 0, 3),
        },
        inputs: {
          coordination: float(rng, 0, 1),
          holonomy: float(rng, 0, 1),
          tension: float(rng, 0, 1),
          redundancy: float(rng, 0, 1),
        },
      }),
      ({ positive, coeffs, inputs }) => {
        const { total } = applyPenalties(positive, coeffs, inputs);
        return total <= positive || `penalties increased score ${positive} -> ${total}`;
      },
    );
  });
});

describe('v1 composition (WS-E.2.3)', () => {
  const profile = DEFAULT_RANKING_PROFILES[0];
  if (!profile) throw new Error('default profiles missing');

  it('computes B + convex combination − penalties', () => {
    const result = computePwattV1({
      baseline: 0.2,
      components: {
        activeAttention: 0.5,
        participation: 0.4,
        exposureIndependence: 0,
        evidenceCompleteness: 0,
        contextCoherence: 0,
      },
      profile,
      penaltyCoefficients: { pM: 1, pH: 1, pT: 1, pR: 1 },
      penaltyInputs: { coordination: 0.1, holonomy: 0, tension: 0, redundancy: 0 },
    });
    // 0.2 + (30·0.5 + 25·0.4)/100 − 0.1 = 0.2 + 0.25 − 0.1
    expect(result.positive).toBeCloseTo(0.45, 12);
    expect(result.total).toBeCloseTo(0.35, 12);
    expect(result.profileName).toBe('breaking_news');
  });

  it('refuses an invalid profile (config-time rejection reaches the formula)', () => {
    expect(() =>
      computePwattV1({
        baseline: 0,
        components: {
          activeAttention: 0,
          participation: 0,
          exposureIndependence: 0,
          evidenceCompleteness: 0,
          contextCoherence: 0,
        },
        profile: { name: 'bad', weights: { wA: 50, wP: 25, wE: 10, wS: 10, wC: 5 } },
        penaltyCoefficients: DEFAULT_PENALTY_COEFFICIENTS,
        penaltyInputs: { coordination: 0, holonomy: 0, tension: 0, redundancy: 0 },
      }),
    ).toThrow(/invalid ranking profile/);
  });
});

describe('safety-state constraints (WS-E.2.3e)', () => {
  it('walks the legal transitions and rejects illegal ones', () => {
    expect(transitionItemSafetyState('normal', 'flag')).toEqual({ ok: true, next: 'frozen' });
    expect(transitionItemSafetyState('frozen', 'clear')).toEqual({ ok: true, next: 'normal' });
    expect(transitionItemSafetyState('frozen', 'remove')).toEqual({ ok: true, next: 'removed' });
    expect(transitionItemSafetyState('normal', 'remove')).toEqual({ ok: true, next: 'removed' });
    expect(transitionItemSafetyState('normal', 'clear').ok).toBe(false);
    expect(transitionItemSafetyState('removed', 'clear').ok).toBe(false);
    expect(transitionItemSafetyState('removed', 'flag').ok).toBe(false);
  });

  it('pins the score while frozen, zeroes removed, passes normal through', () => {
    expect(applySafetyStateToScore({ safetyState: 'normal', frozenScore: null }, 0.7)).toBe(0.7);
    expect(applySafetyStateToScore({ safetyState: 'frozen', frozenScore: 0.4 }, 0.9)).toBe(0.4);
    expect(applySafetyStateToScore({ safetyState: 'frozen', frozenScore: null }, 0.9)).toBe(0);
    expect(applySafetyStateToScore({ safetyState: 'removed', frozenScore: 0.4 }, 0.9)).toBe(0);
  });

  it('pins the SERVED COMPONENTS while frozen (§5.3 freeze growth), zeroes removed', () => {
    const candidate = { activeAttention: 0.9, participation: 0.8 };
    // normal ⇒ passthrough.
    expect(
      applySafetyStateToComponents({ safetyState: 'normal', frozenScore: null }, candidate),
    ).toEqual(candidate);
    // frozen ⇒ pinned at the freeze-time level (growth denied).
    expect(
      applySafetyStateToComponents(
        {
          safetyState: 'frozen',
          frozenScore: 0.4,
          frozenActiveAttention: 0.3,
          frozenParticipation: 0.2,
        },
        candidate,
      ),
    ).toEqual({ activeAttention: 0.3, participation: 0.2 });
    // frozen with no captured level ⇒ pinned to 0 (first-window cascade).
    expect(
      applySafetyStateToComponents({ safetyState: 'frozen', frozenScore: null }, candidate),
    ).toEqual({ activeAttention: 0, participation: 0 });
    // removed ⇒ zeroed regardless of any pinned level.
    expect(
      applySafetyStateToComponents(
        { safetyState: 'removed', frozenScore: null, frozenActiveAttention: 0.5 },
        candidate,
      ),
    ).toEqual({ activeAttention: 0, participation: 0 });
  });
});
