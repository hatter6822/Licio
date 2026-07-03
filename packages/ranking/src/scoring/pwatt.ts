// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3a — the PWAtt composite (SPEC §5.4):
//
//   PWAtt = B + (wA·A + wP·P + wE·E + wS·S + wC·C) / 100
//             − pM·CoordinationPenalty − pT·HarmfulTensionRisk
//             − pR·RedundancyPenalty
//
// (The §5.4 `pH·HolonomyRisk` per-item penalty is not applied: holonomy is a
// per-user signal, so PHI enters ranking as the per-user diversification
// constraint (§13 `holonomy_limits`), not a per-item term.)
//
// The five positive weights are the profile's §5.5-validated integer percents
// (they sum to exactly 100 — enforced by the loader through the SAME
// validator WS-E uses). An ABSENT component (degraded or never computed)
// contributes 0 — its feature is omitted, never fabricated (WS-H.1.2c).
// Penalties are handled in penalties.ts and subtracted by the caller; this
// module computes B + the convex positive combination.
//
// Numerical form: with every component in [0, 1] and weights summing to 100,
// the convex combination is in [0, 1]; with B ∈ [0, 1] the positive total is
// in [0, 2]. Integer weights over a /100 division keep the arithmetic exact
// in double precision for the weight side (no accumulated drift across items).

import type { FeatureVector } from '../schemas/feature-vector.js';
import type { RankingProfileConfig } from '../schemas/profile.js';
import type { BaselineBreakdown, ScoreComponents } from '../schemas/scored-item.js';

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** Resolve one optional component: absent ⇒ null (0 contribution, honest). */
function component(value: number | undefined): number | null {
  return value === undefined ? null : clamp01(value);
}

export interface PositiveScore {
  components: ScoreComponents;
}

/**
 * Compute B + the §5.5 convex combination over the feature vector's PWAtt
 * components. Pure and total: any non-finite input clamps to 0.
 */
export function computePositiveScore(
  features: Pick<
    FeatureVector,
    | 'active_attention'
    | 'constructive_participation'
    | 'exposure_independence'
    | 'source_evidence_completeness'
    | 'context_coherence_gain'
  >,
  profile: RankingProfileConfig,
  baseline: BaselineBreakdown,
): PositiveScore {
  const a = component(features.active_attention);
  const p = component(features.constructive_participation);
  const e = component(features.exposure_independence);
  const s = component(features.source_evidence_completeness);
  const c = component(features.context_coherence_gain);
  const { wA, wP, wE, wS, wC } = profile.weights;
  const weighted =
    (wA * (a ?? 0) + wP * (p ?? 0) + wE * (e ?? 0) + wS * (s ?? 0) + wC * (c ?? 0)) / 100;
  return {
    components: {
      active_attention: a,
      constructive_participation: p,
      exposure_independence: e,
      source_evidence_completeness: s,
      context_coherence_gain: c,
      weights: { wA, wP, wE, wS, wC },
      positive: baseline.value + weighted,
    },
  };
}
