// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3d — the time-sensitive baseline B_i,t (SPEC §5.4/§5.5). Three parts,
// combined as a convex combination so B stays on the SAME [0, 1] scale as the
// normalized positive PWAtt score:
//
//   freshness_decay   exponential half-life decay, curve per content type
//                     (breaking news decays faster than evergreen analysis)
//   source_reliability  Licio-INTERNAL source history only (corrections,
//                     community notes) — never follower counts,
//                     popularity, or any external social metric (SPEC §14.3)
//   topic_relevance   match between item topics and the requesting user's own
//                     configured interests; DISABLED (renormalized away) when
//                     personalization is off or the user is signed out
//
// A brand-new item with no participation still gets a nonzero baseline
// through freshness — cold-start discoverability (WS-I.2.3d acceptance).

import type { BaselineBreakdown } from '../schemas/scored-item.js';

/** Fixed convex weights of the three baseline parts (sum to 1). */
export const BASELINE_WEIGHTS = {
  freshness: 50,
  reliability: 30,
  relevance: 20,
} as const;

/** Neutral reliability for a source with no history yet (neither boosted nor
 *  penalized — absence of history is not evidence of unreliability). */
export const NEUTRAL_SOURCE_RELIABILITY = 0.5;

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** Exponential half-life freshness: 2^(−ageHours / halfLifeHours) ∈ (0, 1]. */
export function freshnessFromAge(ageMs: number, halfLifeHours: number): number {
  if (!Number.isFinite(ageMs) || ageMs < 0 || !Number.isFinite(halfLifeHours)) return 0;
  if (halfLifeHours <= 0) return 0;
  const ageHours = ageMs / 3_600_000;
  return clamp01(2 ** (-ageHours / halfLifeHours));
}

/**
 * Topic relevance: |item topics ∩ user interests| / |item topics|, i.e. the
 * fraction of the item's topics the user has expressed interest in. Empty
 * topic list or empty interests ⇒ 0 (no claimed relevance). Derived ONLY from
 * the user's own configured topic preferences — never from wallet activity or
 * payment history (those fields do not exist on the inputs).
 */
export function topicRelevance(
  itemTopicIds: readonly string[],
  userTopicPreferences: readonly string[],
): number {
  if (itemTopicIds.length === 0 || userTopicPreferences.length === 0) return 0;
  const interests = new Set(userTopicPreferences);
  let matched = 0;
  for (const topic of itemTopicIds) {
    if (interests.has(topic)) matched += 1;
  }
  return clamp01(matched / itemTopicIds.length);
}

export interface BaselineInputs {
  /** Freshness decay in [0, 1] (precomputed via {@link freshnessFromAge} or
   *  the WS-F freshness baseline). Absent ⇒ 0 (unknown age earns nothing). */
  freshnessDecay: number | undefined;
  /** Source reliability in [0, 1]; absent ⇒ neutral 0.5. */
  sourceReliability: number | undefined;
  /** Topic relevance in [0, 1]; only consulted when personalization is on. */
  topicRelevance: number | undefined;
  /** False ⇒ relevance is EXCLUDED and its weight renormalized away — a
   *  personalization-off user's feed applies no personal topic match. */
  personalizationEnabled: boolean;
  /** Integer-percent part weights summing to 100 (profile-configured,
   *  WS-I.2.3f `baseline_weights`); defaults to {@link BASELINE_WEIGHTS}. */
  weights?: { freshness: number; reliability: number; relevance: number };
}

/**
 * Combine the parts as a convex combination of the profile's integer-percent
 * baseline weights. With personalization off the relevance term is removed
 * and the remaining weights renormalized (so disabling personalization never
 * deflates every score — it redistributes weight to freshness/reliability).
 */
export function computeBaseline(inputs: BaselineInputs): BaselineBreakdown {
  const weights = inputs.weights ?? BASELINE_WEIGHTS;
  const freshness = clamp01(inputs.freshnessDecay ?? 0);
  const reliability = clamp01(inputs.sourceReliability ?? NEUTRAL_SOURCE_RELIABILITY);
  const usePersonalization = inputs.personalizationEnabled && inputs.topicRelevance !== undefined;
  const relevance = usePersonalization ? clamp01(inputs.topicRelevance ?? 0) : null;
  let value: number;
  if (relevance === null) {
    const denom = weights.freshness + weights.reliability;
    value =
      denom <= 0 ? 0 : (weights.freshness * freshness + weights.reliability * reliability) / denom;
  } else {
    value =
      (weights.freshness * freshness +
        weights.reliability * reliability +
        weights.relevance * relevance) /
      100;
  }
  return {
    freshness_decay: freshness,
    source_reliability: reliability,
    topic_relevance: relevance,
    value: clamp01(value),
  };
}

/**
 * Source reliability from Licio-internal history (SPEC §14.3 source model —
 * context and history, never a truth score and never external popularity).
 * Inputs are exactly the aggregates the WS-F source profile actually carries:
 *
 *   - corrections: `correction_history.length` — a high correction FREQUENCY
 *     dampens gently (the §14.3 record has no acknowledgment field; frequency
 *     is the real signal available, and corrections are partly a transparency
 *     virtue, so the dampening is deliberately mild);
 *   - communityNotes: `community_notes.length` — heavily-noted sources are
 *     slightly dampened (notes flag missing context, not falsity).
 *
 * (The former evidence-type-diversity and summary-citation bonuses were
 * removed as never-fed inputs: no production path populated either.)
 *
 * All inputs are COUNTS from Licio-internal data; none is a popularity or
 * financial metric. Output ∈ [0, 1]; a source with no history ⇒ neutral 0.5.
 *
 *   reliability = clamp01(0.5 · corrDamp · noteDamp)
 *     corrDamp = 1/(1 + corrections/10), noteDamp = 1/(1 + notes/8)
 */
export function sourceReliabilityFromHistory(history: {
  corrections: number;
  communityNotes: number;
}): number {
  const corrections = Math.max(0, history.corrections);
  const communityNotes = Math.max(0, history.communityNotes);
  if (corrections === 0 && communityNotes === 0) {
    return NEUTRAL_SOURCE_RELIABILITY;
  }
  const correctionDampening = 1 / (1 + corrections / 10);
  const noteDampening = 1 / (1 + communityNotes / 8);
  return clamp01(0.5 * correctionDampening * noteDampening);
}
