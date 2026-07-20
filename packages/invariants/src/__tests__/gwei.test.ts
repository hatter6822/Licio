// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GWEI tests (WS-H.5): pseudometric/measure validation, log-domain
// Sinkhorn marginal accuracy, coupling rounding exactness, entropic GW on
// identical vs dissimilar spaces, seed/regularization stability, the seven
// experience metrics, k-anonymity suppression, and the release gate.
import { describe, expect, it } from 'vitest';
import {
  buildMetricMeasureSpace,
  type CohortExposureItem,
  DEFAULT_RELATION_WEIGHTS,
  entropicGw,
  evaluateReleaseGate,
  experienceMetrics,
  type GweiItemFeatures,
  gwDistanceWithStability,
  gwObjective,
  logDomainSinkhorn,
  type MetricMeasureSpace,
  roundToCoupling,
  suppressBelowK,
  validatePseudometric,
  validateRelationWeights,
} from '../gwei/index.js';
import { mulberry32 } from '../math/rng.js';

function randomSpace(seed: number, n: number, scale = 1): MetricMeasureSpace {
  const rng = mulberry32(seed);
  const points = Array.from({ length: n }, () => [rng() * scale, rng() * scale]);
  const distances = points.map((p) =>
    points.map((q) => Math.hypot((p[0] ?? 0) - (q[0] ?? 0), (p[1] ?? 0) - (q[1] ?? 0))),
  );
  const weights = Array.from({ length: n }, () => 0.5 + rng());
  const total = weights.reduce((a, b) => a + b, 0);
  return {
    itemIds: points.map((_, i) => `i${i}`),
    distances,
    measure: weights.map((w) => w / total),
  };
}

