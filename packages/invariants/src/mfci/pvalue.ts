// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MFCI — coordination statistics and the conditional p-value
// (WS-H.3.3c, SPEC §8.2).
//
//   p̂   = (1 + #{ sampled X′ : T(X′) ≥ T(X) }) / (N + 1)
//   MFCI = −log p̂
//
// The add-one estimator keeps p̂ ∈ (0, 1] always (the observed table counts
// as its own exceedance), so MFCI is finite and nonnegative even when no
// sampled table is as extreme as X. Larger MFCI ⇒ the observed coordination
// statistic is more extreme relative to the conditional null.
//
// Statistics T. With all 1-way margins fixed, any function of a single
// axis's marginal is CONSTANT on the fiber — so useful statistics measure
// JOINT structure. The three §8.2 statistics are quadratic concentration
// functionals of 2-way flattenings (Σ counts², the unnormalized Herfindahl
// mass), which the 1-way margins do not determine:
//
//   • target_concentration: Σ over (user_group, target) pairs of count² —
//     "many accounts from one group acting on one target".
//   • synchrony: Σ over (time_bucket, target) pairs of count² — "actions on
//     a target squeezed into few time buckets".
//   • phrase_repetition: Σ over (action_type, target) pairs of count² —
//     with action_type carrying phrase-class labels, "the same phrasing
//     repeated at one target".

import { type SamplerOptions, sampleFiber } from './markov.js';
import { flatten2Way, MFCI_AXES, type SparseTable } from './table.js';

export const MFCI_STATISTICS = ['synchrony', 'target_concentration', 'phrase_repetition'] as const;
export type MfciStatistic = (typeof MFCI_STATISTICS)[number];

function axisIndex(table: SparseTable, name: string): number {
  const idx = table.axes.findIndex((a) => a.name === name);
  if (idx < 0) throw new Error(`table is missing required axis '${name}'`);
  return idx;
}

function sumOfSquares(flat: Map<string, number>): number {
  let sum = 0;
  for (const count of flat.values()) sum += count * count;
  return sum;
}

/** T for a named statistic (see module header for definitions). */
export function coordinationStatistic(table: SparseTable, statistic: MfciStatistic): number {
  const target = axisIndex(table, 'target');
  switch (statistic) {
    case 'target_concentration':
      return sumOfSquares(flatten2Way(table, axisIndex(table, 'user_group'), target));
    case 'synchrony':
      return sumOfSquares(flatten2Way(table, axisIndex(table, 'time_bucket'), target));
    case 'phrase_repetition':
      return sumOfSquares(flatten2Way(table, axisIndex(table, 'action_type'), target));
    default: {
      const exhaustive: never = statistic;
      throw new Error(`unknown statistic ${String(exhaustive)}`);
    }
  }
}

/** The §8.2 add-one estimator. Exceedances are counted with T(X′) ≥ T(X). */
export function addOnePValue(exceedances: number, sampleCount: number): number {
  if (!Number.isInteger(exceedances) || exceedances < 0 || exceedances > sampleCount) {
    throw new Error(`invalid exceedance count ${exceedances} of ${sampleCount}`);
  }
  return (1 + exceedances) / (sampleCount + 1);
}

/** MFCI = −log p̂ ∈ [0, log(N+1)] — always finite and nonnegative. */
export function mfciFromPValue(pHat: number): number {
  if (!(pHat > 0 && pHat <= 1)) throw new Error(`p-value out of range: ${pHat}`);
  // Math.max also normalizes −log(1) = −0 to +0.
  return Math.max(0, -Math.log(pHat));
}

export interface FiberTestResult {
  statistic: MfciStatistic;
  observedT: number;
  pHat: number;
  mfci: number;
  sampleCount: number;
  exceedances: number;
  acceptanceRate: number;
  effectiveSampleSize: number;
  converged: boolean;
}

/**
 * The full conditional fiber test: sample N tables from the conditional
 * null, count exceedances of the observed statistic, and report
 * MFCI = −log p̂ with sampler diagnostics. Deterministic per seed.
 */
export function fiberTest(
  observed: SparseTable,
  statistic: MfciStatistic,
  sampler: SamplerOptions,
): FiberTestResult {
  for (const required of MFCI_AXES) {
    axisIndex(observed, required);
  }
  const observedT = coordinationStatistic(observed, statistic);
  const run = sampleFiber(observed, (table) => coordinationStatistic(table, statistic), sampler);
  // Floating-point guard: counts are integers so T is an exact integer sum;
  // `>=` comparison is exact.
  const exceedances = run.statistics.filter((t) => t >= observedT).length;
  const pHat = addOnePValue(exceedances, run.statistics.length);
  return {
    statistic,
    observedT,
    pHat,
    mfci: mfciFromPValue(pHat),
    sampleCount: run.statistics.length,
    exceedances,
    acceptanceRate: run.diagnostics.acceptanceRate,
    effectiveSampleSize: run.diagnostics.effectiveSampleSize,
    converged: run.diagnostics.converged,
  };
}
