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
import { computeMargins, flatten2Way, keyToIndices, MFCI_AXES, type SparseTable } from './table.js';

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

/** The non-target axis each statistic pairs with `target`. */
function pairAxisFor(table: SparseTable, statistic: MfciStatistic): number {
  switch (statistic) {
    case 'target_concentration':
      return axisIndex(table, 'user_group');
    case 'synchrony':
      return axisIndex(table, 'time_bucket');
    case 'phrase_repetition':
      return axisIndex(table, 'action_type');
    default: {
      const exhaustive: never = statistic;
      throw new Error(`unknown statistic ${String(exhaustive)}`);
    }
  }
}

/** T for a named statistic (see module header for definitions). */
export function coordinationStatistic(table: SparseTable, statistic: MfciStatistic): number {
  return sumOfSquares(
    flatten2Way(table, pairAxisFor(table, statistic), axisIndex(table, 'target')),
  );
}

/**
 * The TARGET-RESTRICTED statistic T_t: the quadratic mass of the 2-way
 * flattening's slice at one target label — Σ_pair count(pair, t)². The
 * target's own 1-way margin fixes Σ_pair count(pair, t) but NOT its split
 * across pair labels, so T_t still varies on the fiber, and
 * Σ_t T_t = the global statistic (tested). This is what makes per-target
 * attribution honest: each target's p-value measures concentration of the
 * activity ON THAT TARGET, conditional on the system-wide margins.
 */
export function targetCoordinationStatistic(
  table: SparseTable,
  statistic: MfciStatistic,
  targetLabelIndex: number,
): number {
  const targetAxis = axisIndex(table, 'target');
  const pairAxis = pairAxisFor(table, statistic);
  const counts = new Map<number, number>();
  for (const [key, count] of table.cells) {
    const indices = keyToIndices(key);
    if (indices[targetAxis] !== targetLabelIndex) continue;
    const pairLabel = indices[pairAxis] ?? -1;
    counts.set(pairLabel, (counts.get(pairLabel) ?? 0) + count);
  }
  let sum = 0;
  for (const count of counts.values()) sum += count * count;
  return sum;
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

export interface TargetFiberResult {
  targetLabel: string;
  observedT: number;
  exceedances: number;
  pHat: number;
  mfci: number;
  /** The target's fixed 1-way margin (its in-window action count). */
  actionCount: number;
}

export interface MultiTargetFiberResult {
  statistic: MfciStatistic;
  perTarget: TargetFiberResult[];
  sampleCount: number;
  acceptanceRate: number;
  effectiveSampleSize: number;
  converged: boolean;
}

/**
 * PER-TARGET conditional fiber test over ONE shared fiber sample. The
 * conditional null (all 1-way margins fixed) is GLOBAL — group sizes,
 * topic popularity, temporal pattern, action mix, per-target baseline
 * volumes — while each target's statistic is the target-restricted
 * quadratic mass T_t, so each target's p̂ asks exactly: "is the activity
 * ON THIS TARGET more concentrated than its fixed volume predicts?" A
 * single MH run serves every target (`sampleFiber` evaluates its statistic
 * exactly once per retained sample; per-target exceedances accumulate in
 * that evaluation while the GLOBAL statistic drives the shared mixing
 * diagnostics — side effects cannot bias the chain, whose acceptance never
 * consults the statistic).
 *
 * Targets absent from the table get T = 0 with every sampled T′ = 0 ≥ 0:
 * p̂ = 1, MFCI = 0 — no actions, no coordination, honestly.
 */
export function fiberTestMulti(
  observed: SparseTable,
  statistic: MfciStatistic,
  targetLabels: readonly string[],
  sampler: SamplerOptions,
): MultiTargetFiberResult {
  for (const required of MFCI_AXES) {
    axisIndex(observed, required);
  }
  const targetAxis = axisIndex(observed, 'target');
  const labels = observed.axes[targetAxis]?.labels ?? [];
  const labelIndex = new Map(labels.map((label, i) => [label, i]));
  const margins = computeMargins(observed);
  const entries = targetLabels.map((label) => {
    const idx = labelIndex.get(label) ?? -1;
    return {
      targetLabel: label,
      idx,
      observedT: idx < 0 ? 0 : targetCoordinationStatistic(observed, statistic, idx),
      exceedances: 0,
      actionCount: idx < 0 ? 0 : (margins[targetAxis]?.[idx] ?? 0),
    };
  });
  const run = sampleFiber(
    observed,
    (table) => {
      for (const entry of entries) {
        const t = entry.idx < 0 ? 0 : targetCoordinationStatistic(table, statistic, entry.idx);
        if (t >= entry.observedT) entry.exceedances += 1;
      }
      return coordinationStatistic(table, statistic);
    },
    sampler,
  );
  return {
    statistic,
    perTarget: entries.map((entry) => {
      const pHat = addOnePValue(entry.exceedances, run.statistics.length);
      return {
        targetLabel: entry.targetLabel,
        observedT: entry.observedT,
        exceedances: entry.exceedances,
        pHat,
        mfci: mfciFromPValue(pHat),
        actionCount: entry.actionCount,
      };
    }),
    sampleCount: run.statistics.length,
    acceptanceRate: run.diagnostics.acceptanceRate,
    effectiveSampleSize: run.diagnostics.effectiveSampleSize,
    converged: run.diagnostics.converged,
  };
}
