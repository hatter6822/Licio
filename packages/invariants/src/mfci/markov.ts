// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MFCI — Markov basis and Metropolis–Hastings fiber sampler
// (WS-H.3.3a/WS-H.3.3b, SPEC §8.2, Diaconis–Sturmfels).
//
// Null model and reference distribution. The fixed statistics are all
// 1-way margins of the k-way table — the sufficient statistics of the
// COMPLETE-INDEPENDENCE log-linear model. Under that null (Poisson or
// multinomial sampling), P(X | margins) ∝ ∏_cells p_c^{x_c} / x_c!, and for
// complete independence p_c factorizes per axis, so ∏ p_c^{x_c} depends on
// the margins ONLY — it is constant on the fiber. The conditional reference
// distribution is therefore exactly the generalized hypergeometric
//
//     π(X) ∝ ∏_cells 1 / x_c!
//
// Markov basis. The degree-2 "coordinate-subset swap" moves
//
//     m(u, v, A) = e_{w1} + e_{w2} − e_u − e_v,
//     w1 = (v_A, u_Ac),  w2 = (u_A, v_Ac),   ∅ ⊊ A ⊊ axes
//
// preserve every 1-way margin (each axis sees the same multiset of labels
// before and after). Complete independence is a DECOMPOSABLE hierarchical
// model (its independence graph has no edges, hence is chordal), and for
// decomposable models these primitive degree-2 moves form a Markov basis
// (Dobra 2003; Diaconis–Sturmfels for the 2-way case): every two tables
// with the same margins are connected through nonnegative tables. The
// connectivity is verified by brute-force fiber enumeration in tests.
//
// Sampler. Proposals draw (u, v, A) uniformly from the FIXED product space
// (cells × cells × subsets), independent of the current state, so the
// proposal is symmetric and Metropolis–Hastings acceptance is
//
//     α = min(1, π(X′)/π(X)),
//     π(X′)/π(X) = x_u · x_v / ((x_{w1}+1) · (x_{w2}+1))
//
// (zero — i.e. certain rejection — when x_u or x_v is 0, which also keeps
// every entry nonnegative). Degenerate draws (u_A = v_A or u_Ac = v_Ac)
// leave X unchanged — lazy self-loops that do not affect the stationary
// distribution. The chain is irreducible on the fiber (Markov basis),
// aperiodic (self-loops), and reversible w.r.t. π — hence π-stationary.

import { mulberry32, type Rng, randomInt } from '../math/rng.js';
import { cellKey, cloneTable, type SparseTable } from './table.js';

export interface MarkovMove {
  /** Cell index tuples; the move is +w1 +w2 −u −v. */
  u: number[];
  v: number[];
  w1: number[];
  w2: number[];
}

/** Compose the move m(u, v, A); null when degenerate (X′ = X). */
export function subsetSwapMove(
  u: readonly number[],
  v: readonly number[],
  axisSubsetMask: number,
): MarkovMove | null {
  const k = u.length;
  const w1: number[] = new Array(k);
  const w2: number[] = new Array(k);
  let differsInA = false;
  let differsOutsideA = false;
  for (let axis = 0; axis < k; axis += 1) {
    const inA = (axisSubsetMask & (1 << axis)) !== 0;
    const uVal = u[axis] ?? 0;
    const vVal = v[axis] ?? 0;
    if (inA) {
      w1[axis] = vVal;
      w2[axis] = uVal;
      if (uVal !== vVal) differsInA = true;
    } else {
      w1[axis] = uVal;
      w2[axis] = vVal;
      if (uVal !== vVal) differsOutsideA = true;
    }
  }
  // w1 = u (or w2 = v) ⇔ u_A = v_A; w1 = v ⇔ u_Ac = v_Ac. Both degenerate.
  if (!differsInA || !differsOutsideA) return null;
  return { u: [...u], v: [...v], w1, w2 };
}

/**
 * Enumerate every (unordered) basis move on the table's index space —
 * exponential in table size; intended for tests and tiny analyst tables.
 */
