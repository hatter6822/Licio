// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SCOI tests (WS-H.4): coboundary correctness, Laplacian PSD, the
// normalized Dirichlet energy at its analytic anchor points (0, 0.5, 1),
// context states (weaponized requires a safety signal), ranking actions,
// and the v2 H¹ structural diagnostic.
import { describe, expect, it } from 'vitest';
import { jacobiEigSym } from '../math/linalg.js';
import {
  coboundary,
  contextStateForScore,
  DEFAULT_SCOI_STATE_THRESHOLDS,
  explainedCochain,
  h1Diagnostic,
  harmonicRepresentative,
  rankingActionForLevel,
  rankingLevelForState,
  type SheafStructure,
  scoiEnergy,
  sheafLaplacian,
  stewardRecommendationForState,
  validateScoiStateThresholds,
} from '../scoi/index.js';
import { float, forAll } from './prop.js';

const I2 = [
  [1, 0],
  [0, 1],
];

function twoLens(a: number[], b: number[]): SheafStructure {
  return {
    lenses: [
      { lensId: 'l1', interpretation: a },
      { lensId: 'l2', interpretation: b },
    ],
    overlaps: [{ lensA: 'l1', lensB: 'l2', rhoA: I2, rhoB: I2 }],
  };
}

describe('SCOI coboundary and Laplacian (WS-H.4.2a/b)', () => {
  it('d0 records the disagreement on each overlap', () => {
    const residuals = coboundary(twoLens([1, 0], [0, 1]));
    expect(residuals[0]?.residual).toEqual([1, -1]);
  });

  it('identity-like maps give zero disagreement for identical readings', () => {
    const residuals = coboundary(twoLens([0.5, 0.5], [0.5, 0.5]));
    expect(residuals[0]?.residual).toEqual([0, 0]);
  });

  it('L0 = d0ᵀ d0 is positive semi-definite (property)', () => {
    forAll(
      17,
      40,
      (rng) => {
        const structure: SheafStructure = {
          lenses: [
            { lensId: 'a', interpretation: [float(rng, -0.7, 0.7), float(rng, -0.7, 0.7)] },
            { lensId: 'b', interpretation: [float(rng, -0.7, 0.7), float(rng, -0.7, 0.7)] },
            { lensId: 'c', interpretation: [float(rng, -0.7, 0.7), float(rng, -0.7, 0.7)] },
          ],
          overlaps: [
            {
              lensA: 'a',
              lensB: 'b',
              rhoA: [
                [float(rng, -1, 1), float(rng, -1, 1)],
                [float(rng, -1, 1), float(rng, -1, 1)],
              ],
              rhoB: I2,
            },
            { lensA: 'b', lensB: 'c', rhoA: I2, rhoB: I2 },
          ],
        };
        return structure;
      },
      (structure) => {
        const { values } = jacobiEigSym(sheafLaplacian(structure));
        return (
          values.every((v) => v >= -1e-9) || `negative eigenvalue ${values[values.length - 1]}`
        );
      },
    );
  });

  it('rejects malformed structures (norms, shapes, unknown lenses)', () => {
    expect(() => scoiEnergy(twoLens([2, 0], [0, 1]))).toThrow(/unit ball/);
    expect(() =>
      scoiEnergy({
        lenses: [{ lensId: 'a', interpretation: [1, 0] }],
        overlaps: [{ lensA: 'a', lensB: 'ghost', rhoA: I2, rhoB: I2 }],
      }),
    ).toThrow(/unknown lens/);
    expect(() =>
      scoiEnergy({
        lenses: [
          { lensId: 'a', interpretation: [1, 0] },
          { lensId: 'b', interpretation: [1, 0, 0] },
        ],
        overlaps: [{ lensA: 'a', lensB: 'b', rhoA: I2, rhoB: I2 }],
      }),
    ).toThrow(/shape mismatch/);
  });
});

