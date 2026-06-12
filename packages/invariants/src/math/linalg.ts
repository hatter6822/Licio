// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic dense linear algebra for the WS-H invariant services.
//
// The invariants package has no numeric dependency (dependency-addition
// checklist: a Web/Node built-in or first-party implementation is preferred),
// so the small, well-understood kernels the invariant mathematics needs are
// implemented here with explicit tolerances and tests:
//
//   • basic matrix/vector arithmetic (row-major `number[][]`),
//   • Gram–Schmidt orthonormalization (PHI frames, random orthogonal Q),
//   • LU determinant with partial pivoting (PHI det(H) = ±1 branch),
//   • cyclic Jacobi eigendecomposition of SYMMETRIC matrices (SCOI/Hodge
//     projections, PHI rotation angles, operator norms) — Jacobi is chosen
//     for its unconditional convergence and determinism: rotations are
//     applied in a fixed cyclic order, the off-diagonal Frobenius mass is
//     strictly non-increasing, and convergence is quadratic near the end,
//   • a Gelfand spectral-radius estimate by repeated squaring (Braid
//     entropy): log ρ(A) = lim_m 2^{-m} log ‖A^{2^m}‖, with per-step
//     renormalization so the iterates never overflow.
//
// All routines are pure and total over their documented domains; every
// approximation parameter (sweep counts, tolerances) is an explicit argument
// with a reviewed default, per the gauge/approximation-honesty contract.

import { mulberry32 } from './rng.js';

export type Matrix = number[][];

export function zeros(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

export function identity(n: number): Matrix {
  const out = zeros(n, n);
  for (let i = 0; i < n; i += 1) {
    const row = out[i];
    if (row) row[i] = 1;
  }
  return out;
}

export function cloneMatrix(a: Matrix): Matrix {
  return a.map((row) => [...row]);
}

export function transpose(a: Matrix): Matrix {
  const rows = a.length;
  const cols = a[0]?.length ?? 0;
  const out = zeros(cols, rows);
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      const target = out[j];
      if (target) target[i] = a[i]?.[j] ?? 0;
    }
  }
  return out;
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const rows = a.length;
  const inner = a[0]?.length ?? 0;
  const cols = b[0]?.length ?? 0;
  if (b.length !== inner) {
    throw new Error(`matMul shape mismatch: ${rows}x${inner} times ${b.length}x${cols}`);
  }
  const out = zeros(rows, cols);
  for (let i = 0; i < rows; i += 1) {
    const ai = a[i];
    const oi = out[i];
    if (!ai || !oi) continue;
    for (let k = 0; k < inner; k += 1) {
      const aik = ai[k] ?? 0;
      if (aik === 0) continue;
      const bk = b[k];
      if (!bk) continue;
      for (let j = 0; j < cols; j += 1) {
        oi[j] = (oi[j] ?? 0) + aik * (bk[j] ?? 0);
      }
    }
  }
  return out;
}

export function matVec(a: Matrix, x: readonly number[]): number[] {
  return a.map((row) => row.reduce((acc, v, j) => acc + v * (x[j] ?? 0), 0));
}

export function matSub(a: Matrix, b: Matrix): Matrix {
  return a.map((row, i) => row.map((v, j) => v - (b[i]?.[j] ?? 0)));
}

export function matScale(a: Matrix, s: number): Matrix {
  return a.map((row) => row.map((v) => v * s));
}

export function frobeniusNorm(a: Matrix): number {
  let sum = 0;
  for (const row of a) for (const v of row) sum += v * v;
  return Math.sqrt(sum);
}

export function maxAbs(a: Matrix): number {
  let m = 0;
  for (const row of a) for (const v of row) m = Math.max(m, Math.abs(v));
  return m;
}

export function dot(x: readonly number[], y: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) sum += (x[i] ?? 0) * (y[i] ?? 0);
  return sum;
}

export function norm2(x: readonly number[]): number {
  return Math.sqrt(dot(x, x));
}

