// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v1 transport estimation (WS-H.6.2a/b, SPEC §11.2) — the
// PAIR-SPECIFIC estimator.
//
// Why pair-specific matters (the flat-connection theorem). Any transport
// family of the form A_xy = G(y)·H(x) — in particular A_xy = F_y F_xᵀ for
// a global assignment of frames — telescopes around every closed loop:
// H(γ) = F_k F_{k-1}ᵀ ⋯ F_1 F_0ᵀ = F_0 F_0ᵀ = I. Such a connection is flat
// BY CONSTRUCTION and its holonomy carries no information. Non-trivial
// holonomy requires transports estimated from PAIR data that do not factor
// through per-topic terms.
//
// The estimator here:
//
//   1. Each topic context x gets a BEHAVIORAL STRUCTURE T_x ∈ R^{d×n}: the
//      n leading principal directions of the topic's content embeddings in
//      a shared d-dimensional projected space, scaled by the square roots
//      of their variances (a weighted local frame — "what engaging with
//      this topic looks like", learned from the topic's data).
//   2. The transport A_xy ∈ SO(n) is the Kabsch (special-orthogonal
//      Procrustes) rotation closest to the cross-Gram M_xy = T_yᵀ T_x —
//      the best rotation aligning x's preference coordinates to y's as the
//      shared-space geometry allows.
//
// The Kabsch factor of a product does NOT factor through the individual
// structures (polar decomposition is not multiplicative), so the loop
// holonomy H(γ) = A_{k-1,k} ⋯ A_{0,1} is the identity exactly when the
// pairwise best-alignments are mutually consistent around the loop — and
// deviates (genuine connection curvature) when moving x → y → z twists
// preference coordinates differently from moving x → z. Sanity anchors
// (tested): identical structures ⇒ M = TᵀT is symmetric PSD ⇒ A = I ⇒
// H = I; generic distinct structures ⇒ H ≠ I.
//
// Degeneracy is honest: a structure whose n-th variance direction is not
// resolved (λ_n ≤ tol·λ_1), or a pair whose cross-Gram is rank-deficient,
// yields NO transport — the caller degrades with INSUFFICIENT_COVERAGE
// rather than inventing an arbitrary completion.

import {
  jacobiEigSym,
  kabschRotation,
  type Matrix,
  matMul,
  signFixRows,
  transpose,
} from '../math/linalg.js';
import { holonomy } from './holonomy.js';

/** Default preference-space dimension (rotation coordinates). */
export const PHI_PREFERENCE_DIM = 4;

/** Default shared projected embedding dimension the structures live in. */
export const PHI_SHARED_DIM = 8;

export interface TopicStructure {
  topicClusterId: string;
  /** d×n weighted principal directions (columns), √λ-scaled. */
  t: Matrix;
  /** λ_n / λ_1 — how well the n-th direction is resolved. */
  resolution: number;
  /** Embeddings the structure was estimated from. */
  sampleCount: number;
}

export interface TopicStructureOptions {
  /** Preference dimension n (default PHI_PREFERENCE_DIM). */
  dimension?: number;
  /** λ_n must exceed tol·λ_1 or the structure is rejected. */
  resolutionTolerance?: number;
}

/**
 * Estimate a topic's behavioral structure from its projected content
 * embeddings (rows of `projected`, each length d). Returns null when fewer
 * than n samples exist or the n-th principal direction is unresolved.
 */
export function buildTopicStructure(
  topicClusterId: string,
  projected: readonly (readonly number[])[],
  options: TopicStructureOptions = {},
): TopicStructure | null {
  const n = options.dimension ?? PHI_PREFERENCE_DIM;
  const tol = options.resolutionTolerance ?? 1e-6;
  if (projected.length < n) return null;
  const d = projected[0]?.length ?? 0;
  if (d < n) return null;
  // Second moment G = Σ ê êᵀ / m (uncentered: the origin of the projected
  // space is shared across topics, so absolute direction carries meaning).
  const g: Matrix = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (const row of projected) {
    for (let i = 0; i < d; i += 1) {
      const gi = g[i];
      if (!gi) continue;
      const ri = row[i] ?? 0;
      if (ri === 0) continue;
      for (let j = 0; j < d; j += 1) gi[j] = (gi[j] ?? 0) + (ri * (row[j] ?? 0)) / projected.length;
    }
  }
  const { values, vectors } = jacobiEigSym(g);
  const lambda1 = Math.max(0, values[0] ?? 0);
  const lambdaN = Math.max(0, values[n - 1] ?? 0);
  if (lambda1 <= 0 || lambdaN <= tol * lambda1) return null;
  const directions = signFixRows(vectors.slice(0, n));
  // Columns of t are √λ_k · w_k.
  const t: Matrix = Array.from({ length: d }, (_, row) =>
    Array.from(
      { length: n },
      (_, k) => Math.sqrt(Math.max(0, values[k] ?? 0)) * (directions[k]?.[row] ?? 0),
    ),
  );
  return {
    topicClusterId,
    t,
    resolution: lambdaN / lambda1,
    sampleCount: projected.length,
  };
}

