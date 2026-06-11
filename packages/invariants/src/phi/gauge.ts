// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v2 — gauge-invariance verification (WS-H.6.2c-2, SPEC §11.2
// correctness note, §30.4 PHI v2 gate).
//
// Holonomy is defined only up to basepoint/frame conjugation H → Q H Qᵀ, so
// every PHI summary that leaves the invariant boundary must be
// conjugation-invariant. Two enforcement layers:
//
//   1. `verifyGaugeInvariance` conjugates H by seeded random orthogonal Q
//      and asserts the summary is unchanged within tolerance — the runtime
//      check promotion evidence and CI both run.
//   2. `assertGaugeInvariantBoundary` scans an outgoing score vector for
//      frame-dependent keys (raw matrix entries, embedding coordinates) and
//      rejects them — a deliberately frame-dependent summary FAILS.

import { type Matrix, matMul, randomOrthogonal, transpose } from '../math/linalg.js';
import { mulberry32 } from '../math/rng.js';
import { type PhiScoreOptions, phiScore } from './holonomy.js';

export interface GaugeVerification {
  invariant: boolean;
  trials: number;
  maxDeviation: number;
}

/**
 * Conjugate H by `trials` random orthogonal matrices and verify the PHI
 * summary (score, sorted rotation angles, trace) is invariant within
 * `tolerance`. Deterministic per seed.
 */
export function verifyGaugeInvariance(
  h: Matrix,
  options: { seed: number; trials?: number; tolerance?: number; score?: PhiScoreOptions } = {
    seed: 1,
  },
): GaugeVerification {
  const trials = options.trials ?? 8;
  const tolerance = options.tolerance ?? 1e-6;
  const rng = mulberry32(options.seed);
  const base = phiScore(h, options.score ?? {});
  let maxDeviation = 0;
  for (let t = 0; t < trials; t += 1) {
    const q = randomOrthogonal(h.length, rng);
    const conjugated = matMul(matMul(q, h), transpose(q));
    const other = phiScore(conjugated, options.score ?? {});
    maxDeviation = Math.max(maxDeviation, Math.abs(other.phi - base.phi));
    maxDeviation = Math.max(maxDeviation, Math.abs(other.trace - base.trace));
    const baseAngles = [...base.rotationAngles].sort((a, b) => a - b);
    const otherAngles = [...other.rotationAngles].sort((a, b) => a - b);
    if (baseAngles.length !== otherAngles.length) {
      maxDeviation = Math.max(maxDeviation, Number.POSITIVE_INFINITY);
    } else {
      for (let i = 0; i < baseAngles.length; i += 1) {
        maxDeviation = Math.max(
          maxDeviation,
          Math.abs((baseAngles[i] ?? 0) - (otherAngles[i] ?? 0)),
        );
      }
    }
  }
  return { invariant: maxDeviation <= tolerance, trials, maxDeviation };
}

/**
 * The closed set of gauge-invariant fields a PHI score vector may carry.
 * `loop_path` is topic-cluster ids (path data, not frame data); everything
 * numeric is a spectral function of H.
 */
export const PHI_GAUGE_INVARIANT_FIELDS = new Set([
  'phi',
  'rotation_angles',
  'loop_path',
  'fallback_log',
  'sensitive',
  'trace',
  'loop_length',
  // σ_min of the loop's worst cross-Gram: singular values are invariant
  // under the per-topic gauge T_x → T_x Q_xᵀ (M_xy → Q_y M_xy Q_xᵀ).
  'alignment_conditioning',
  // Path data (whether the reduced walk carried a multi-topic cycle).
  'cycle_content',
]);

const FRAME_DEPENDENT_PATTERN = /^(matrix|entry|coord|embedding|frame|basis|h_\d|transport)/i;

/**
 * Boundary scan (WS-H.6.2c-2): rejects any frame-dependent key on an
 * outgoing PHI score vector. Throwing here FAILS the computation (and the
 * CI build that exercises it) — frame data never leaves the invariant.
 */
export function assertGaugeInvariantBoundary(scoreVector: Record<string, unknown>): void {
  for (const key of Object.keys(scoreVector)) {
    if (!PHI_GAUGE_INVARIANT_FIELDS.has(key)) {
      throw new Error(`PHI boundary violation: unexpected field '${key}'`);
    }
    if (FRAME_DEPENDENT_PATTERN.test(key)) {
      throw new Error(`PHI boundary violation: frame-dependent field '${key}'`);
    }
  }
}
