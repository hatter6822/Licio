// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI — frames, orthogonal transports, holonomy, and the PHI score
// (WS-H.6.2a/b/c, SPEC §11.2).
//
// Frames. Each topic context carries an orthonormal frame F ∈ O(n) for the
// latent-preference space (rows orthonormal; Gram–Schmidt provided for raw
// behavioral estimates). For full orthonormal frames the orthogonal
// Procrustes problem min_{A ∈ O(n)} ‖A F_x − F_y‖_F has the EXACT closed-form
// solution A_xy = F_yᵀ... — precisely: with frames stored as row-orthonormal
// matrices whose ROWS are the basis vectors, the change-of-frame transport
// is A_xy = F_yᵀ F_x? No: we define transport on coordinate vectors —
// a preference v expressed in frame x as c_x = F_x v transforms to
// c_y = F_y v = F_y F_xᵀ c_x, so
//
//   A_xy = F_y F_xᵀ  ∈ O(n)   (orthogonal as a product of orthogonal maps)
//
// — no SVD needed, exact by construction.
//
// Holonomy. Around the closed path x₀ → x₁ → … → x_k = x₀,
//
//   H(γ) = A_{x_{k−1}, x_k} ⋯ A_{x_1, x_2} A_{x_0, x_1}
//
// (matrices applied left-to-right along the path, so the product is written
// right-to-left). H ∈ O(n); flat transport ⇒ H = I.
//
// Score. PHI(γ) = ‖log H‖_F. For H ∈ SO(n) the principal log is real
// skew-symmetric and ‖log H‖_F = √(2 Σ_k θ_k²) in the rotation angles θ_k.
// The angles are extracted GAUGE-INVARIANTLY from the spectrum of the
// symmetric part S = (H + Hᵀ)/2: in the real canonical form, S's spectrum
// is {cos θ_k (×2 per rotation pair)} ∪ {+1 per fixed axis} ∪ {−1 per
// π-rotation pair}; conjugation H → QHQᵀ maps S → QSQᵀ and leaves the
// spectrum — hence PHI — unchanged. Near θ = π (eigenvalues at −1) the
// principal log is ill-conditioned, so the robust fallback ‖H − I‖_F is
// reported with reason code MATRIX_LOG_FALLBACK (SPEC §11.2 correctness
// note); the same fallback covers det(H) = −1 (orientation-reversing
// holonomy, where no real log exists).

import {
  determinant,
  frobeniusNorm,
  gramSchmidt,
  identity,
  isOrthogonal,
  jacobiEigSym,
  type Matrix,
  matMul,
  matSub,
  transpose,
} from '../math/linalg.js';

/** Orthonormalize a raw behavioral frame estimate (rows = basis vectors). */
export function orthonormalFrame(raw: Matrix, tol = 1e-10): Matrix | null {
  if (raw.length === 0) return null;
  if (raw.some((row) => row.length !== raw.length)) return null; // square only
  return gramSchmidt(raw, tol);
}

/** Transport A_xy = F_y F_xᵀ between two row-orthonormal frames. */
export function transportBetween(frameX: Matrix, frameY: Matrix): Matrix {
  if (!isOrthogonal(frameX) || !isOrthogonal(frameY)) {
    throw new Error('transportBetween requires orthonormal frames');
  }
  return matMul(frameY, transpose(frameX));
}

/**
 * Holonomy of an ordered transport list [A_{x0,x1}, A_{x1,x2}, …]:
 * H = A_{k−1,k} ⋯ A_{0,1}.
 */
export function holonomy(transports: readonly Matrix[]): Matrix {
  if (transports.length === 0) throw new Error('holonomy requires at least one transport');
  const n = transports[0]?.length ?? 0;
  let h = identity(n);
  for (const a of transports) {
    if (!isOrthogonal(a, 1e-6)) throw new Error('holonomy transport is not orthogonal');
    h = matMul(a, h);
  }
  return h;
}

