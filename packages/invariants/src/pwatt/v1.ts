// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PWAtt v1 composition (WS-E.2.3, SPEC §5.4/§5.5): the full formula
//
//   PWAtt = B + (wA·A + wP·P + wE·E + wS·S + wC·C)/100 − Σ p·risk
//
// with B and every component on the [0, 1] scale, the convex positive
// combination validated by the profile guardrails (WS-E.2.3c), the
// contribution-type hierarchy applied inside P (WS-E.2.3b), and penalties
// subtracted separately (WS-E.2.3d — the total MAY go below zero).
//
// v1 component sourcing: A and P come from the WS-E aggregation + saturation
// pipeline; E (MERI), S (evidence completeness), and C (context coherence)
// are provider inputs defaulting to 0. C has NO production provider — the
// SCOI→ranking coupling was removed — so it stays an honest 0 unless a
// future provider lands; the §5.4 formula shape (five weights summing to
// 100) is unchanged.
//
// NOTE: this composite is NOT the production served score. The batch PWAtt
// engine (apps/api/src/pwatt/scoring.ts) stores only the CONTENT components
// (A, P); the full §5.4 composite — baseline B, the E/S/C terms, and the
// promotion-gated penalties — is a per-REQUEST quantity (B carries the
// requesting user's freshness/relevance) composed at decision time by the
// SINGLE production §5.4 implementation, @licio/ranking (`computePositiveScore`
// + `computePenalties`). `computePwattV1` here is the reference/self-contained
// composer used by the property tests and any caller that already holds a
// baseline; production never persists its output, so there is exactly one
// served §5.4 path and no partial duplicate to drift.
import type { EventContributionType } from '@licio/shared';
import {
  applyPenalties,
  type PenaltyCoefficients,
  type PenaltyInputs,
  type PenaltyResult,
} from './penalties.js';
import { assertValidRankingProfile, type RankingProfile } from './profiles.js';
import { clamp01 } from './types.js';

/**
 * The v1 contribution-type weighting hierarchy (WS-E.2.3b, SPEC §5.3/§15.1):
 *   correction > explanation > low_info_reply (zero).
 * `explanation` is the comment-grade constructive weight (the live `comment`
 * type maps here; sourced comments earn the citation bonus on top).
 * `bridge_comment` earns strong positive weight (a constant; the measured
 * SCOI-decrease condition lives in the WS-H.4.2d bridge-credit consumer, not
 * here). `steward_action` counts for thread health.
 */
export const V1_CONTRIBUTION_WEIGHTS: Readonly<Record<EventContributionType, number>> = {
  correction: 0.9,
  bridge_comment: 0.85,
  explanation: 0.5,
  steward_action: 0.5,
  low_info_reply: 0,
};

/** Validate the hierarchy ordering (correction highest … low_info_reply zero;
 *  sourced comments earn the citation bonus on top of their type weight). */
export function assertV1HierarchyOrder(
  weights: Readonly<Record<EventContributionType, number>> = V1_CONTRIBUTION_WEIGHTS,
): void {
  const order: EventContributionType[] = ['correction', 'explanation'];
  for (let i = 1; i < order.length; i += 1) {
    const higher = order[i - 1];
    const lower = order[i];
    if (higher === undefined || lower === undefined) continue;
    if (!(weights[higher] > weights[lower])) {
      throw new Error(`hierarchy violated: ${higher} must outweigh ${lower}`);
    }
  }
  if (weights.low_info_reply !== 0) {
    throw new Error('low_info_reply must carry zero constructive weight');
  }
}

/** The five positive component values, each expected in [0, 1] (clamped). */
export interface PwattV1Components {
  activeAttention: number;
  participation: number;
  /** Exposure independence (MERI provider; 0 until WS-H.2). */
  exposureIndependence: number;
  /** Evidence/source completeness (WS-F provider; 0 until it lands). */
  evidenceCompleteness: number;
  /** Context coherence gain (no production provider; honest 0). */
  contextCoherence: number;
}

export interface PwattV1Input {
  /** Time-sensitive baseline B on the [0, 1] scale (freshness etc.). */
  baseline: number;
  components: PwattV1Components;
  profile: RankingProfile;
  penaltyCoefficients: PenaltyCoefficients;
  penaltyInputs: PenaltyInputs;
}

export interface PwattV1Result {
  /** B + the convex positive combination, in [0, 2] before penalties. */
  positive: number;
  /** positive − penalties; MAY be below zero (high-risk denial). */
  total: number;
  /** The penalty application log (audit + "Under Review" surfaces). */
  penalties: PenaltyResult;
  /** The validated profile that was applied. */
  profileName: string;
}

/** Compute the full v1 formula. Pure and total; throws on invalid profile. */
export function computePwattV1(input: PwattV1Input): PwattV1Result {
  assertValidRankingProfile(input.profile);
  const { wA, wP, wE, wS, wC } = input.profile.weights;
  const c = input.components;
  const positiveCombination =
    (wA * clamp01(c.activeAttention) +
      wP * clamp01(c.participation) +
      wE * clamp01(c.exposureIndependence) +
      wS * clamp01(c.evidenceCompleteness) +
      wC * clamp01(c.contextCoherence)) /
    100;
  const positive = clamp01(input.baseline) + positiveCombination;
  const penalties = applyPenalties(positive, input.penaltyCoefficients, input.penaltyInputs);
  return {
    positive,
    total: penalties.total,
    penalties,
    profileName: input.profile.name,
  };
}