/** ‖A·Aᵀ − I‖∞ ≤ tol — used to validate orthogonal transports/frames. */
export function isOrthogonal(a: Matrix, tol = 1e-8): boolean {
  const n = a.length;
  if (n === 0 || a.some((row) => row.length !== n)) return false;
  return maxAbs(matSub(matMul(a, transpose(a)), identity(n))) <= tol;
}

/**
 * Gram–Schmidt orthonormalization of the ROWS of `a` (modified
 * Gram–Schmidt for numerical stability). Returns null when the rows are
 * rank-deficient at the given tolerance — callers degrade with a reason
 * code instead of silently producing a non-frame.
 */
export function gramSchmidt(a: Matrix, tol = 1e-10): Matrix | null {
  const out: number[][] = [];
  for (const row of a) {
    const v = [...row];
    for (const u of out) {
      const proj = dot(v, u);
      for (let j = 0; j < v.length; j += 1) v[j] = (v[j] ?? 0) - proj * (u[j] ?? 0);
    }
    const norm = norm2(v);
    if (norm <= tol) return null;
    out.push(v.map((x) => x / norm));
  }
  return out;
}

/**
 * Determinant via LU decomposition with partial pivoting. Deterministic;
 * O(n³). Exact sign is what PHI needs (det(H) = ±1 for orthogonal H).
 */
export function determinant(a: Matrix): number {
  const n = a.length;
  if (n === 0) return 1;
  const m = cloneMatrix(a);
  let det = 1;
  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let pivotAbs = Math.abs(m[col]?.[col] ?? 0);
    for (let r = col + 1; r < n; r += 1) {
      const candidate = Math.abs(m[r]?.[col] ?? 0);
      if (candidate > pivotAbs) {
        pivotAbs = candidate;
        pivotRow = r;
      }
    }
    if (pivotAbs === 0) return 0;
    if (pivotRow !== col) {
      const tmp = m[col];
      const other = m[pivotRow];
      if (tmp && other) {
        m[col] = other;
        m[pivotRow] = tmp;
        det = -det;
      }
    }
    const pivot = m[col]?.[col] ?? 0;
    det *= pivot;
    for (let r = col + 1; r < n; r += 1) {
      const row = m[r];
      const pivotRowVals = m[col];
      if (!row || !pivotRowVals) continue;
      const factor = (row[col] ?? 0) / pivot;
      if (factor === 0) continue;
      for (let c = col; c < n; c += 1) {
        row[c] = (row[c] ?? 0) - factor * (pivotRowVals[c] ?? 0);
      }
    }
  }
  return det;
}

export interface SymmetricEig {
  /** Eigenvalues in DESCENDING order. */
  values: number[];
  /** vectors[k] is the (unit-norm) eigenvector for values[k], as a row. */
  vectors: number[][];
}

/**
 * Cyclic Jacobi eigendecomposition of a SYMMETRIC matrix.
 *
 * Sweeps rotate away each off-diagonal entry in a fixed (p, q) order using
 * the numerically stable rotation t = sign(τ)/(|τ| + √(1+τ²)); the
 * off-diagonal Frobenius mass is non-increasing and the iteration converges
 * quadratically. Stops when the off-diagonal mass falls below
 * `tol · ‖A‖_F` or after `maxSweeps` (flagging non-convergence by throwing —
 * callers treat that as a degraded computation, never a silent result).
 */
