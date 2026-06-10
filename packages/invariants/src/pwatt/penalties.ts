// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Penalty integration (WS-E.2.3d, SPEC §5.4/§5.5). Penalties are SEPARATE
// nonnegative coefficients on risk terms — they are NOT part of the convex
// combination of positive weights — so a high-risk item's penalties can drive
// its total below zero (denied distribution) regardless of positive signal.
// Nonnegativity of both coefficient and input is enforced, so a penalty can
// never accidentally become a reward.
//
// v1 sourcing: pM (coordination) and pR (redundancy) take real inputs from the
// WS-E burst detector / MERI as they land (WS-H.3 / WS-H.2 integration point);
// pH (holonomy, PHI) and pT (harmful tension, Hodge) are PLACEHOLDERS pinned
// to zero input until their v0 implementations exist (WS-H.6 / WS-H.7).
import { clamp01 } from './types.js';

/** The four penalty coefficients (each >= 0; configurable). */
export interface PenaltyCoefficients {
  /** Coordination penalty coefficient (MFCI-derived input). */
  pM: number;
  /** Holonomy-risk coefficient (PHI; placeholder input in v1). */
  pH: number;
  /** Harmful-tension coefficient (Hodge + safety; placeholder input in v1). */
  pT: number;
  /** Redundancy coefficient (MERI-derived input). */
  pR: number;
}

/** The four risk-term inputs, each in [0, 1] (clamped for totality). */
export interface PenaltyInputs {
  coordination: number;
  holonomy: number;
  tension: number;
  redundancy: number;
}

/** v1 placeholder inputs: PHI and Hodge are zero until WS-H lands. */
export const V1_PLACEHOLDER_PENALTY_INPUTS: Readonly<Pick<PenaltyInputs, 'holonomy' | 'tension'>> =
  {
    holonomy: 0,
    tension: 0,
  };

export const DEFAULT_PENALTY_COEFFICIENTS: PenaltyCoefficients = {
  pM: 1,
  pH: 1,
  pT: 1,
  pR: 0.5,
};

/** Validate coefficients: finite and nonnegative (a penalty is never a reward). */
export function validatePenaltyCoefficients(coefficients: PenaltyCoefficients): void {
  for (const [name, value] of Object.entries(coefficients)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`penalty coefficient ${name} must be finite and >= 0 (got ${value})`);
    }
  }
}

export interface PenaltyApplication {
  name: 'coordination' | 'holonomy' | 'tension' | 'redundancy';
  coefficient: number;
  input: number;
  /** The (nonnegative) amount subtracted from the positive score. */
  delta: number;
}

export interface PenaltyResult {
  /** positiveScore − Σ coefficient·input. MAY be below zero (by design). */
  total: number;
  /** Per-term application log (WS-E.2.3d acceptance: penalty logging). */
  applied: PenaltyApplication[];
}

/** Subtract the four penalty terms from a positive score. Pure and total. */
export function applyPenalties(
  positiveScore: number,
  coefficients: PenaltyCoefficients,
  inputs: PenaltyInputs,
): PenaltyResult {
  validatePenaltyCoefficients(coefficients);
  const terms: ReadonlyArray<Omit<PenaltyApplication, 'delta'>> = [
    { name: 'coordination', coefficient: coefficients.pM, input: clamp01(inputs.coordination) },
    { name: 'holonomy', coefficient: coefficients.pH, input: clamp01(inputs.holonomy) },
    { name: 'tension', coefficient: coefficients.pT, input: clamp01(inputs.tension) },
    { name: 'redundancy', coefficient: coefficients.pR, input: clamp01(inputs.redundancy) },
  ];
  const applied: PenaltyApplication[] = terms.map((term) => ({
    ...term,
    delta: term.coefficient * term.input,
  }));
  const totalPenalty = applied.reduce((sum, term) => sum + term.delta, 0);
  const base = Number.isFinite(positiveScore) ? positiveScore : 0;
  return { total: base - totalPenalty, applied };
}
