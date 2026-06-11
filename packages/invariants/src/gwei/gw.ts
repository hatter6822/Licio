// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GWEI — entropic-regularized Gromov–Wasserstein distance
// (WS-H.5.2b, SPEC §9.2).
//
// Exact GW is a non-convex quadratic assignment (NP-hard), so production
// uses the standard entropic scheme (Peyré–Cuturi–Solomon 2016) on sampled
// cohort windows:
//
//   repeat:  C(π)_ij = cC_ij − 2 (D_A π D_Bᵀ)_ij
//            π ← argmin_{π ∈ Π(a,b)} ⟨C(π), π⟩ + ε KL(π ‖ a⊗b)   (Sinkhorn)
//
// with cC_ij = Σ_k D_A(i,k)² a_k + Σ_l D_B(j,l)² b_l. The inner problem is
// solved by LOG-DOMAIN Sinkhorn (logsumexp updates — no kernel underflow at
// small ε), and the returned coupling is ROUNDED onto Π(a,b) (Altschuler,
// Weed, Rigollet 2017, Algorithm 2) so that:
//
//   • the reported objective E(π) = Σ |D_A(i,k) − D_B(j,l)|² π_ij π_kl is
//     evaluated EXACTLY through the marginal decomposition (valid only with
//     exact marginals, which rounding guarantees), and
//   • E(π) is a true UPPER BOUND on GW₂² — any feasible coupling is.
//
// `gwDistanceWithStability` runs the solver across seeded initializations
// and a regularization grid, reports the spread as [ci_low, ci_high], and
// returns the best (lowest) upper bound as the estimate. The approximation
// and its interval are recorded on every output (gauge/approximation
// honesty; the invariant card documents the guarantee).

import { mulberry32 } from '../math/rng.js';
import { type MetricMeasureSpace, validatePseudometric } from './space.js';

export interface SinkhornOptions {
  epsilon: number;
  maxIterations?: number;
  /** L1 marginal-violation tolerance for early stop. */
  tolerance?: number;
}

function logSumExp(values: readonly number[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) if (v > max) max = v;
  if (!Number.isFinite(max)) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const v of values) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

/**
 * Log-domain Sinkhorn for min ⟨C, π⟩ + ε KL(π ‖ a⊗b) over Π(a, b).
 * π_ij = a_i b_j exp((f_i + g_j − C_ij)/ε); the potentials are updated by
 * exact alternating minimization (each update solves its marginal
 * constraint in closed form via logsumexp).
 */
export function logDomainSinkhorn(
  cost: readonly (readonly number[])[],
  a: readonly number[],
  b: readonly number[],
  options: SinkhornOptions,
): number[][] {
  const n = a.length;
  const m = b.length;
  const epsilon = options.epsilon;
  if (!(epsilon > 0)) throw new Error('sinkhorn epsilon must be positive');
  const maxIterations = options.maxIterations ?? 500;
  const tolerance = options.tolerance ?? 1e-9;
  const logA = a.map((v) => Math.log(v));
  const logB = b.map((v) => Math.log(v));
  let f = new Array<number>(n).fill(0);
  let g = new Array<number>(m).fill(0);
  const scratch = new Array<number>(Math.max(n, m)).fill(0);

  const plan = (): number[][] =>
    Array.from({ length: n }, (_, i) =>
      Array.from(
        { length: m },
        (_, j) =>
          Math.exp(((f[i] ?? 0) + (g[j] ?? 0) - (cost[i]?.[j] ?? 0)) / epsilon) *
          Math.exp((logA[i] ?? 0) + (logB[j] ?? 0)),
      ),
    );

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const nextF = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < m; j += 1) {
        scratch[j] = (logB[j] ?? 0) + ((g[j] ?? 0) - (cost[i]?.[j] ?? 0)) / epsilon;
      }
      nextF[i] = -epsilon * logSumExp(scratch.slice(0, m));
    }
    f = nextF;
    const nextG = new Array<number>(m);
    for (let j = 0; j < m; j += 1) {
      for (let i = 0; i < n; i += 1) {
        scratch[i] = (logA[i] ?? 0) + ((f[i] ?? 0) - (cost[i]?.[j] ?? 0)) / epsilon;
      }
      nextG[j] = -epsilon * logSumExp(scratch.slice(0, n));
    }
    g = nextG;

    // After a g-update every COLUMN constraint holds exactly; check rows.
    let rowViolation = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < m; j += 1) {
        scratch[j] =
          (logA[i] ?? 0) +
          (logB[j] ?? 0) +
          ((f[i] ?? 0) + (g[j] ?? 0) - (cost[i]?.[j] ?? 0)) / epsilon;
      }
      rowViolation += Math.abs(Math.exp(logSumExp(scratch.slice(0, m))) - (a[i] ?? 0));
    }
    if (rowViolation <= tolerance) break;
  }
  return plan();
}

/**
 * Round a near-coupling onto Π(a, b) exactly (Altschuler–Weed–Rigollet,
 * Alg. 2): scale rows down to ≤ a, columns down to ≤ b, then spread the
 * remaining mass as a rank-one correction. Output marginals match a and b
 * to floating-point accuracy.
 */