export function jacobiEigSym(a: Matrix, maxSweeps = 64, tol = 1e-12): SymmetricEig {
  const n = a.length;
  if (n === 0) return { values: [], vectors: [] };
  for (const row of a) {
    if (row.length !== n) throw new Error('jacobiEigSym requires a square matrix');
  }
  const s = cloneMatrix(a);
  // Symmetry guard: asymmetric input would silently produce wrong results.
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const diff = Math.abs((s[i]?.[j] ?? 0) - (s[j]?.[i] ?? 0));
      const scale = Math.max(1, Math.abs(s[i]?.[j] ?? 0));
      if (diff > 1e-8 * scale) throw new Error('jacobiEigSym requires a symmetric matrix');
    }
  }
  const v = identity(n);
  const normA = frobeniusNorm(s) || 1;

  const offDiagonal = (): number => {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const x = s[i]?.[j] ?? 0;
        sum += 2 * x * x;
      }
    }
    return Math.sqrt(sum);
  };

  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    if (offDiagonal() <= tol * normA) break;
    if (sweep === maxSweeps - 1) {
      throw new Error(`jacobiEigSym did not converge within ${maxSweeps} sweeps`);
    }
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const spq = s[p]?.[q] ?? 0;
        if (Math.abs(spq) <= tol * normA * 1e-3) continue;
        const spp = s[p]?.[p] ?? 0;
        const sqq = s[q]?.[q] ?? 0;
        const tau = (sqq - spp) / (2 * spq);
        const t =
          tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : 1 / (tau - Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const sn = t * c;
        // Apply the rotation G(p, q, θ)ᵀ S G(p, q, θ) in place.
        for (let k = 0; k < n; k += 1) {
          const skp = s[k]?.[p] ?? 0;
          const skq = s[k]?.[q] ?? 0;
          const rowK = s[k];
          if (!rowK) continue;
          rowK[p] = c * skp - sn * skq;
          rowK[q] = sn * skp + c * skq;
        }
        for (let k = 0; k < n; k += 1) {
          const spk = s[p]?.[k] ?? 0;
          const sqk = s[q]?.[k] ?? 0;
          const rowP = s[p];
          const rowQ = s[q];
          if (!rowP || !rowQ) continue;
          rowP[k] = c * spk - sn * sqk;
          rowQ[k] = sn * spk + c * sqk;
        }
        // Accumulate eigenvectors (columns of the rotation product) as rows of v.
        for (let k = 0; k < n; k += 1) {
          const vpk = v[p]?.[k] ?? 0;
          const vqk = v[q]?.[k] ?? 0;
          const rowP = v[p];
          const rowQ = v[q];
          if (!rowP || !rowQ) continue;
          rowP[k] = c * vpk - sn * vqk;
          rowQ[k] = sn * vpk + c * vqk;
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (i, j) => (s[j]?.[j] ?? 0) - (s[i]?.[i] ?? 0),
  );
  return {
    values: order.map((i) => s[i]?.[i] ?? 0),
    vectors: order.map((i) => [...(v[i] ?? [])]),
  };
}

/** Operator (spectral) norm σ_max(A) = √λ_max(AᵀA), via Jacobi. */
export function operatorNorm(a: Matrix): number {
  if (a.length === 0 || (a[0]?.length ?? 0) === 0) return 0;
  const ata = matMul(transpose(a), a);
  const { values } = jacobiEigSym(ata);
  return Math.sqrt(Math.max(0, values[0] ?? 0));
}

/**
 * Gelfand spectral-radius estimate by repeated squaring with
 * renormalization:
 *
 *   B₀ = A, n_k = ‖B_k‖_F, B_{k+1} = (B_k / n_k)²
 *   log ρ(A) = Σ_{k≥0} log(n_k) / 2^k    (partial sum after `squarings` steps)
 *
 * The partial sum converges geometrically (each step halves the remaining
 * weight), so 32 squarings places the truncation error far below the
 * documented tolerance for the matrices the Braid invariant feeds in.
 * Returns 0 for the zero/nilpotent case (n_k underflows).
 */