export function enumerateBasisMoves(dims: readonly number[]): MarkovMove[] {
  const k = dims.length;
  const cells: number[][] = [];
  const build = (prefix: number[], axis: number): void => {
    if (axis === k) {
      cells.push([...prefix]);
      return;
    }
    for (let i = 0; i < (dims[axis] ?? 0); i += 1) {
      prefix.push(i);
      build(prefix, axis + 1);
      prefix.pop();
    }
  };
  build([], 0);
  const moves: MarkovMove[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      for (let mask = 1; mask < (1 << k) - 1; mask += 1) {
        const u = cells[i];
        const v = cells[j];
        if (!u || !v) continue;
        const move = subsetSwapMove(u, v, mask);
        if (!move) continue;
        // Deduplicate by the unordered {+cells, −cells} signature.
        const plus = [cellKey(move.w1), cellKey(move.w2)].sort().join('|');
        const minus = [cellKey(move.u), cellKey(move.v)].sort().join('|');
        const sig = `${minus}>>${plus}`;
        const sigRev = `${plus}>>${minus}`;
        if (seen.has(sig) || seen.has(sigRev)) continue;
        seen.add(sig);
        moves.push(move);
      }
    }
  }
  return moves;
}

/** Apply ±move when it keeps every entry nonnegative; null otherwise. */
export function applyMove(
  table: SparseTable,
  move: MarkovMove,
  direction: 1 | -1,
): SparseTable | null {
  const deltas = new Map<string, number>();
  const bump = (indices: readonly number[], d: number): void => {
    const key = cellKey(indices);
    deltas.set(key, (deltas.get(key) ?? 0) + d);
  };
  bump(move.w1, direction);
  bump(move.w2, direction);
  bump(move.u, -direction);
  bump(move.v, -direction);
  for (const [key, delta] of deltas) {
    if ((table.cells.get(key) ?? 0) + delta < 0) return null;
  }
  const next = cloneTable(table);
  for (const [key, delta] of deltas) {
    const value = (next.cells.get(key) ?? 0) + delta;
    if (value === 0) next.cells.delete(key);
    else next.cells.set(key, value);
  }
  return next;
}

export interface SamplerOptions {
  /** Retained samples after burn-in and thinning. */
  samples: number;
  burnIn?: number;
  /** Keep every `thinning`-th state (≥ 1). */
  thinning?: number;
  seed: number;
  /** Effective sample size below this flags SAMPLER_NONCONVERGENCE. */
  minEffectiveSampleSize?: number;
}

export interface SamplerDiagnostics {
  acceptanceRate: number;
  /** ESS of the statistic series (initial-positive-sequence estimator). */
  effectiveSampleSize: number;
  converged: boolean;
  proposed: number;
  accepted: number;
}

export interface FiberSampleResult {
  /** The retained statistic values T(X′), one per retained sample. */
  statistics: number[];
  diagnostics: SamplerDiagnostics;
}

const logFactorialCache: number[] = [0, 0];

/** log(n!) with a growing exact-sum cache (counts are small integers). */
export function logFactorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new Error(`logFactorial domain error: ${n}`);
  for (let i = logFactorialCache.length; i <= n; i += 1) {
    logFactorialCache.push((logFactorialCache[i - 1] ?? 0) + Math.log(i));
  }
  return logFactorialCache[n] ?? 0;
}

/**
 * Run the Metropolis–Hastings sampler over the fiber of `observed`,
 * evaluating `statistic` on each retained sample. Deterministic per seed.
 */
export function sampleFiber(
  observed: SparseTable,
  statistic: (table: SparseTable) => number,
  options: SamplerOptions,
): FiberSampleResult {
  const burnIn = options.burnIn ?? Math.max(500, options.samples);
  const thinning = Math.max(1, options.thinning ?? 2);
  const rng: Rng = mulberry32(options.seed);
  const dims = observed.axes.map((a) => a.labels.length);
  const k = dims.length;
  if (k < 2) throw new Error('fiber sampling requires at least two axes');

  let state = cloneTable(observed);
  let accepted = 0;
  let proposed = 0;
  const statistics: number[] = [];

  const drawCell = (): number[] => dims.map((d) => randomInt(rng, 0, d - 1));

  const totalSteps = burnIn + options.samples * thinning;
  for (let step = 0; step < totalSteps; step += 1) {
    const u = drawCell();
    const v = drawCell();
    const mask = randomInt(rng, 1, (1 << k) - 2);
    const move = subsetSwapMove(u, v, mask);
    proposed += 1;
    if (move) {
      const xu = state.cells.get(cellKey(move.u)) ?? 0;
      const xv = state.cells.get(cellKey(move.v)) ?? 0;
      if (xu >= 1 && xv >= 1) {
        const xw1 = state.cells.get(cellKey(move.w1)) ?? 0;
        const xw2 = state.cells.get(cellKey(move.w2)) ?? 0;
        const logRatio = Math.log(xu) + Math.log(xv) - Math.log(xw1 + 1) - Math.log(xw2 + 1);
        if (logRatio >= 0 || Math.log(rng()) < logRatio) {
          const next = applyMove(state, move, 1);
          if (next) {
            state = next;
            accepted += 1;
          }
        }
      }
    }
    if (step >= burnIn && (step - burnIn) % thinning === thinning - 1) {
      statistics.push(statistic(state));
    }
  }

  const ess = effectiveSampleSize(statistics);
  const minEss = options.minEffectiveSampleSize ?? Math.min(100, options.samples / 10);
  return {
    statistics,
    diagnostics: {
      acceptanceRate: proposed === 0 ? 0 : accepted / proposed,
      effectiveSampleSize: ess,
      converged: ess >= minEss,
      proposed,
      accepted,
    },
  };
}