export function roundToCoupling(
  pi: readonly (readonly number[])[],
  a: readonly number[],
  b: readonly number[],
): number[][] {
  const n = a.length;
  const m = b.length;
  const x: number[][] = pi.map((row) => [...row]);
  for (let i = 0; i < n; i += 1) {
    const rowSum = x[i]?.reduce((acc, v) => acc + v, 0) ?? 0;
    const scale = rowSum > (a[i] ?? 0) && rowSum > 0 ? (a[i] ?? 0) / rowSum : 1;
    if (scale !== 1) {
      const row = x[i];
      if (row) for (let j = 0; j < m; j += 1) row[j] = (row[j] ?? 0) * scale;
    }
  }
  const colSums = new Array<number>(m).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) colSums[j] = (colSums[j] ?? 0) + (x[i]?.[j] ?? 0);
  }
  for (let j = 0; j < m; j += 1) {
    const scale =
      (colSums[j] ?? 0) > (b[j] ?? 0) && (colSums[j] ?? 0) > 0
        ? (b[j] ?? 0) / (colSums[j] ?? 1)
        : 1;
    if (scale !== 1) {
      for (let i = 0; i < n; i += 1) {
        const row = x[i];
        if (row) row[j] = (row[j] ?? 0) * scale;
      }
    }
  }
  const rowErr = new Array<number>(n).fill(0);
  const colErr = new Array<number>(m).fill(0);
  let errMass = 0;
  for (let i = 0; i < n; i += 1) {
    const rowSum = x[i]?.reduce((acc, v) => acc + v, 0) ?? 0;
    rowErr[i] = Math.max(0, (a[i] ?? 0) - rowSum);
    errMass += rowErr[i] ?? 0;
  }
  const colSums2 = new Array<number>(m).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) colSums2[j] = (colSums2[j] ?? 0) + (x[i]?.[j] ?? 0);
  }
  for (let j = 0; j < m; j += 1) colErr[j] = Math.max(0, (b[j] ?? 0) - (colSums2[j] ?? 0));
  if (errMass > 0) {
    for (let i = 0; i < n; i += 1) {
      const row = x[i];
      if (!row) continue;
      for (let j = 0; j < m; j += 1) {
        row[j] = (row[j] ?? 0) + ((rowErr[i] ?? 0) * (colErr[j] ?? 0)) / errMass;
      }
    }
  }
  return x;
}

/**
 * Exact GW objective for a coupling with EXACT marginals, via the
 * decomposition E(π) = Σ_ij π_ij (cC_ij − 2 (D_A π D_Bᵀ)_ij).
 */
export function gwObjective(
  dA: readonly (readonly number[])[],
  dB: readonly (readonly number[])[],
  a: readonly number[],
  b: readonly number[],
  pi: readonly (readonly number[])[],
): number {
  const n = a.length;
  const m = b.length;
  // cC_ij = Σ_k dA(i,k)² a_k + Σ_l dB(j,l)² b_l
  const rowA = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let k = 0; k < n; k += 1) sum += (dA[i]?.[k] ?? 0) ** 2 * (a[k] ?? 0);
    rowA[i] = sum;
  }
  const colB = new Array<number>(m).fill(0);
  for (let j = 0; j < m; j += 1) {
    let sum = 0;
    for (let l = 0; l < m; l += 1) sum += (dB[j]?.[l] ?? 0) ** 2 * (b[l] ?? 0);
    colB[j] = sum;
  }
  // T = dA · π · dBᵀ  (n×m), computed as (dA · π) then · dBᵀ.
  const dApi: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < n; k += 1) {
      const w = dA[i]?.[k] ?? 0;
      if (w === 0) continue;
      const piRow = pi[k];
      const outRow = dApi[i];
      if (!piRow || !outRow) continue;
      for (let j = 0; j < m; j += 1) outRow[j] = (outRow[j] ?? 0) + w * (piRow[j] ?? 0);
    }
  }
  let objective = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      const piij = pi[i]?.[j] ?? 0;
      if (piij === 0) continue;
      let t = 0;
      for (let l = 0; l < m; l += 1) t += (dApi[i]?.[l] ?? 0) * (dB[j]?.[l] ?? 0);
      objective += piij * ((rowA[i] ?? 0) + (colB[j] ?? 0) - 2 * t);
    }
  }
  return objective;
}

export interface EntropicGwOptions {
  epsilon: number;
  outerIterations?: number;
  sinkhornIterations?: number;
  /** Relative objective-change stop for the outer loop. */
  tolerance?: number;
  /** 0 ⇒ product-coupling init; otherwise a seeded perturbation. */
  seed?: number;
}

export interface EntropicGwResult {
  /** Upper-bound estimate of GW₂ (square root of the exact objective). */
  distance: number;
  objective: number;
  outerIterationsUsed: number;
}

