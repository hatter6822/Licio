// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3b — the three per-item penalty terms (SPEC §5.4/§5.5). Each is a
// separate NONNEGATIVE subtractive component derived from its invariant signal;
// they are NOT part of the convex weight combination, so high risk can drive a
// total below any positive contribution.
//
// PHI is deliberately ABSENT here: holonomy is a per-USER/session signal (the
// curvature of the reader's own topic journey), not a per-item property, so
// PHI enters ranking as the per-user diversification constraint
// (`phiDiversification` in constraints.ts — SPEC §13 `holonomy_limits`), never
// a per-item penalty. The old per-item `pH·HolonomyRisk` term read a `phi_risk`
// feature the assembler never populated, so it was structurally always 0; it
// was removed (option-2 consolidation). A genuine per-item holonomy signal is a
// PHI-v1 residual (docs/ranking/README.md).
//
//   pM CoordinationPenalty  MFCI risk state (normal 0 → severe 1) joined with
//                           tropical-cascade synchrony (max, never sum — the
//                           same coordination evidence must not double-count)
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

/** Which invariants' PENALTY effects are promotion-enabled (WS-H.1.2e). PHI is
 *  not here — it is a per-user CONSTRAINT (diversification), not a penalty. */
export interface PenaltyEnforcement {
  mfci: boolean;
  hodge: boolean;
  meri: boolean;
  tropical: boolean;
}

/** Everything still shadow — the fail-closed default. */
export const SHADOW_ENFORCEMENT: PenaltyEnforcement = {
  mfci: false,
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
  // Enforced when the SOURCE of the dominating evidence is promoted. Both
  // comparisons are inclusive so an EXACT tie enforces if EITHER tied source
  // is promoted (the tied evidence equally justifies the penalty value).
  const enforced =
    value === 0
      ? enforcement.mfci || enforcement.tropical
      : (mfci >= tropical && enforcement.mfci) || (tropical >= mfci && enforcement.tropical);
  return { value, enforced };
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

/** WS-T dispute input: 1 when the story was adjudicated `incorrect` by a sourced-
 *  correction debate, else 0 — a content-quality signal (uniform, non-financial). */
export function disputeInput(features: Pick<FeatureVector, 'dispute_penalty'>): number {
  return clamp01(features.dispute_penalty ?? 0);
}

/** WS-T validation input: 1 when a sourced-correction debate UPHELD the story
 *  (`validated` — challenged and proven accurate), else 0. */
export function disputeValidationInput(
  features: Pick<FeatureVector, 'dispute_validation'>,
): number {
  return clamp01(features.dispute_validation ?? 0);
}

/**
 * WS-T — the validation BOOST: a modest additive nudge for a `validated` story
 * (challenged by a sourced correction and PROVEN accurate). Applied OUTSIDE the
 * SCOI distribution multiplier — symmetric with `disputeOrderingSink` — so a
 * validated story keeps the lift even when its interpretations diverge. Unlike
 * the sink it is DELIBERATELY bounded (`vD`, default 0.25) and does NOT dominate
 * the score span: it nudges accurate content up without guaranteeing the top (so
 * it cannot be gamed into a hard promotion). Uniform across authors/topics and
 * content-derived — neutrality-safe, never applause or payment.
 */
export function disputeValidationBoost(
  features: Pick<FeatureVector, 'dispute_validation'>,
  profile: RankingProfileConfig,
): number {
  return (profile.penalties.vD ?? 0.25) * disputeValidationInput(features);
}

function term(value: number, coefficient: number, enforced: boolean): PenaltyTerm {
  const applied = enforced ? coefficient * value : 0;
  return { value, coefficient, applied, enforced };
}

/**
 * WS-T — the dispute demotion is realized as an ORDERING-LEVEL SINK (the exact
 * analogue of the comment-section sink), not merely a within-convex penalty
 * term.  A convex/penalty term is subtracted INSIDE the distribution multiplier
 * and its magnitude is bounded by the positive score (≤ 2, SPEC §5.4); a story
 * with strong baseline/participation could therefore still outscore a clean
 * low-signal story even after `pD` subtracts.  This constant is subtracted
 * OUTSIDE the multiplier and exceeds the entire achievable non-sink score range
 * (positive ∈ [0, 2] minus the profile's bounded penalty coefficients) by a wide
 * margin, so a `corrected` story sorts strictly BELOW every non-disputed story —
 * deterministically and independent of the SCOI distribution multiplier.  It is
 * a content-quality ordering signal (uniform across authors/topics, never
 * financial — neutrality-safe), never a hidden/removed state. */
export function disputeOrderingSink(
  features: Pick<FeatureVector, 'dispute_penalty'>,
  profile: RankingProfileConfig,
): number {
  if (disputeInput(features) <= 0) return 0;
  const { pM, pT, pR, pD } = profile.penalties;
  // Max positive is 2 (baseline ≤ 1 + convex ≤ 1); the penalty coefficients bound
  // the most-negative non-sink score.  Exceed the full span (+1 margin) so the
  // sink strictly dominates any profile configuration, not just the defaults.
  return 2 + pM + pT + pR + (pD ?? 1) + 1;
}

/** The topic-sensitivity context the penalty stage needs. */
export interface PenaltyContext {
  sensitiveTopic: boolean;
}

/**
 * Compute the three per-item penalty terms with their enforcement provenance.
 * Pure and deterministic; total over malformed inputs (clamped). The `context`
 * (topic sensitivity) is retained for signature stability with the pipeline and
 * future per-item penalties, though the current terms do not consult it.
 */
export function computePenalties(
  features: FeatureVector,
  profile: RankingProfileConfig,
  enforcement: PenaltyEnforcement,
  _context: PenaltyContext,
): PenaltyComponents {
  const coordination = coordinationInput(features, enforcement);
  const coordinationTerm = term(coordination.value, profile.penalties.pM, coordination.enforced);
  const tensionTerm = term(harmfulTensionInput(features), profile.penalties.pT, enforcement.hodge);
  const redundancyTerm = term(redundancyInput(features), profile.penalties.pR, enforcement.meri);
  // WS-T — the dispute penalty is ALWAYS enforced: a resolved sourced-correction
  // debate is authoritative (no shadow invariant gates it).  It is RECORDED here
  // as a first-class term for decision-log transparency; the guaranteed bottom-out
  // is applied by the pipeline as `disputeOrderingSink` (a multiplier-immune
  // ordering sink), so a `corrected` story cannot be rescued by strong signal.
  const disputeTerm = term(disputeInput(features), profile.penalties.pD ?? 1, true);
  return {
    coordination: coordinationTerm,
    harmful_tension: tensionTerm,
    redundancy: redundancyTerm,
    dispute: disputeTerm,
    total_applied:
      coordinationTerm.applied + tensionTerm.applied + redundancyTerm.applied + disputeTerm.applied,
  };
}