export interface PairTransport {
  rotation: Matrix;
  /** σ_min of the cross-Gram — alignment conditioning. */
  conditioning: number;
}

/**
 * The pair transport A_xy ∈ SO(n): the Kabsch rotation for the cross-Gram
 * T_yᵀ T_x. Null when the alignment is rank-deficient (no unique best
 * rotation exists).
 */
export function pairTransport(
  from: TopicStructure,
  to: TopicStructure,
  tol = 1e-9,
): PairTransport | null {
  const cross = matMul(transpose(to.t), from.t);
  const fit = kabschRotation(cross, tol);
  if (fit.degenerate) return null;
  return { rotation: fit.rotation, conditioning: fit.conditioning };
}

/**
 * Cancel immediate backtracks (… x → y → x …) in a topic walk, repeatedly,
 * via a stack. For any SYMMETRIC connection (A_yx = A_xyᵀ — Kabsch satisfies
 * this exactly: the polar factor of Mᵀ is the transpose of the polar factor
 * of M), the composed holonomy is invariant under this reduction, so the
 * reduced walk is the walk's honest cycle content. A star-shaped revisit
 * path a → b → a → c → a reduces to the single point [a]: it bounds no
 * area and its holonomy is trivial BY GEOMETRY, not by defect.
 */
export function reduceWalk(path: readonly string[]): string[] {
  const stack: string[] = [];
  for (const node of path) {
    if (stack.length >= 2 && stack[stack.length - 2] === node) {
      stack.pop();
    } else if (stack[stack.length - 1] !== node) {
      stack.push(node);
    }
  }
  return stack;
}

/**
 * Extract the holonomy cycle from a raw revisit walk: reduce backtracks,
 * then require a CLOSED path over at least `minDistinct` distinct topics
 * (default 3 — two-topic cycles are identically trivial under a symmetric
 * connection). Returns null when the walk carries no cycle content; the
 * caller reports PHI = 0 honestly (a flat loop, not a coverage gap).
 */
export function holonomyCycleFromWalk(path: readonly string[], minDistinct = 3): string[] | null {
  const reduced = reduceWalk(path);
  if (reduced.length < 4) return null;
  if (reduced[0] !== reduced[reduced.length - 1]) return null;
  const distinct = new Set(reduced.slice(0, -1));
  if (distinct.size < minDistinct) return null;
  return reduced;
}

export interface LoopHolonomyResult {
  h: Matrix;
  /** min conditioning across the loop's transports. */
  conditioning: number;
  transportsUsed: number;
}

/**
 * Holonomy of a closed topic-cluster path from pair transports. Null when
 * any leg's structure is missing or its transport is degenerate — the
 * caller reports the coverage gap.
 */
export function loopHolonomy(
  structures: ReadonlyMap<string, TopicStructure>,
  loopPath: readonly string[],
): LoopHolonomyResult | null {
  if (loopPath.length < 2) return null;
  const transports: Matrix[] = [];
  let conditioning = Number.POSITIVE_INFINITY;
  for (let i = 1; i < loopPath.length; i += 1) {
    const from = structures.get(loopPath[i - 1] ?? '');
    const to = structures.get(loopPath[i] ?? '');
    if (!from || !to) return null;
    const transport = pairTransport(from, to);
    if (!transport) return null;
    transports.push(transport.rotation);
    conditioning = Math.min(conditioning, transport.conditioning);
  }
  return { h: holonomy(transports), conditioning, transportsUsed: transports.length };
}