export function spectralRadius(a: Matrix, squarings = 32): number {
  const n = a.length;
  if (n === 0) return 0;
  let b = cloneMatrix(a);
  let logRho = 0;
  let weight = 1;
  for (let k = 0; k < squarings; k += 1) {
    const norm = frobeniusNorm(b);
    if (!Number.isFinite(norm)) throw new Error('spectralRadius overflow');
    if (norm < 1e-280) return 0;
    logRho += weight * Math.log(norm);
    weight /= 2;
    const scaled = matScale(b, 1 / norm);
    b = matMul(scaled, scaled);
  }
  // The limit lies in [ρ, ρ·n^{Σ weights}]; after many squarings the
  // remaining ‖·‖_F-vs-ρ gap is bounded by the final term's weight.
  return Math.exp(logRho);
}

/**
 * Conjugate gradient for SYMMETRIC POSITIVE SEMI-DEFINITE systems given as
 * a matrix-free operator. For consistent systems (b ∈ range(A) — exactly
 * the normal-equation systems the Hodge decomposition solves), CG iterates
 * stay in the Krylov space of b and converge to the minimum-norm solution.
 * Deterministic: fixed iteration cap, explicit residual tolerance.
 */
export function conjugateGradient(
  applyA: (x: readonly number[]) => number[],
  b: readonly number[],
  options: { maxIterations?: number; tolerance?: number } = {},
): number[] {
  const n = b.length;
  const maxIterations = options.maxIterations ?? Math.max(64, 4 * n);
  const tolerance = options.tolerance ?? 1e-12;
  const bNorm = norm2(b);
  if (bNorm === 0) return new Array<number>(n).fill(0);
  let x = new Array<number>(n).fill(0);
  let r = [...b];
  let p = [...r];
  let rsOld = dot(r, r);
  for (let iter = 0; iter < maxIterations; iter += 1) {
    if (Math.sqrt(rsOld) <= tolerance * bNorm) break;
    const ap = applyA(p);
    const pAp = dot(p, ap);
    if (pAp <= 0) break; // numerical breakdown on the semi-definite kernel
    const alpha = rsOld / pAp;
    x = x.map((v, i) => v + alpha * (p[i] ?? 0));
    r = r.map((v, i) => v - alpha * (ap[i] ?? 0));
    const rsNew = dot(r, r);
    p = r.map((v, i) => v + (rsNew / rsOld) * (p[i] ?? 0));
    rsOld = rsNew;
  }
  return x;
}

/**
 * A Haar-like random orthogonal matrix from a seeded RNG: Gram–Schmidt on a
 * matrix of uniform [−1, 1) entries, retrying on (measure-zero) rank
 * deficiency. Used by the PHI gauge-invariance verifier.
 */
export function randomOrthogonal(n: number, rng: () => number): Matrix {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const raw = Array.from({ length: n }, () => Array.from({ length: n }, () => rng() * 2 - 1));
    const q = gramSchmidt(raw);
    if (q) return q;
  }
  throw new Error('randomOrthogonal: repeated rank deficiency');
}

export interface SmallSvd {
  /** Left singular vectors as COLUMNS of u (m×r). */
  u: Matrix;
  /** Singular values, descending, length r = min(m, n). */
  sigma: number[];
  /** Right singular vectors as COLUMNS of v (n×r). */
  v: Matrix;
}

/**
 * SVD of a small dense matrix via the symmetric eigenproblem on MᵀM
 * (deterministic Jacobi): MᵀM = V Σ² Vᵀ, then u_k = M v_k / σ_k for
 * σ_k above the rank tolerance. Left vectors for (numerically) zero
 * singular values are not constructed — callers treat them as the rank
 * boundary. Intended for the n ≤ 16 matrices the invariant services use.
 */
