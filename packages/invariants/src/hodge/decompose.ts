// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hodge Conversation Tension — discrete Helmholtz decomposition
// (WS-H.7.1b, SPEC §12.1).
//
//   flow = gradient + curl + harmonic
//
// with B₁ the edge–vertex incidence operator ((B₁φ)_(u,v) = φ_v − φ_u) and
// B₂ the triangle–edge curl operator (oriented boundary sum). B₂B₁ = 0 by
// construction, so im(B₁) ⊥ im(B₂ᵀ) EXACTLY and the three components are
// orthogonal:
//
//   gradient = B₁ φ*,   φ* = argmin ‖B₁φ − Y‖²   (CG on L₀ = B₁ᵀB₁)
//   curl     = B₂ᵀ ψ*,  ψ* = argmin ‖B₂ᵀψ − Y‖²  (CG on B₂B₂ᵀ)
//   harmonic = Y − gradient − curl
//
// Both normal-equation systems are consistent (right-hand sides lie in the
// operators' ranges), so CG converges to the minimum-norm potentials; the
// solves are matrix-free over the sparse incidence structure. The gradient
// part is the globally consistent ordering, curl the local cyclic
// inconsistency, harmonic the global irreducible conflict.

import { conjugateGradient } from '../math/linalg.js';
import type { ConversationComplex } from './complex.js';

export interface HelmholtzDecomposition {
  /** Per-edge components, in the complex's edge order. */
  gradient: number[];
  curl: number[];
  harmonic: number[];
  /** Euclidean magnitudes of the three components and the input flow. */
  gradientMagnitude: number;
  curlMagnitude: number;
  harmonicMagnitude: number;
  flowMagnitude: number;
  /** ‖harmonic‖² / ‖flow‖² ∈ [0, 1] — the structural-conflict measure. */
  harmonicFraction: number;
}

function magnitude(values: readonly number[]): number {
  return Math.sqrt(values.reduce((acc, v) => acc + v * v, 0));
}

/** Helmholtz decomposition of the complex's edge flow. */
export function helmholtzDecompose(complex: ConversationComplex): HelmholtzDecomposition {
  const vertexIndex = new Map(complex.vertices.map((v, i) => [v, i]));
  const edgeIndex = new Map(complex.edges.map((e, i) => [`${e.from} ${e.to}`, i]));
  const flow = complex.edges.map((e) => e.flow);
  const edgeCount = complex.edges.length;
  const vertexCount = complex.vertices.length;

  // --- gradient: solve (B₁ᵀ B₁) φ = B₁ᵀ Y, gradient = B₁ φ -----------------
  const applyB1 = (phi: readonly number[]): number[] =>
    complex.edges.map(
      (e) => (phi[vertexIndex.get(e.to) ?? 0] ?? 0) - (phi[vertexIndex.get(e.from) ?? 0] ?? 0),
    );
  const applyB1T = (y: readonly number[]): number[] => {
    const out = new Array<number>(vertexCount).fill(0);
    complex.edges.forEach((e, i) => {
      const from = vertexIndex.get(e.from);
      const to = vertexIndex.get(e.to);
      if (from === undefined || to === undefined) return;
      out[to] = (out[to] ?? 0) + (y[i] ?? 0);
      out[from] = (out[from] ?? 0) - (y[i] ?? 0);
    });
    return out;
  };
  const phi = conjugateGradient((x) => applyB1T(applyB1(x)), applyB1T(flow));
  const gradient = applyB1(phi);

  // --- curl: solve (B₂ B₂ᵀ) ψ = B₂ Y, curl = B₂ᵀ ψ -------------------------
  // Triangle (a < b < c) boundary: +(a,b) + (b,c) − (a,c) (canonical edges).
  interface TriangleEdges {
    ab: number;
    bc: number;
    ac: number;
  }
  const triangleEdges: TriangleEdges[] = complex.triangles.map(([a, b, c]) => ({
    ab: edgeIndex.get(`${a} ${b}`) ?? -1,
    bc: edgeIndex.get(`${b} ${c}`) ?? -1,
    ac: edgeIndex.get(`${a} ${c}`) ?? -1,
  }));
  for (const t of triangleEdges) {
    if (t.ab < 0 || t.bc < 0 || t.ac < 0) {
      throw new Error('triangle references a missing edge');
    }
  }
  const applyB2 = (y: readonly number[]): number[] =>
    triangleEdges.map((t) => (y[t.ab] ?? 0) + (y[t.bc] ?? 0) - (y[t.ac] ?? 0));
  const applyB2T = (psi: readonly number[]): number[] => {
    const out = new Array<number>(edgeCount).fill(0);
    triangleEdges.forEach((t, i) => {
      out[t.ab] = (out[t.ab] ?? 0) + (psi[i] ?? 0);
      out[t.bc] = (out[t.bc] ?? 0) + (psi[i] ?? 0);
      out[t.ac] = (out[t.ac] ?? 0) - (psi[i] ?? 0);
    });
    return out;
  };
  const psi =
    triangleEdges.length === 0 ? [] : conjugateGradient((x) => applyB2(applyB2T(x)), applyB2(flow));
  const curl = triangleEdges.length === 0 ? new Array<number>(edgeCount).fill(0) : applyB2T(psi);

  const harmonic = flow.map((v, i) => v - (gradient[i] ?? 0) - (curl[i] ?? 0));
  const flowMagnitude = magnitude(flow);
  const harmonicMagnitude = magnitude(harmonic);
  return {
    gradient,
    curl,
    harmonic,
    gradientMagnitude: magnitude(gradient),
    curlMagnitude: magnitude(curl),
    harmonicMagnitude,
    flowMagnitude,
    harmonicFraction: flowMagnitude > 0 ? Math.min(1, (harmonicMagnitude / flowMagnitude) ** 2) : 0,
  };
}
