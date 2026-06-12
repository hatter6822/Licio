// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Edge-branch suite: the guard rails the main suites do not trip — input
// validation throws, degenerate structures, the remaining MFCI statistics
// (synchrony, phrase repetition) through the full fiber test, rounding of
// already-feasible couplings, and threshold-validation variants.
import { describe, expect, it } from 'vitest';
import {
  addOnePValue,
  buildMetricMeasureSpace,
  buildSparseTable,
  contextStateForScore,
  entropicGw,
  fiberTest,
  gwDistanceWithStability,
  h1Diagnostic,
  harmonicRepresentative,
  helmholtzDecompose,
  logDomainSinkhorn,
  logFactorial,
  MFCI_AXES,
  randomPick,
  rankingLevelForState,
  roundToCoupling,
  type SheafStructure,
  sampleFiber,
  scoiEnergy,
  validateMfciRiskThresholds,
  validatePseudometric,
  validateScoiStateThresholds,
  verifyGaugeInvariance,
} from '../index.js';
import { mulberry32 } from '../math/rng.js';

const AXES_5D = MFCI_AXES.map((name) => ({
  name,
  labels: name === 'target' ? ['x', 'y'] : ['p', 'q'],
}));

function concentratedTable() {
  const observations = [
    ...Array.from({ length: 10 }, () => ({ labels: ['p', 'p', 'p', 'p', 'x'] })),
    { labels: ['q', 'q', 'q', 'q', 'y'] },
    { labels: ['p', 'q', 'p', 'q', 'y'] },
    { labels: ['q', 'p', 'q', 'p', 'x'] },
  ];
  return buildSparseTable(AXES_5D, observations);
}

describe('MFCI remaining statistics through the fiber test', () => {
  it('synchrony and phrase repetition produce finite ordered scores', () => {
    const table = concentratedTable();
    for (const statistic of ['synchrony', 'phrase_repetition'] as const) {
      const result = fiberTest(table, statistic, {
        samples: 300,
        burnIn: 300,
        thinning: 2,
        seed: 11,
      });
      expect(Number.isFinite(result.mfci)).toBe(true);
      expect(result.pHat).toBeGreaterThan(0);
      expect(result.statistic).toBe(statistic);
    }
  });

  it('rejects tables missing a required production axis', () => {
    const incomplete = buildSparseTable(
      [
        { name: 'user_group', labels: ['g'] },
        { name: 'target', labels: ['x'] },
      ],
      [{ labels: ['g', 'x'] }],
    );
    expect(() => fiberTest(incomplete, 'synchrony', { samples: 10, seed: 1 })).toThrow(
      /missing required axis/,
    );
  });

  it('guards its numeric domains', () => {
    expect(() => logFactorial(-1)).toThrow(/domain/);
    expect(() => addOnePValue(1.5 as never, 10)).toThrow();
    expect(() =>
      sampleFiber(
        buildSparseTable([{ name: 'only', labels: ['a'] }], [{ labels: ['a'] }]),
        () => 0,
        { samples: 1, seed: 1 },
      ),
    ).toThrow(/at least two axes/);
    expect(() => randomPick(mulberry32(1), [])).toThrow(/empty/);
  });

  it('sampler honors an explicit ESS floor option', () => {
    const run = sampleFiber(concentratedTable(), (table) => table.cells.size, {
      samples: 50,
      burnIn: 50,
      thinning: 1,
      seed: 3,
      minEffectiveSampleSize: 1,
    });
    expect(run.diagnostics.converged).toBe(true);
  });
});