export function svdSmall(m: Matrix, tol = 1e-10): SmallSvd {
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return { u: [], sigma: [], v: [] };
  const mtm = matMul(transpose(m), m);
  const { values, vectors } = jacobiEigSym(mtm);
  const r = Math.min(rows, cols);
  const sigma: number[] = [];
  const uCols: number[][] = [];
  const vCols: number[][] = [];
  for (let k = 0; k < r; k += 1) {
    const lambda = Math.max(0, values[k] ?? 0);
    const s = Math.sqrt(lambda);
    sigma.push(s);
    const vk = vectors[k] ?? [];
    vCols.push([...vk]);
    if (s > tol) {
      const mv = matVec(m, vk);
      uCols.push(mv.map((x) => x / s));
    } else {
      // Rank boundary: a zero column documents the missing direction.
      uCols.push(new Array<number>(rows).fill(0));
    }
  }
  // Column-major assembly.
  const u: Matrix = Array.from({ length: rows }, (_, i) => uCols.map((col) => col[i] ?? 0));
  const v: Matrix = Array.from({ length: cols }, (_, i) => vCols.map((col) => col[i] ?? 0));
  return { u, sigma, v };
}

export interface RotationFit {
  /** The special-orthogonal (det = +1) alignment, n×n. */
  rotation: Matrix;
  /** σ_min of the cross matrix — near 0 ⇒ the fit is ill-determined. */
  conditioning: number;
  degenerate: boolean;
}

/**
 * Kabsch / special-orthogonal Procrustes: the rotation R ∈ SO(n)
 * maximizing tr(Rᵀ M) for a cross matrix M (equivalently the closest
 * rotation to M). With M = U Σ Vᵀ:
 *
 *   R = U · diag(1, …, 1, det(U Vᵀ)) · Vᵀ
 *
 * The determinant correction keeps R orientation-preserving, so loop
 * holonomies stay in SO(n) where the principal matrix logarithm is real
 * (SPEC §11.2). `degenerate` flags σ_min ≤ tol — the alignment is not
 * uniquely determined and callers must degrade with a reason code instead
 * of trusting an arbitrary completion.
 */
export function kabschRotation(crossMatrix: Matrix, tol = 1e-9): RotationFit {
  const n = crossMatrix.length;
  if (n === 0 || crossMatrix.some((row) => row.length !== n)) {
    throw new Error('kabschRotation requires a square cross matrix');
  }
  const { u, sigma, v } = svdSmall(crossMatrix, tol);
  const sMin = sigma[sigma.length - 1] ?? 0;
  const uvT = matMul(u, transpose(v));
  const det = determinant(uvT);
  // Flip the LAST column of u when det < 0 (the standard Kabsch correction
  // applied to the smallest singular direction).
  const uCorrected = det < 0 ? u.map((row) => row.map((x, j) => (j === n - 1 ? -x : x))) : u;
  const rotation = matMul(uCorrected, transpose(v));
  return { rotation, conditioning: sMin, degenerate: sMin <= tol };
}

/**
 * Deterministic seeded random projection R ∈ R^{rows×cols} with entries
 * scaled by 1/√rows (Johnson–Lindenstrauss style). Replaces the degenerate
 * "take the first k embedding components" pattern: a dense projection
 * preserves pairwise geometry in expectation regardless of how the
 * provider distributes mass across coordinates.
 */
export function randomProjectionMatrix(seed: number, rows: number, cols: number): Matrix {
  const rng = mulberry32(seed);
  // Uniform on [−√3, √3]/√rows ⇒ per-entry variance 1/rows ⇒ E‖Rx‖² = ‖x‖².
  const scale = Math.sqrt(3) / Math.sqrt(rows);
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => (rng() * 2 - 1) * scale),
  );
}

/**
 * Deterministic sign convention for eigen/singular vectors: each ROW
 * vector is flipped so its largest-magnitude entry is positive (ties by
 * lowest index). Stabilizes downstream constructions against the sign
 * ambiguity of eigendecompositions.
 */
export function signFixRows(vectors: Matrix): Matrix {
  return vectors.map((row) => {
    let best = 0;
    for (let i = 1; i < row.length; i += 1) {
      if (Math.abs(row[i] ?? 0) > Math.abs(row[best] ?? 0)) best = i;
    }
    return (row[best] ?? 0) < 0 ? row.map((x) => -x) : [...row];
  });
}