/** One entropic-GW solve (see module header). Deterministic per seed. */
export function entropicGw(
  spaceA: MetricMeasureSpace,
  spaceB: MetricMeasureSpace,
  options: EntropicGwOptions,
): EntropicGwResult {
  for (const space of [spaceA, spaceB]) {
    const problem = validatePseudometric(space.distances);
    if (problem) throw new Error(problem);
  }
  const a = spaceA.measure;
  const b = spaceB.measure;
  const dA = spaceA.distances;
  const dB = spaceB.distances;
  const n = a.length;
  const m = b.length;
  const outerIterations = options.outerIterations ?? 50;
  const tolerance = options.tolerance ?? 1e-7;

  // Initial coupling: the product measure, optionally seeded-perturbed and
  // rounded back onto Π(a, b) (a feasible warm start either way).
  let pi: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => (a[i] ?? 0) * (b[j] ?? 0)),
  );
  if (options.seed !== undefined && options.seed !== 0) {
    const rng = mulberry32(options.seed);
    pi = pi.map((row) => row.map((v) => v * (0.5 + rng())));
    pi = roundToCoupling(pi, a, b);
  }

  const rowA = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let k = 0; k < n; k += 1) sum += (dA[i]?.[k] ?? 0) ** 2 * (a[k] ?? 0);
    rowA[i] = sum;
  }
  const colB = new Array<number>(m).fill(0);
  for (let j = 0; j < m; j += 1) {
    let sum = 0;
    for (let l = 0; l < m; l += 1) sum += (dB[j]?.[l] ?? 0) ** 2 * (b[l] ?? 0);
    colB[j] = sum;
  }

  let bestObjective = gwObjective(dA, dB, a, b, roundToCoupling(pi, a, b));
  let previousObjective = bestObjective;
  let used = 0;

  for (let outer = 0; outer < outerIterations; outer += 1) {
    used = outer + 1;
    // C(π)_ij = cC_ij − 2 (dA π dBᵀ)_ij
    const dApi: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let k = 0; k < n; k += 1) {
        const w = dA[i]?.[k] ?? 0;
        if (w === 0) continue;
        const piRow = pi[k];
        const outRow = dApi[i];
        if (!piRow || !outRow) continue;
        for (let j = 0; j < m; j += 1) outRow[j] = (outRow[j] ?? 0) + w * (piRow[j] ?? 0);
      }
    }
    const cost: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: m }, (_, j) => {
        let t = 0;
        for (let l = 0; l < m; l += 1) t += (dApi[i]?.[l] ?? 0) * (dB[j]?.[l] ?? 0);
        return (rowA[i] ?? 0) + (colB[j] ?? 0) - 2 * t;
      }),
    );
    pi = logDomainSinkhorn(cost, a, b, {
      epsilon: options.epsilon,
      ...(options.sinkhornIterations !== undefined
        ? { maxIterations: options.sinkhornIterations }
        : {}),
    });
    const rounded = roundToCoupling(pi, a, b);
    const objective = gwObjective(dA, dB, a, b, rounded);
    if (objective < bestObjective) bestObjective = objective;
    if (Math.abs(previousObjective - objective) <= tolerance * Math.max(1, Math.abs(objective))) {
      break;
    }
    previousObjective = objective;
  }

  return {
    distance: Math.sqrt(Math.max(0, bestObjective)),
    objective: bestObjective,
    outerIterationsUsed: used,
  };
}

export interface GwStabilityOptions {
  /** Seeds for initialization stability (0 = product init). */
  seeds: readonly number[];
  /** Regularization strengths to probe. */
  epsilons: readonly number[];
  outerIterations?: number;
  sinkhornIterations?: number;
}

export interface GwStabilityResult {
  /** Best (lowest) upper bound across all runs. */
  gw2: number;
  ciLow: number;
  ciHigh: number;
  seedCount: number;
  /** The regularization of the best run. */
  regularization: number;
  /** Every probed (seed, epsilon, distance) for the analyst dashboard. */
  runs: Array<{ seed: number; epsilon: number; distance: number }>;
}

/** Seed- and regularization-stability wrapper (WS-H.5.2b acceptance). */
export function gwDistanceWithStability(
  spaceA: MetricMeasureSpace,
  spaceB: MetricMeasureSpace,
  options: GwStabilityOptions,
): GwStabilityResult {
  if (options.seeds.length === 0 || options.epsilons.length === 0) {
    throw new Error('stability runs require at least one seed and one epsilon');
  }
  const runs: Array<{ seed: number; epsilon: number; distance: number }> = [];
  for (const epsilon of options.epsilons) {
    for (const seed of options.seeds) {
      const result = entropicGw(spaceA, spaceB, {
        epsilon,
        seed,
        ...(options.outerIterations !== undefined
          ? { outerIterations: options.outerIterations }
          : {}),
        ...(options.sinkhornIterations !== undefined
          ? { sinkhornIterations: options.sinkhornIterations }
          : {}),
      });
      runs.push({ seed, epsilon, distance: result.distance });
    }
  }
  const distances = runs.map((r) => r.distance);
  const gw2 = Math.min(...distances);
  const bestRun = runs.find((r) => r.distance === gw2);
  return {
    gw2,
    ciLow: gw2,
    ciHigh: Math.max(...distances),
    seedCount: options.seeds.length,
    regularization: bestRun?.epsilon ?? options.epsilons[0] ?? 0,
    runs,
  };
}
