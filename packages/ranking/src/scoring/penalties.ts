// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3b — the four penalty terms (SPEC §5.4/§5.5). Each is a separate
// NONNEGATIVE subtractive component derived from its invariant signal; they
// are NOT part of the convex weight combination, so high risk can drive a
// total below any positive contribution.
//
//   pM CoordinationPenalty  MFCI risk state (normal 0 → severe 1) joined with
//                           tropical-cascade synchrony (max, never sum — the
//                           same coordination evidence must not double-count)
//   pH HolonomyRisk         PHI holonomy magnitude against the profile
//                           threshold; SENSITIVE topics use a stricter
//                           (smaller) threshold ⇒ larger normalized risk
//   pT HarmfulTensionRisk   Hodge `harmful_tension_risk`, which is ZERO by
//                           construction absent a hostility/safety signal
//                           (WS-H.7.1: HarmfulTensionRisk ≡ 0 without
//                           hostility) — legitimate sustained disagreement is
//                           never penalized. Belt-and-braces: when the raw
//                           harmonic tension is present WITHOUT the risk
//                           field, the penalty is 0, never inferred.
//   pR RedundancyPenalty    MERI redundancy (1 = pure duplicate lineage);
//                           repeated copies accumulate penalty instead of
//                           distribution power.
//
// ENFORCEMENT (WS-H.1.2e): a penalty only subtracts when its governing
// invariant has been promoted out of shadow. Unpromoted penalties are still
// computed and recorded (`applied: 0, enforced: false`) so decision logs show
// exactly what WOULD have applied — observable, never silently sanctioning.

import type { FeatureVector } from '../schemas/feature-vector.js';
import type { RankingProfileConfig } from '../schemas/profile.js';
import type { PenaltyComponents, PenaltyTerm } from '../schemas/scored-item.js';

/** Which invariants' ranking effects are promotion-enabled (WS-H.1.2e). */
export interface PenaltyEnforcement {
  mfci: boolean;
  phi: boolean;
  hodge: boolean;
  meri: boolean;
  tropical: boolean;
}

/** Everything still shadow — the fail-closed default. */
export const SHADOW_ENFORCEMENT: PenaltyEnforcement = {
  mfci: false,
  phi: false,
  hodge: false,
  meri: false,
  tropical: false,
};

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** MFCI risk-state → coordination-penalty input (SPEC §8.5 ladder). */
export const MFCI_RISK_PENALTY: Readonly<Record<string, number>> = {
  normal: 0,
  elevated: 0.25,
  high: 0.5,
  severe: 1,
};

/**
 * Coordination input: max of the MFCI risk-state value and the tropical
 * synchronized fraction (both evidence the same phenomenon; max not sum).
 */
export function coordinationInput(
  features: Pick<FeatureVector, 'mfci_risk_state' | 'tropical_cascade_rank'>,
  enforcement: Pick<PenaltyEnforcement, 'mfci' | 'tropical'>,
): { value: number; enforced: boolean } {
  const mfci = features.mfci_risk_state ? (MFCI_RISK_PENALTY[features.mfci_risk_state] ?? 0) : 0;
  // tropical_cascade_rank is the synchronized fraction ∈ [0, 1] when present.
  const tropical = clamp01(features.tropical_cascade_rank ?? 0);
  const value = Math.max(mfci, tropical);
  // Enforced when the SOURCE of the dominating evidence is promoted.
  const enforced =
    value === 0
      ? enforcement.mfci || enforcement.tropical
      : (mfci >= tropical && enforcement.mfci) || (tropical > mfci && enforcement.tropical);
  return { value, enforced };
}

/**
 * Holonomy input: PHI magnitude normalized by the profile threshold; the
 * threshold SHRINKS by `phi_sensitive_factor` for sensitive topics (stricter
 * ⇒ the same loop scores higher risk). Clamped to [0, 1].
 */
export function holonomyInput(
  phiRisk: number | undefined,
  profile: Pick<RankingProfileConfig, 'constraints'>,
  sensitiveTopic: boolean,
): number {
  if (phiRisk === undefined) return 0;
  const base = profile.constraints.phi_diversify_threshold;
  const threshold = sensitiveTopic ? base * profile.constraints.phi_sensitive_factor : base;
  if (threshold <= 0) return 1;
  return clamp01(phiRisk / threshold);
}

/**
 * Harmful-tension input: the Hodge `harmful_tension_risk` field ONLY. That
 * field is 0 by construction absent a hostility signal, so raw harmonic
 * tension alone (sustained legitimate disagreement) can never penalize.
 */
export function harmfulTensionInput(features: Pick<FeatureVector, 'harmful_tension_risk'>): number {
  return clamp01(features.harmful_tension_risk ?? 0);
}

/** Redundancy input: the MERI-derived redundancy penalty ∈ [0, 1]. */
export function redundancyInput(features: Pick<FeatureVector, 'redundancy_penalty'>): number {
  return clamp01(features.redundancy_penalty ?? 0);
}

function term(value: number, coefficient: number, enforced: boolean): PenaltyTerm {
  const applied = enforced ? coefficient * value : 0;
  return { value, coefficient, applied, enforced };
}

/** The topic-sensitivity context the penalty stage needs. */
export interface PenaltyContext {
  sensitiveTopic: boolean;
}

/**
 * Compute all four penalty terms with their enforcement provenance. Pure and
 * deterministic; total over malformed inputs (clamped).
 */
export function computePenalties(
  features: FeatureVector,
  profile: RankingProfileConfig,
  enforcement: PenaltyEnforcement,
  context: PenaltyContext,
): PenaltyComponents {
  const coordination = coordinationInput(features, enforcement);
  const coordinationTerm = term(coordination.value, profile.penalties.pM, coordination.enforced);
  const holonomyTerm = term(
    holonomyInput(features.phi_risk, profile, context.sensitiveTopic),
    profile.penalties.pH,
    enforcement.phi,
  );
  const tensionTerm = term(harmfulTensionInput(features), profile.penalties.pT, enforcement.hodge);
  const redundancyTerm = term(redundancyInput(features), profile.penalties.pR, enforcement.meri);
  return {
    coordination: coordinationTerm,
    holonomy: holonomyTerm,
    harmful_tension: tensionTerm,
    redundancy: redundancyTerm,
    total_applied:
      coordinationTerm.applied +
      holonomyTerm.applied +
      tensionTerm.applied +
      redundancyTerm.applied,
  };
}