describe('GWEI metric-measure spaces (WS-H.5.2a)', () => {
  const item = (id: string, extra: Partial<GweiItemFeatures> = {}): GweiItemFeatures => ({
    itemId: id,
    semantic: [1, 0],
    sourceKey: 's1',
    evidenceKeys: ['e1'],
    communityKeys: ['c1'],
    weight: 1,
    ...extra,
  });

  it('builds a valid pseudometric and a probability measure', () => {
    const space = buildMetricMeasureSpace([
      item('a'),
      item('b', { semantic: [0, 1], sourceKey: 's2' }),
      item('c', { weight: 2 }),
    ]);
    expect(validatePseudometric(space.distances)).toBeNull();
    expect(space.measure.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('drops nonpositive-mass items and rejects empty cohorts', () => {
    const space = buildMetricMeasureSpace([item('a'), item('b', { weight: 0 })]);
    expect(space.itemIds).toEqual(['a']);
    expect(() => buildMetricMeasureSpace([item('z', { weight: 0 })])).toThrow(/positive-mass/);
  });

  it('validates relation weights', () => {
    expect(validateRelationWeights(DEFAULT_RELATION_WEIGHTS)).toBeNull();
    expect(validateRelationWeights({ semantic: -1, source: 0, evidence: 0, community: 0 })).toMatch(
      /nonnegative/,
    );
    expect(validateRelationWeights({ semantic: 0, source: 0, evidence: 0, community: 0 })).toMatch(
      /positive/,
    );
  });

  it('validatePseudometric rejects asymmetry and nonzero diagonals', () => {
    expect(
      validatePseudometric([
        [0, 1],
        [2, 0],
      ]),
    ).toMatch(/symmetric/);
    expect(
      validatePseudometric([
        [1, 1],
        [1, 0],
      ]),
    ).toMatch(/diagonal/);
  });
});

describe('GWEI Sinkhorn and rounding (WS-H.5.2b internals)', () => {
  it('log-domain Sinkhorn matches the prescribed marginals', () => {
    const cost = [
      [0, 1, 2],
      [1, 0, 1],
    ];
    const a = [0.6, 0.4];
    const b = [0.3, 0.3, 0.4];
    const pi = logDomainSinkhorn(cost, a, b, { epsilon: 0.05, maxIterations: 2000 });
    const rows = pi.map((row) => row.reduce((x, y) => x + y, 0));
    const cols = [0, 1, 2].map((j) => pi.reduce((acc, row) => acc + (row[j] ?? 0), 0));
    rows.forEach((r, i) => {
      expect(r).toBeCloseTo(a[i] ?? 0, 6);
    });
    cols.forEach((c, j) => {
      expect(c).toBeCloseTo(b[j] ?? 0, 6);
    });
  });

  it('rounding returns exact marginals from a perturbed plan', () => {
    const a = [0.5, 0.5];
    const b = [0.25, 0.75];
    const sloppy = [
      [0.2, 0.35],
      [0.1, 0.3],
    ];
    const rounded = roundToCoupling(sloppy, a, b);
    const rows = rounded.map((row) => row.reduce((x, y) => x + y, 0));
    const cols = [0, 1].map((j) => rounded.reduce((acc, row) => acc + (row[j] ?? 0), 0));
    expect(rows[0]).toBeCloseTo(0.5, 12);
    expect(rows[1]).toBeCloseTo(0.5, 12);
    expect(cols[0]).toBeCloseTo(0.25, 12);
    expect(cols[1]).toBeCloseTo(0.75, 12);
    for (const row of rounded) for (const v of row) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('the decomposed objective equals the quadruple sum on a coupling', () => {
    const spaceA = randomSpace(3, 4);
    const spaceB = randomSpace(4, 3);
    const pi = roundToCoupling(
      spaceA.measure.map((ai) => spaceB.measure.map((bj) => ai * bj)),
      spaceA.measure,
      spaceB.measure,
    );
    const fast = gwObjective(
      spaceA.distances,
      spaceB.distances,
      spaceA.measure,
      spaceB.measure,
      pi,
    );
    let slow = 0;
    for (let i = 0; i < 4; i += 1)
      for (let j = 0; j < 3; j += 1)
        for (let k = 0; k < 4; k += 1)
          for (let l = 0; l < 3; l += 1) {
            const d = (spaceA.distances[i]?.[k] ?? 0) - (spaceB.distances[j]?.[l] ?? 0);
            slow += d * d * (pi[i]?.[j] ?? 0) * (pi[k]?.[l] ?? 0);
          }
    expect(fast).toBeCloseTo(slow, 10);
  });
});

describe('GWEI entropic GW (WS-H.5.2b)', () => {
  it('identical spaces produce distance ≈ 0', () => {
    // ε controls the entropic bias: at ε = 0.002 the residual smoothing
    // sits well under the tolerance (the approximation note in the card).
    const space = randomSpace(11, 7);
    const result = entropicGw(space, space, {
      epsilon: 0.002,
      outerIterations: 30,
      sinkhornIterations: 500,
    });
    expect(result.distance).toBeLessThan(0.05);
  });

  it('highly dissimilar spaces produce a clearly positive distance', () => {
    const small = randomSpace(5, 6, 1);
    const large = randomSpace(6, 6, 10);
    const result = entropicGw(small, large, { epsilon: 0.05, outerIterations: 30 });
    expect(result.distance).toBeGreaterThan(1);
  });

  it('reports seed and regularization stability with a bracketing interval', () => {
    const a = randomSpace(21, 6);
    const b = randomSpace(22, 6, 2);
    const stability = gwDistanceWithStability(a, b, {
      seeds: [0, 1, 2],
      epsilons: [0.05, 0.02],
      outerIterations: 15,
    });
    expect(stability.runs.length).toBe(6);
    expect(stability.ciLow).toBeLessThanOrEqual(stability.gw2);
    expect(stability.gw2).toBeLessThanOrEqual(stability.ciHigh);
    expect(stability.seedCount).toBe(3);
    // Stability: the spread across seeds/regularization stays bounded.
    expect(stability.ciHigh - stability.ciLow).toBeLessThan(Math.max(0.5, stability.gw2));
  });

  it('a metrically-scaled copy is farther than an identical copy', () => {
    const base = randomSpace(31, 6);
    const scaled: MetricMeasureSpace = {
      itemIds: base.itemIds,
      distances: base.distances.map((row) => row.map((v) => v * 3)),
      measure: base.measure,
    };
    const same = entropicGw(base, base, { epsilon: 0.02, outerIterations: 20 }).distance;
    const far = entropicGw(base, scaled, { epsilon: 0.02, outerIterations: 20 }).distance;
    expect(far).toBeGreaterThan(same);
  });
});

describe('GWEI experience metrics (WS-H.5.1b)', () => {
  const item = (extra: Partial<CohortExposureItem>): CohortExposureItem => ({
    itemId: 'x',
    sourceKey: 's1',
    topicIds: ['t1'],
    hasPrimaryEvidence: false,
    discussionDepth: 1,
    lensKeys: ['l1'],
    familiarTopic: true,
    safetyElevated: false,
    weight: 1,
    ...extra,
  });

  it('computes all seven §9.4 metrics with expected values', () => {
    const metrics = experienceMetrics([
      item({ itemId: 'a', sourceKey: 's1', hasPrimaryEvidence: true, familiarTopic: false }),
      item({ itemId: 'b', sourceKey: 's2', topicIds: ['t2'], discussionDepth: 3 }),
    ]);
    // Two equally weighted sources ⇒ effective number 2.
    expect(metrics.sourceDiversity).toBeCloseTo(2, 6);
    expect(metrics.topicDiversity).toBeCloseTo(2, 6);
    expect(metrics.evidenceAccess).toBeCloseTo(0.5, 12);
    expect(metrics.discussionDepth).toBeCloseTo(2, 12);
    // 50/50 familiar/unfamiliar ⇒ novelty balance 1.
    expect(metrics.novelty).toBeCloseTo(1, 12);
    expect(metrics.safetyState).toBe(0);
  });

  it('diversity collapses to 1 when one source dominates', () => {
    const metrics = experienceMetrics([
      item({ itemId: 'a', weight: 100 }),
      item({ itemId: 'b', sourceKey: 's2', weight: 0.0001 }),
    ]);
    expect(metrics.sourceDiversity).toBeLessThan(1.01);
    // All-familiar ⇒ novelty balance 0.
    expect(metrics.novelty).toBeCloseTo(0, 6);
  });

  it('returns zeros for an empty cohort sample', () => {
    const metrics = experienceMetrics([]);
    expect(metrics.sourceDiversity).toBe(0);
    expect(metrics.evidenceAccess).toBe(0);
  });
});

describe('GWEI k-anonymity (WS-H.5.1b-2)', () => {
  const metrics = experienceMetrics([]);

  it('suppresses below-threshold cohorts distinguishably from zero', () => {
    const suppressed = suppressBelowK(10, 25, metrics);
    expect(suppressed.suppressed).toBe(true);
    if (suppressed.suppressed) {
      expect(suppressed.reasonCode).toBe('SUPPRESSED_K_ANONYMITY');
    }
    const shown = suppressBelowK(25, 25, metrics);
    expect(shown.suppressed).toBe(false);
  });

  it('rejects an invalid threshold', () => {
    expect(() => suppressBelowK(10, 0, metrics)).toThrow(/threshold/);
  });
});

describe('GWEI release gate (WS-H.5.2c)', () => {
  it('blocks when a protected cohort degrades beyond threshold', () => {
    const decision = evaluateReleaseGate([
      { cohortKey: 'minors', distance: 0.8, threshold: 0.4, protectedCohort: true },
      { cohortKey: 'all', distance: 0.9, threshold: 0.5, protectedCohort: false },
    ]);
    expect(decision.blocked).toBe(true);
    expect(decision.violations).toHaveLength(1);
    expect(decision.violations[0]?.cohortKey).toBe('minors');
  });

  it('documented sign-off overrides the block (logged)', () => {
    const decision = evaluateReleaseGate(
      [{ cohortKey: 'minors', distance: 0.8, threshold: 0.4, protectedCohort: true }],
      { owner: 'fairness-lead', justification: 'mitigation shipping in same release' },
    );
    expect(decision.blocked).toBe(false);
    expect(decision.overridden).toBe(true);
    expect(decision.overrideOwner).toBe('fairness-lead');
  });

  it('rejects a blank-owner or blank-justification override (stays blocked)', () => {
    const blankOwner = evaluateReleaseGate(
      [{ cohortKey: 'minors', distance: 0.8, threshold: 0.4, protectedCohort: true }],
      { owner: '', justification: '' },
    );
    expect(blankOwner.blocked).toBe(true);
    expect(blankOwner.overridden).toBe(false);
    expect(blankOwner.overrideOwner).toBeNull();

    const blankJustification = evaluateReleaseGate(
      [{ cohortKey: 'minors', distance: 0.8, threshold: 0.4, protectedCohort: true }],
      { owner: 'fairness-lead', justification: '   ' },
    );
    expect(blankJustification.blocked).toBe(true);
    expect(blankJustification.overridden).toBe(false);
    expect(blankJustification.overrideOwner).toBeNull();
  });

  it('passes cleanly when no cohort degrades', () => {
    const decision = evaluateReleaseGate([
      { cohortKey: 'minors', distance: 0.1, threshold: 0.4, protectedCohort: true },
    ]);
    expect(decision.blocked).toBe(false);
    expect(decision.overridden).toBe(false);
  });
});