/**
 * Effective sample size via the initial-positive-sequence rule: sum lag
 * autocorrelations until the first non-positive one. A constant series has
 * no Monte-Carlo error for exceedance counting, so it reports full size.
 */
export function effectiveSampleSize(series: readonly number[]): number {
  const n = series.length;
  if (n < 4) return n;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let variance = 0;
  for (const v of series) variance += (v - mean) ** 2;
  variance /= n;
  if (variance <= 1e-12) return n;
  let sumRho = 0;
  for (let lag = 1; lag < n - 1; lag += 1) {
    let cov = 0;
    for (let i = 0; i + lag < n; i += 1) {
      cov += ((series[i] ?? 0) - mean) * ((series[i + lag] ?? 0) - mean);
    }
    cov /= n;
    const rho = cov / variance;
    if (rho <= 0) break;
    sumRho += rho;
  }
  return Math.max(1, n / (1 + 2 * sumRho));
}

/**
 * Brute-force fiber enumeration for SMALL tables (tests; connectivity
 * verification). Enumerates every nonnegative integer table with the same
 * 1-way margins by depth-first cell assignment with margin pruning.
 */
export function enumerateFiber(
  axes: SparseTable['axes'],
  margins: readonly (readonly number[])[],
  maxTables = 100_000,
): SparseTable[] {
  const dims = axes.map((a) => a.labels.length);
  const k = dims.length;
  const cells: number[][] = [];
  const build = (prefix: number[], axis: number): void => {
    if (axis === k) {
      cells.push([...prefix]);
      return;
    }
    for (let i = 0; i < (dims[axis] ?? 0); i += 1) {
      prefix.push(i);
      build(prefix, axis + 1);
      prefix.pop();
    }
  };
  build([], 0);

  const remaining = margins.map((m) => [...m]);
  const results: SparseTable[] = [];
  const current = new Map<string, number>();

  const assign = (cellIdx: number): void => {
    if (results.length >= maxTables) {
      throw new Error(`fiber enumeration exceeded ${maxTables} tables`);
    }
    if (cellIdx === cells.length) {
      if (remaining.every((m) => m.every((v) => v === 0))) {
        const total = [...current.values()].reduce((a, b) => a + b, 0);
        results.push({ axes, cells: new Map(current), total });
      }
      return;
    }
    const cell = cells[cellIdx];
    if (!cell) return;
    let cap = Number.POSITIVE_INFINITY;
    cell.forEach((labelIdx, axis) => {
      cap = Math.min(cap, remaining[axis]?.[labelIdx] ?? 0);
    });
    if (!Number.isFinite(cap)) cap = 0; // zero-axis guard: no margins to consume
    for (let count = 0; count <= cap; count += 1) {
      if (count > 0) {
        cell.forEach((labelIdx, axis) => {
          const m = remaining[axis];
          if (m) m[labelIdx] = (m[labelIdx] ?? 0) - 1;
        });
        current.set(cellKey(cell), count);
      }
      assign(cellIdx + 1);
    }
    // Restore margins consumed by the maximal count and clear the cell.
    if (cap > 0 && Number.isFinite(cap)) {
      cell.forEach((labelIdx, axis) => {
        const m = remaining[axis];
        if (m) m[labelIdx] = (m[labelIdx] ?? 0) + cap;
      });
    }
    current.delete(cellKey(cell));
  };
  assign(0);
  return results;
}

/** Canonical content signature for fiber-membership comparisons in tests. */
export function tableSignature(table: SparseTable): string {
  return [...table.cells.entries()]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}=${count}`)
    .join(';');
}