describe('SCOI normalized Dirichlet energy (WS-H.4.2c)', () => {
  it('coherent interpretations produce SCOI = 0', () => {
    expect(scoiEnergy(twoLens([1, 0], [1, 0])).scoi).toBe(0);
  });

  it('maximally disagreeing interpretations produce SCOI = 1', () => {
    const result = scoiEnergy(twoLens([1, 0], [-1, 0]));
    expect(result.scoi).toBeCloseTo(1, 9);
    expect(result.energy).toBeCloseTo(4, 9);
    expect(result.normalizer).toBeCloseTo(4, 9);
  });

  it('intermediate disagreement lands strictly inside (0, 1)', () => {
    const result = scoiEnergy(twoLens([1, 0], [0, 1]));
    expect(result.scoi).toBeCloseTo(0.5, 9);
  });

  it('SCOI stays in [0, 1] for random structures (property)', () => {
    forAll(
      23,
      60,
      (rng) =>
        twoLens(
          [float(rng, -0.7, 0.7), float(rng, -0.7, 0.7)],
          [float(rng, -0.7, 0.7), float(rng, -0.7, 0.7)],
        ),
      (structure) => {
        const { scoi } = scoiEnergy(structure);
        return (scoi >= 0 && scoi <= 1) || `out of range ${scoi}`;
      },
    );
  });

  it('reports per-overlap energy for steward drill-down', () => {
    const result = scoiEnergy({
      lenses: [
        { lensId: 'a', interpretation: [1, 0] },
        { lensId: 'b', interpretation: [1, 0] },
        { lensId: 'c', interpretation: [-1, 0] },
      ],
      overlaps: [
        { lensA: 'a', lensB: 'b', rhoA: I2, rhoB: I2 },
        { lensA: 'b', lensB: 'c', rhoA: I2, rhoB: I2 },
      ],
    });
    expect(result.perOverlap[0]?.energy).toBe(0);
    expect(result.perOverlap[1]?.energy).toBeCloseTo(4, 9);
    expect(result.overlapCount).toBe(2);
    expect(result.lensCount).toBe(3);
  });
});

describe('SCOI context states (WS-H.4.1b)', () => {
  it('assigns states deterministically from thresholds', () => {
    expect(contextStateForScore(0.05, false)).toBe('coherent');
    expect(contextStateForScore(0.2, false)).toBe('ambiguous');
    expect(contextStateForScore(0.5, false)).toBe('split');
    expect(contextStateForScore(0.8, false)).toBe('obstructed');
  });

  it('weaponized requires BOTH high disagreement AND the safety signal', () => {
    expect(contextStateForScore(0.8, true)).toBe('weaponized');
    expect(contextStateForScore(0.5, true)).toBe('weaponized');
    expect(contextStateForScore(0.2, true)).toBe('ambiguous'); // signal alone is not enough
    expect(contextStateForScore(0.9, false)).toBe('obstructed'); // disagreement alone is not enough
  });

  it('validates threshold ordering', () => {
    expect(validateScoiStateThresholds(DEFAULT_SCOI_STATE_THRESHOLDS)).toBeNull();
    expect(validateScoiStateThresholds({ ambiguous: 0.5, split: 0.4, obstructed: 0.7 })).toMatch(
      /ambiguous < split/,
    );
  });

  it('maps states to §10.6 ranking actions (description only)', () => {
    expect(rankingLevelForState('coherent')).toBe('low');
    expect(rankingActionForLevel('medium').requireContextCard).toBe(true);
    expect(rankingActionForLevel('high').reduceCrossCommunityAmplification).toBe(true);
    expect(rankingActionForLevel('very_high').prioritizeBridgeRouting).toBe(true);
    expect(rankingActionForLevel('low')).toEqual({
      requireContextCard: false,
      reduceCrossCommunityAmplification: false,
      prioritizeBridgeRouting: false,
    });
  });

  it('steward recommendations exist for every state', () => {
    for (const state of ['coherent', 'ambiguous', 'split', 'obstructed', 'weaponized'] as const) {
      expect(stewardRecommendationForState(state).length).toBeGreaterThan(10);
    }
  });
});

