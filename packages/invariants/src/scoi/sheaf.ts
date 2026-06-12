// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SCOI — cellular sheaf, coboundary, Laplacian, and normalized Dirichlet
// energy (WS-H.4.2a/b/c, SPEC §10.2).
//
// Model. Lenses are vertices of the overlap graph (the 1-skeleton of the
// nerve of community overlaps). Lens i carries a stalk R^{n_i} and a local
// interpretation s_i with ‖s_i‖ ≤ 1 (interpretation vectors are normalized
// at capture time; the builder validates this). Each overlap (i, j) carries
// restriction maps ρ_i, ρ_j into a shared comparison space R^{m_ij}, and
//
//   (d₀ s)_ij = ρ_i s_i − ρ_j s_j
//   energy(s) = ‖d₀ s‖² = Σ_overlaps ‖ρ_i s_i − ρ_j s_j‖²  =  sᵀ L₀ s
//
// with L₀ = d₀ᵀ d₀ positive semi-definite by construction.
//
// Normalizer (SPEC: "the energy of a maximally-disagreeing configuration on
// the same overlap graph"). Per overlap, the largest possible disagreement
// between unit-ball interpretations is bounded by
//
//   max_{‖a‖≤1, ‖b‖≤1} ‖ρ_i a − ρ_j b‖ ≤ σ_max(ρ_i) + σ_max(ρ_j)
//
// so  normalizer = Σ_overlaps (σ_max(ρ_i) + σ_max(ρ_j))²  bounds the energy
// of ANY configuration and SCOI = energy / normalizer ∈ [0, 1]. The bound is
// attained per overlap whenever the maps' top left-singular directions can
// be opposed (always for row-orthonormal restriction maps — the recommended
// construction — and exactly in the identity-map case used in tests), so
// SCOI = 1 reads "every overlap is at maximal disagreement". SCOI = 0 ⇔
// d₀ s = 0 ⇔ the local readings glue into a global section (s ∈ H⁰ = ker d₀).

import { jacobiEigSym, type Matrix, matMul, matVec, norm2, transpose } from '../math/linalg.js';

export interface LensInterpretation {
  lensId: string;
  /** Local interpretation vector in the lens's stalk, with ‖s‖ ≤ 1. */
  interpretation: readonly number[];
}

export interface OverlapDef {
  lensA: string;
  lensB: string;
  /** ρ_A: comparisonDim × stalkDim(A); rows map stalk A → comparison space. */
  rhoA: Matrix;
  /** ρ_B: comparisonDim × stalkDim(B). */
  rhoB: Matrix;
}

export interface SheafStructure {
  lenses: readonly LensInterpretation[];
  overlaps: readonly OverlapDef[];
}

export interface OverlapEnergy {
  lensA: string;
  lensB: string;
  /** ‖ρ_A s_A − ρ_B s_B‖² on this overlap. */
  energy: number;
  /** (σ_max(ρ_A) + σ_max(ρ_B))² — this overlap's normalizer share. */
  maxEnergy: number;
}

export interface ScoiEnergyResult {
  /** Normalized Dirichlet energy ∈ [0, 1]. */
  scoi: number;
  energy: number;
  normalizer: number;
  perOverlap: OverlapEnergy[];
  lensCount: number;
  overlapCount: number;
}

/** σ_max via the symmetric eigenproblem on ρᵀρ (deterministic Jacobi). */
function operatorNormOf(rho: Matrix): number {
  if (rho.length === 0 || (rho[0]?.length ?? 0) === 0) return 0;
  const ata = matMul(transpose(rho), rho);
  const { values } = jacobiEigSym(ata);
  return Math.sqrt(Math.max(0, values[0] ?? 0));
}

function validateStructure(structure: SheafStructure): Map<string, readonly number[]> {
  const byLens = new Map<string, readonly number[]>();
  for (const lens of structure.lenses) {
    if (byLens.has(lens.lensId)) throw new Error(`duplicate lens ${lens.lensId}`);
    const norm = norm2(lens.interpretation);
    if (!Number.isFinite(norm)) throw new Error(`non-finite interpretation for ${lens.lensId}`);
    if (norm > 1 + 1e-9) {
      throw new Error(`interpretation for ${lens.lensId} exceeds the unit ball (‖s‖ = ${norm})`);
    }
    byLens.set(lens.lensId, lens.interpretation);
  }
  for (const overlap of structure.overlaps) {
    const sA = byLens.get(overlap.lensA);
    const sB = byLens.get(overlap.lensB);
    if (!sA || !sB)
      throw new Error(`overlap references unknown lens ${overlap.lensA}/${overlap.lensB}`);
    const mA = overlap.rhoA.length;
    const mB = overlap.rhoB.length;
    if (mA !== mB || mA === 0) {
      throw new Error(
        `overlap ${overlap.lensA}~${overlap.lensB} comparison dims differ (${mA} vs ${mB})`,
      );
    }
    if ((overlap.rhoA[0]?.length ?? 0) !== sA.length) {
      throw new Error(`ρ_A shape mismatch on ${overlap.lensA}~${overlap.lensB}`);
    }
    if ((overlap.rhoB[0]?.length ?? 0) !== sB.length) {
      throw new Error(`ρ_B shape mismatch on ${overlap.lensA}~${overlap.lensB}`);
    }
  }
  return byLens;
}