describe('GWEI guard rails', () => {
  const space = buildMetricMeasureSpace([
    {
      itemId: 'a',
      semantic: [0, 0],
      sourceKey: 's1',
      evidenceKeys: [],
      communityKeys: [],
      weight: 1,
    },
    {
      itemId: 'b',
      semantic: [1, 0],
      sourceKey: 's2',
      evidenceKeys: ['e'],
      communityKeys: ['c'],
      weight: 1,
    },
  ]);

  it('rejects invalid epsilon, malformed metrics, and empty stability grids', () => {
    expect(() => logDomainSinkhorn([[0]], [1], [1], { epsilon: 0 })).toThrow(/positive/);
    expect(() =>
      entropicGw(
        { itemIds: ['x'], distances: [[1]], measure: [1] }, // nonzero diagonal
        space,
        { epsilon: 0.1 },
      ),
    ).toThrow(/diagonal/);
    expect(() => gwDistanceWithStability(space, space, { seeds: [], epsilons: [0.1] })).toThrow(
      /at least one seed/,
    );
    expect(validatePseudometric([[0, 1]])).toMatch(/square/);
    expect(
      validatePseudometric([
        [0, Number.NaN],
        [Number.NaN, 0],
      ]),
    ).toMatch(/finite/);
  });

  it('rounding an already-feasible coupling is a no-op (zero error mass)', () => {
    const exact = [
      [0.25, 0.25],
      [0.25, 0.25],
    ];
    const rounded = roundToCoupling(exact, [0.5, 0.5], [0.5, 0.5]);
    expect(rounded).toEqual(exact);
  });

  it('non-finite item weights are dropped during space construction', () => {
    const built = buildMetricMeasureSpace([
      {
        itemId: 'keep',
        semantic: [0],
        sourceKey: 's',
        evidenceKeys: [],
        communityKeys: [],
        weight: 2,
      },
      {
        itemId: 'drop',
        semantic: [1],
        sourceKey: 's',
        evidenceKeys: [],
        communityKeys: [],
        weight: Number.NaN,
      },
    ]);
    expect(built.itemIds).toEqual(['keep']);
  });
});

describe('SCOI guard rails and degenerate structures', () => {
  const I2 = [
    [1, 0],
    [0, 1],
  ];

  it('rejects duplicate lenses and non-finite interpretations', () => {
    expect(() =>
      scoiEnergy({
        lenses: [
          { lensId: 'dup', interpretation: [1, 0] },
          { lensId: 'dup', interpretation: [0, 1] },
        ],
        overlaps: [],
      }),
    ).toThrow(/duplicate lens/);
    expect(() =>
      scoiEnergy({
        lenses: [{ lensId: 'bad', interpretation: [Number.POSITIVE_INFINITY, 0] }],
        overlaps: [],
      }),
    ).toThrow(/non-finite|unit ball/);
  });

  it('an overlap-free structure scores zero with a zero normalizer', () => {
    const result = scoiEnergy({
      lenses: [{ lensId: 'solo', interpretation: [1, 0] }],
      overlaps: [],
    });
    expect(result.scoi).toBe(0);
    expect(result.normalizer).toBe(0);
  });

  it('mismatched comparison dimensions are rejected', () => {
    const structure: SheafStructure = {
      lenses: [
        { lensId: 'a', interpretation: [1, 0] },
        { lensId: 'b', interpretation: [0, 1] },
      ],
      overlaps: [{ lensA: 'a', lensB: 'b', rhoA: I2, rhoB: [[1, 0]] }],
    };
    expect(() => scoiEnergy(structure)).toThrow(/comparison dims differ/);
  });

  it('H¹ of the empty diagram is trivial; zero cochains explain themselves', () => {
    const empty: SheafStructure = { lenses: [], overlaps: [] };
    expect(h1Diagnostic(empty)).toEqual({
      dimH1: 0,
      rankD0: 0,
      dimC1: 0,
      structuralObstruction: false,
    });
    expect(harmonicRepresentative(empty, []).harmonicNorm).toBe(0);
    const twoLens: SheafStructure = {
      lenses: [
        { lensId: 'a', interpretation: [1, 0] },
        { lensId: 'b', interpretation: [0, 1] },
      ],
      overlaps: [{ lensA: 'a', lensB: 'b', rhoA: I2, rhoB: I2 }],
    };
    expect(harmonicRepresentative(twoLens, [0, 0]).unexplainableFraction).toBe(0);
  });

  it('threshold validation rejects out-of-range and misordered variants', () => {
    expect(validateScoiStateThresholds({ ambiguous: 0, split: 0.4, obstructed: 0.7 })).toMatch(
      /inside/,
    );
    expect(validateScoiStateThresholds({ ambiguous: 0.2, split: 0.8, obstructed: 0.5 })).toMatch(
      /satisfy/,
    );
    expect(validateMfciRiskThresholds({ elevated: -1, high: 2, severe: 3 })).toMatch(/positive/);
    expect(rankingLevelForState(contextStateForScore(0.95, true))).toBe('very_high');
  });
});