export interface PhiScoreOptions {
  /** cos θ below this (near −1) triggers the ‖H − I‖_F fallback. */
  piCosineTolerance?: number;
  /** Pairing tolerance for the doubled cos θ eigenvalues. */
  pairTolerance?: number;
  /** Orthogonality acceptance tolerance for H. */
  orthogonalityTolerance?: number;
}

export interface PhiScore {
  /** ‖log H‖_F, or ‖H − I‖_F on the fallback path. */
  phi: number;
  /** Rotation angles θ_k ∈ (0, π) (empty on the fallback path). */
  rotationAngles: number[];
  fallback: boolean;
  reasonCodes: string[];
  /** tr(H) — a gauge-invariant diagnostic surfaced for dashboards. */
  trace: number;
}

/**
 * PHI(γ) from a holonomy matrix. Gauge-invariant by construction: every
 * reported quantity is a spectral function of H (verified by WS-H.6.2c-2).
 */
export function phiScore(h: Matrix, options: PhiScoreOptions = {}): PhiScore {
  const n = h.length;
  if (n === 0) throw new Error('phiScore requires a non-empty matrix');
  const piCos = options.piCosineTolerance ?? -1 + 1e-6;
  const pairTol = options.pairTolerance ?? 1e-6;
  const orthoTol = options.orthogonalityTolerance ?? 1e-6;

  let trace = 0;
  for (let i = 0; i < n; i += 1) trace += h[i]?.[i] ?? 0;

  if (!isOrthogonal(h, orthoTol)) {
    throw new Error('phiScore requires an orthogonal holonomy matrix');
  }

  const fallbackScore = (codes: string[]): PhiScore => ({
    phi: frobeniusNorm(matSub(h, identity(n))),
    rotationAngles: [],
    fallback: true,
    reasonCodes: codes,
    trace,
  });

  // Orientation-reversing holonomy (det = −1): no real logarithm exists.
  if (determinant(h) < 0) return fallbackScore(['MATRIX_LOG_FALLBACK']);

  // Spectrum of the symmetric part: cos θ pairs, +1 axes, −1 π-pairs.
  const s = h.map((row, i) => row.map((v, j) => (v + (h[j]?.[i] ?? 0)) / 2));
  let values: number[];
  try {
    values = jacobiValues(s);
  } catch {
    return fallbackScore(['MATRIX_LOG_FALLBACK']);
  }

  // Clamp the spectrum into [−1, 1] (numerical drift only).
  const clamped = values.map((v) => Math.min(1, Math.max(-1, v))).sort((a, b) => b - a);

  // Near-π rotations: principal log ill-conditioned → robust fallback.
  if (clamped.some((v) => v <= piCos)) return fallbackScore(['MATRIX_LOG_FALLBACK']);

  // Pair up the strictly-interior eigenvalues (each rotation contributes
  // cos θ twice); +1 entries are fixed directions (θ = 0).
  const interior = clamped.filter((v) => v < 1 - pairTol);
  const angles: number[] = [];
  for (let i = 0; i < interior.length; i += 2) {
    const a = interior[i];
    const b = interior[i + 1];
    if (a === undefined || b === undefined || Math.abs(a - b) > Math.sqrt(pairTol)) {
      // An unpaired interior eigenvalue contradicts H ∈ SO(n) beyond
      // numerical tolerance — degrade honestly rather than guess.
      return fallbackScore(['MATRIX_LOG_FALLBACK']);
    }
    angles.push(Math.acos(Math.min(1, Math.max(-1, (a + b) / 2))));
  }

  const phi = Math.sqrt(2 * angles.reduce((acc, t) => acc + t * t, 0));
  return { phi, rotationAngles: angles, fallback: false, reasonCodes: [], trace };
}

function jacobiValues(s: Matrix): number[] {
  return jacobiEigSym(s).values;
}