/** (d₀ s)_ij for every overlap. */
export function coboundary(
  structure: SheafStructure,
): Array<{ overlap: OverlapDef; residual: number[] }> {
  const byLens = validateStructure(structure);
  return structure.overlaps.map((overlap) => {
    const sA = byLens.get(overlap.lensA);
    const sB = byLens.get(overlap.lensB);
    const projA = matVec(overlap.rhoA, sA ? [...sA] : []);
    const projB = matVec(overlap.rhoB, sB ? [...sB] : []);
    return {
      overlap,
      residual: projA.map((v, idx) => v - (projB[idx] ?? 0)),
    };
  });
}

/** The normalized Dirichlet energy (the SCOI score core, WS-H.4.2c). */
export function scoiEnergy(structure: SheafStructure): ScoiEnergyResult {
  const residuals = coboundary(structure);
  const perOverlap: OverlapEnergy[] = residuals.map(({ overlap, residual }) => {
    const energy = residual.reduce((acc, v) => acc + v * v, 0);
    const sigma = operatorNormOf(overlap.rhoA) + operatorNormOf(overlap.rhoB);
    return {
      lensA: overlap.lensA,
      lensB: overlap.lensB,
      energy,
      maxEnergy: sigma * sigma,
    };
  });
  const energy = perOverlap.reduce((acc, o) => acc + o.energy, 0);
  const normalizer = perOverlap.reduce((acc, o) => acc + o.maxEnergy, 0);
  const scoi = normalizer > 0 ? Math.min(1, Math.max(0, energy / normalizer)) : 0;
  return {
    scoi,
    energy,
    normalizer,
    perOverlap,
    lensCount: structure.lenses.length,
    overlapCount: structure.overlaps.length,
  };
}

/**
 * The full coboundary matrix d₀ (rows: stacked comparison spaces per
 * overlap; columns: stacked stalks per lens) and the sheaf Laplacian
 * L₀ = d₀ᵀ d₀. Used for the PSD property test and the H¹ diagnostic.
 */
export function coboundaryMatrix(structure: SheafStructure): {
  d0: Matrix;
  lensOffsets: Map<string, { offset: number; dim: number }>;
  totalStalkDim: number;
  totalOverlapDim: number;
} {
  validateStructure(structure);
  const lensOffsets = new Map<string, { offset: number; dim: number }>();
  let totalStalkDim = 0;
  for (const lens of structure.lenses) {
    lensOffsets.set(lens.lensId, { offset: totalStalkDim, dim: lens.interpretation.length });
    totalStalkDim += lens.interpretation.length;
  }
  let totalOverlapDim = 0;
  for (const overlap of structure.overlaps) totalOverlapDim += overlap.rhoA.length;

  const d0: Matrix = Array.from({ length: totalOverlapDim }, () =>
    new Array<number>(totalStalkDim).fill(0),
  );
  let rowOffset = 0;
  for (const overlap of structure.overlaps) {
    const a = lensOffsets.get(overlap.lensA);
    const b = lensOffsets.get(overlap.lensB);
    if (!a || !b) continue;
    const m = overlap.rhoA.length;
    for (let r = 0; r < m; r += 1) {
      const row = d0[rowOffset + r];
      if (!row) continue;
      for (let c = 0; c < a.dim; c += 1) row[a.offset + c] = overlap.rhoA[r]?.[c] ?? 0;
      for (let c = 0; c < b.dim; c += 1) row[b.offset + c] = -(overlap.rhoB[r]?.[c] ?? 0);
    }
    rowOffset += m;
  }
  return { d0, lensOffsets, totalStalkDim, totalOverlapDim };
}

/** L₀ = d₀ᵀ d₀ (positive semi-definite by construction; property-tested). */
export function sheafLaplacian(structure: SheafStructure): Matrix {
  const { d0 } = coboundaryMatrix(structure);
  return matMul(transpose(d0), d0);
}