describe('Hodge and gauge guard rails', () => {
  it('a triangle referencing a missing edge is rejected', () => {
    expect(() =>
      helmholtzDecompose({
        vertices: ['a', 'b', 'c'],
        edges: [{ from: 'a', to: 'b', flow: 1 }],
        triangles: [['a', 'b', 'c']],
      }),
    ).toThrow(/missing edge/);
  });

  it('gauge verification accepts explicit score options', () => {
    const h = [
      [Math.cos(0.4), -Math.sin(0.4)],
      [Math.sin(0.4), Math.cos(0.4)],
    ];
    const verification = verifyGaugeInvariance(h, {
      seed: 5,
      trials: 4,
      tolerance: 1e-6,
      score: { pairTolerance: 1e-6 },
    });
    expect(verification.invariant).toBe(true);
  });
});

describe('headroom: option-path branches', () => {
  it('cheap statistics honor custom minActions and degenerate calibrations', async () => {
    const { synchronyScore, targetConcentrationScore } = await import('../mfci/cheap.js');
    const nowMs = 1_000_000;
    const flat = {
      statistic: 'target_concentration' as const,
      version: 'v1',
      computedAtMs: nowMs,
      buckets: [{ minVolume: 0, q50: 0.5, q90: 0.5, q99: 0.5, sampleCount: 10 }],
    };
    const actions = Array.from({ length: 4 }, (_, i) => ({
      actorRef: `u${i}`,
      targetId: 'one',
      atMs: nowMs - i,
    }));
    // Custom minActions lowers the floor; the degenerate (zero-spread)
    // calibration maps anything above the median to the maximal score.
    const result = targetConcentrationScore(actions, flat, { nowMs, minActions: 2 });
    expect(result.score).toBe(1);
    const below = targetConcentrationScore(
      actions.map((a, i) => ({ ...a, targetId: `t${i}` })),
      flat,
      { nowMs, minActions: 2 },
    );
    expect(below.score).toBe(0);
    const sync = synchronyScore(
      actions,
      { ...flat, statistic: 'synchrony' },
      {
        nowMs,
        minActions: 2,
        synchronyDeltaMs: 10,
      },
    );
    expect(sync.rawValue).toBeGreaterThan(0);
  });

  it('computeMeri accepts explicit bounds, gains, and group-size options', async () => {
    const { computeMeri } = await import('../meri/index.js');
    const inputs = {
      canonicalUrl: true,
      claimExtraction: true,
      sourceLineage: true,
      evidence: true,
      embedding: true,
    };
    const result = computeMeri(
      [
        { id: 'a', urlGroupId: 'u1', sourceLineageGroupId: 's', inputsAvailable: inputs },
        { id: 'b', urlGroupId: 'u2', sourceLineageGroupId: 's', inputsAvailable: inputs },
        { id: 'c', urlGroupId: 'u3', sourceLineageGroupId: 's', inputsAvailable: inputs },
      ],
      {
        bounds: { nearDuplicate: 1, sourceLineage: 1, evidenceLineage: 1 },
        gains: { epsilon: 0.05, mediumGain: 0.4, highGain: 0.9 },
        minAcceptableCoverage: 0.1,
        minGroupSize: 3,
      },
    );
    // Tightened lineage bound 1 ⇒ only one of the three counts.
    expect(result.meri).toBeCloseTo(1 / 3, 12);
  });

  it('sameMargins distinguishes differing axis structures', async () => {
    const { buildSparseTable, sameMargins } = await import('../mfci/table.js');
    const a = buildSparseTable([{ name: 'x', labels: ['1'] }], [{ labels: ['1'] }]);
    const b = buildSparseTable(
      [
        { name: 'x', labels: ['1'] },
        { name: 'y', labels: ['1'] },
      ],
      [{ labels: ['1', '1'] }],
    );
    expect(sameMargins(a, b)).toBe(false);
  });
});