describe('SCOI v2 — H¹ structural obstruction (WS-H.4.2f)', () => {
  it('a tree-shaped overlap diagram with surjective maps has trivial H¹', () => {
    const structure = twoLens([1, 0], [0, 1]);
    const diagnostic = h1Diagnostic(structure);
    // d0 is 2×4 of rank 2 ⇒ dim H¹ = 0.
    expect(diagnostic.rankD0).toBe(2);
    expect(diagnostic.dimH1).toBe(0);
    expect(diagnostic.structuralObstruction).toBe(false);
  });

  it('rank-deficient restriction maps yield nontrivial H¹ and a harmonic norm', () => {
    // Comparison space R², but both maps only reach span(e₁): the e₂
    // component of ANY observed disagreement is unexplainable.
    const lowRank = [
      [1, 0],
      [0, 0],
    ];
    const structure: SheafStructure = {
      lenses: [
        { lensId: 'a', interpretation: [1, 0] },
        { lensId: 'b', interpretation: [0, 1] },
      ],
      overlaps: [{ lensA: 'a', lensB: 'b', rhoA: lowRank, rhoB: lowRank }],
    };
    const diagnostic = h1Diagnostic(structure);
    expect(diagnostic.dimC1).toBe(2);
    expect(diagnostic.rankD0).toBe(1);
    expect(diagnostic.dimH1).toBe(1);
    expect(diagnostic.structuralObstruction).toBe(true);

    const observed = [0.3, 0.8]; // e₂ part (0.8) cannot come from any readings
    const harmonic = harmonicRepresentative(structure, observed);
    expect(harmonic.harmonicNorm).toBeCloseTo(0.8, 9);
    expect(harmonic.unexplainableFraction).toBeCloseTo(0.64 / (0.09 + 0.64), 9);
  });

  it('an exact cochain has zero harmonic part', () => {
    const structure = twoLens([1, 0], [0, 1]);
    const g = explainedCochain(structure, [1, 0, 0, 1]); // d0 of the readings
    const harmonic = harmonicRepresentative(structure, g);
    expect(harmonic.harmonicNorm).toBeLessThan(1e-9);
    expect(harmonic.unexplainableFraction).toBeLessThan(1e-9);
  });

  it('rejects a cochain of the wrong dimension', () => {
    expect(() => harmonicRepresentative(twoLens([1, 0], [0, 1]), [1])).toThrow(/dimension/);
  });
});

describe('SCOI-5 human-label validation (WS-H.4.2c)', () => {
  it('scores rank-correlate with the curated human labels and separate the extremes', async () => {
    const { LABELED_CONTEXT_CASES, validateScoiAgainstLabels } = await import(
      '../scoi/validation.js'
    );
    const report = validateScoiAgainstLabels();
    expect(report.cases).toHaveLength(LABELED_CONTEXT_CASES.length);
    expect(report.spearman).toBeGreaterThanOrEqual(0.8);
    expect(report.separation).toBe(true);
    expect(report.pass).toBe(true);
    // The labels span the full ordinal range (the set stays meaningful).
    const labels = new Set(LABELED_CONTEXT_CASES.map((c) => c.label));
    expect(labels).toEqual(new Set([0, 1, 2]));
    // Every case records its human rationale (the audit trail).
    for (const entry of LABELED_CONTEXT_CASES) {
      expect(entry.rationale.length).toBeGreaterThan(20);
    }
  });

  it('spearman guards its domain and detects perfect anti-correlation', async () => {
    const { spearmanCorrelation } = await import('../scoi/validation.js');
    expect(spearmanCorrelation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 10);
    expect(spearmanCorrelation([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 10);
    expect(() => spearmanCorrelation([1], [1])).toThrow(/n >= 2/);
  });
});
