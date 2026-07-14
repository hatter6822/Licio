// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SCOI v2 — the structural cohomological obstruction (WS-H.4.2f,
// SPEC §10.2 correctness note, §30.4 SCOI v2).
//
// The v1 cochain (d₀s)_ij = ρ_i(s_i) − ρ_j(s_j) is BY CONSTRUCTION a
// coboundary, so its Čech class is trivial; v1 measures only its MAGNITUDE.
// The genuinely structural obstruction lives in the first sheaf cohomology
// of the overlap diagram: for a sheaf on a graph,
//
//   H¹ = C¹ / im(d₀),    dim H¹ = dim C¹ − rank(d₀)
//
// — nontrivial exactly when some edge-disagreement patterns can NEVER be
// produced by any choice of local readings. Given an OBSERVED 1-cochain g
// (directly measured cross-community disagreements), its decomposition
// g = d₀s + h with h ⊥ im(d₀) yields the harmonic representative h of [g]
// (the Hodge-minimal cochain: on a graph there is no d₁, so harmonic means
// h ∈ ker(d₀ᵀ) = im(d₀)^⊥). ‖h‖ is the part of the observed disagreement
// that no global assignment of local readings can explain — the persistent
// cross-community interpretation failure. Batch-only diagnostic; never an
// enforcement input by itself.

import { jacobiEigSym, matMul, matVec, transpose } from '../math/linalg.js';
import { coboundaryMatrix, type SheafStructure } from './sheaf.js';

export interface H1Diagnostic {
  /** dim H¹ = dim C¹ − rank d₀ (structural; independent of any readings). */
  dimH1: number;
  rankD0: number;
  dimC1: number;
  /** True when the overlap diagram admits unexplainable disagreement. */
  structuralObstruction: boolean;
}

export interface HarmonicResult extends H1Diagnostic {
  /** Norm of the harmonic representative of the observed cochain's class. */
  harmonicNorm: number;
  /** ‖h‖² / ‖g‖² — the unexplainable fraction of observed disagreement. */
  unexplainableFraction: number;
}

/** Numerical rank threshold relative to the largest eigenvalue. */
const RANK_TOLERANCE = 1e-9;

/**
 * Structural H¹ of the overlap diagram, from the restriction maps alone
 * (WS-H.4.2f acceptance: independent of a specific s). Rank is computed
 * from the spectrum of Δ₁ = d₀ d₀ᵀ (symmetric PSD; Jacobi).
 */
export function h1Diagnostic(structure: SheafStructure): H1Diagnostic {
  const { d0, totalOverlapDim } = coboundaryMatrix(structure);
  if (totalOverlapDim === 0) {
    return { dimH1: 0, rankD0: 0, dimC1: 0, structuralObstruction: false };
  }
  const delta1 = matMul(d0, transpose(d0));
  const { values } = jacobiEigSym(delta1);
  // Rank tolerance RELATIVE to the largest eigenvalue (values are descending;
  // Δ₁ is PSD so values[0] = λmax ≥ 0), so the rank is SCALE-INVARIANT:
  // rank(c·d₀) = rank(d₀). An absolute floor (the former `Math.max(1, λmax)`)
  // pinned the threshold to 1e-9 whenever λmax < 1, mis-ranking a small-scale
  // coboundary as full rank and reporting a false H¹ obstruction. λmax ≤ 0 ⇒
  // d₀ is the zero map ⇒ rank 0.
  const largest = values[0] ?? 0;
  const rank = largest <= 0 ? 0 : values.filter((v) => v > RANK_TOLERANCE * largest).length;
  const dimH1 = totalOverlapDim - rank;
  return {
    dimH1,
    rankD0: rank,
    dimC1: totalOverlapDim,
    structuralObstruction: dimH1 > 0,
  };
}

/**
 * Harmonic representative of an observed 1-cochain `g` (stacked per-overlap
 * disagreement vectors, in the structure's overlap order): h = g − P_im g,
 * with P_im the orthogonal projector onto im(d₀) assembled from the
 * eigenvectors of Δ₁ with eigenvalue above the rank tolerance.
 */
export function harmonicRepresentative(
  structure: SheafStructure,
  observedCochain: readonly number[],
): HarmonicResult {
  const { d0, totalOverlapDim } = coboundaryMatrix(structure);
  if (observedCochain.length !== totalOverlapDim) {
    throw new Error(
      `observed cochain has dimension ${observedCochain.length}, expected ${totalOverlapDim}`,
    );
  }
  const base = h1Diagnostic(structure);
  if (totalOverlapDim === 0) {
    return { ...base, harmonicNorm: 0, unexplainableFraction: 0 };
  }
  const delta1 = matMul(d0, transpose(d0));
  const { values, vectors } = jacobiEigSym(delta1);
  // Same scale-invariant, relative rank tolerance as h1Diagnostic: an eigenpair
  // enters the im(d₀) projector only above `RANK_TOLERANCE · λmax`. λmax ≤ 0 ⇒
  // im(d₀) = 0 ⇒ no projection (the whole cochain is harmonic).
  const largest = values[0] ?? 0;

  // h = g − Σ_{λ_k > tol} v_k ⟨v_k, g⟩  (projection onto im(d₀)^⊥).
  const h = [...observedCochain];
  for (let k = 0; largest > 0 && k < values.length; k += 1) {
    if ((values[k] ?? 0) <= RANK_TOLERANCE * largest) continue;
    const v = vectors[k];
    if (!v) continue;
    let coefficient = 0;
    for (let i = 0; i < h.length; i += 1) coefficient += (v[i] ?? 0) * (observedCochain[i] ?? 0);
    for (let i = 0; i < h.length; i += 1) h[i] = (h[i] ?? 0) - coefficient * (v[i] ?? 0);
  }
  const harmonicNorm = Math.sqrt(h.reduce((acc, x) => acc + x * x, 0));
  const observedNorm = Math.sqrt(observedCochain.reduce((acc, x) => acc + x * x, 0));
  return {
    ...base,
    harmonicNorm,
    unexplainableFraction: observedNorm > 0 ? (harmonicNorm / observedNorm) ** 2 : 0,
  };
}

/**
 * Convenience: the exact part d₀s of a configuration is always residual
 * to project — kept for analyst tooling to compare the observed pairwise
 * disagreements against what the current readings explain.
 */
export function explainedCochain(
  structure: SheafStructure,
  stackedReadings: readonly number[],
): number[] {
  const { d0 } = coboundaryMatrix(structure);
  return matVec(d0, [...stackedReadings]);
}
