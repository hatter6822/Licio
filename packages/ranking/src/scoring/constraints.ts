// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3c — hard risk-constraint enforcement (SPEC §13.1, §13.4). The
// optimizer operates ONLY inside the feasible set this stage produces; no
// objective value can trade against a violated constraint. Per WS-H.1.2e,
// each invariant-derived constraint ENFORCES only when its invariant has been
// promoted out of shadow; until then the violation is computed and logged
// (`enforced: false`) but does not restrict — observable, never a hidden
// sanction. The safety-policy constraint (WS-I.2.2a) is NOT promotion-gated:
// safety-filtered items are excluded upstream unconditionally, and this stage
// re-asserts none slipped through (feasibility invariant).
//
// GWEI is a DEPLOYMENT gate, not a per-item filter: cohort disparity above
// the profile threshold blocks the ranking profile from serving (WS-P
// release-gate seam) — evaluated by `gweiDeploymentGate` against the latest
// GWEI outputs.

import type { RankingSurface } from '../schemas/candidate.js';
import type { ConstraintApplication } from '../schemas/decision-log.js';
import type { FeatureVector } from '../schemas/feature-vector.js';
import type { RankingProfileConfig } from '../schemas/profile.js';
import type { ConstraintFlag } from '../schemas/scored-item.js';

/** Which invariants' constraint effects are promotion-enabled (WS-H.1.2e). */
export interface ConstraintEnforcement {
  mfci: boolean;
  phi: boolean;
  gwei: boolean;
  meri: boolean;
}

export const SHADOW_CONSTRAINT_ENFORCEMENT: ConstraintEnforcement = {
  mfci: false,
  phi: false,
  gwei: false,
  meri: false,
};

const MFCI_ORDER: Readonly<Record<string, number>> = {
  normal: 0,
  elevated: 1,
  high: 2,
  severe: 3,
};

export interface ConstraintEvaluation {
  /** True ⇒ the item stays in the feasible set for this surface. */
  feasible: boolean;
  flags: ConstraintFlag[];
  applications: ConstraintApplication[];
}

export interface ConstraintContext {
  surface: RankingSurface;
  /** True when the item's home room differs from the requesting surface's
   *  room (or the surface is cross-community, i.e. front page / topic). */
  crossCommunity: boolean;
}

/**
 * Evaluate the per-item hard constraints (MFCI severe exclusion). MERI
 * cluster caps and source/topic balancing are per-FEED constraints applied
 * by the diversification stage; PHI is per-USER and evaluated by
 * `phiDiversification`.
 */
export function evaluateItemConstraints(
  features: FeatureVector,
  profile: RankingProfileConfig,
  enforcement: ConstraintEnforcement,
  context: ConstraintContext,
): ConstraintEvaluation {
  const flags: ConstraintFlag[] = [];
  const applications: ConstraintApplication[] = [];
  let feasible = true;

  // --- MFCI: at/above the profile's exclusion state, the item leaves
  // cross-community distribution and is flagged for immediate review.
  const risk = features.mfci_risk_state;
  if (risk !== undefined) {
    const at = MFCI_ORDER[risk] ?? 0;
    const threshold = MFCI_ORDER[profile.constraints.mfci_exclude_at] ?? 3;
    if (at >= threshold) {
      const excludes = context.crossCommunity;
      applications.push({
        constraint: 'mfci_severe_cross_community',
        item_id: features.item_id,
        threshold: profile.constraints.mfci_exclude_at,
        actual: risk,
        action: excludes ? 'excluded' : 'demoted',
        enforced: enforcement.mfci,
      });
      flags.push('mfci_review_flagged');
      if (excludes && enforcement.mfci) {
        feasible = false;
        flags.push('mfci_cross_community_excluded');
      }
    }
  }

  return { feasible, flags, applications };
}

/**
 * PHI per-user constraint (WS-I.2.3c): a requesting user whose recommendation
 * sequence holonomy exceeds the threshold gets feed diversification — the
 * diversification stage tightens topic balancing for this request.
 */
export function phiDiversification(
  userPhiRisk: number | null,
  profile: RankingProfileConfig,
  enforcement: Pick<ConstraintEnforcement, 'phi'>,
): { diversify: boolean; application: ConstraintApplication | null } {
  if (userPhiRisk === null || userPhiRisk < profile.constraints.phi_diversify_threshold) {
    return { diversify: false, application: null };
  }
  return {
    diversify: enforcement.phi,
    application: {
      constraint: 'phi_holonomy_diversification',
      item_id: null,
      threshold: profile.constraints.phi_diversify_threshold,
      actual: userPhiRisk,
      action: 'diversified',
      enforced: enforcement.phi,
    },
  };
}

/**
 * GWEI deployment gate (WS-I.2.3c / SPEC §13.1): a ranking profile whose
 * latest GWEI cohort disparity exceeds the profile threshold may not deploy.
 * Returns the blocking application when the gate trips. The gate itself
 * always REPORTS; whether serving is actually blocked follows the GWEI
 * promotion state (an unpromoted GWEI logs the would-be block).
 */
export function gweiDeploymentGate(
  latestDisparity: number | null,
  profile: RankingProfileConfig,
  enforcement: Pick<ConstraintEnforcement, 'gwei'>,
): { blocked: boolean; application: ConstraintApplication | null } {
  if (latestDisparity === null || latestDisparity <= profile.constraints.gwei_max_disparity) {
    return { blocked: false, application: null };
  }
  return {
    blocked: enforcement.gwei,
    application: {
      constraint: 'gwei_deployment_gate',
      item_id: null,
      threshold: profile.constraints.gwei_max_disparity,
      actual: latestDisparity,
      action: 'excluded',
      enforced: enforcement.gwei,
    },
  };
}
