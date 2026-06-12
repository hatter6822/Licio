// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GWEI — the seven §9.4 experience metrics and k-anonymity suppression
// (WS-H.5.1b/WS-H.5.1b-2).
//
// Every metric is computed from AGGREGATE cohort exposure records — item
// features plus an exposure weight — never an individual user history.
// Diversity metrics use the exposure-weighted Shannon entropy reported as
// the EFFECTIVE NUMBER exp(H) (1 = a single source dominates; k = k equally
// weighted sources), which compares cleanly across cohorts of different
// sizes. Suppression below the k-anonymity threshold is recorded with the
// SUPPRESSED_K_ANONYMITY reason code so a withheld value is never read as a
// true zero (WS-H.5.1b-2 acceptance).

export interface CohortExposureItem {
  itemId: string;
  sourceKey: string;
  topicIds: readonly string[];
  /** Primary source / evidence card reachable from the item. */
  hasPrimaryEvidence: boolean;
  /** Discussion depth bucket midpoint (0 = none). */
  discussionDepth: number;
  /** Lens/claim relational keys present on the item. */
  lensKeys: readonly string[];
  /** True when the topic is familiar to the cohort (repeat exposure). */
  familiarTopic: boolean;
  /** Elevated safety posture (harassment/misinfo/graphic signals). */
  safetyElevated: boolean;
  /** Nonnegative exposure weight (impression/attention share). */
  weight: number;
}

export interface ExperienceMetrics {
  sourceDiversity: number;
  topicDiversity: number;
  evidenceAccess: number;
  discussionDepth: number;
  viewpointGeometry: number;
  novelty: number;
  safetyState: number;
}

export const EXPERIENCE_METRIC_KEYS = [
  'sourceDiversity',
  'topicDiversity',
  'evidenceAccess',
  'discussionDepth',
  'viewpointGeometry',
  'novelty',
  'safetyState',
] as const satisfies readonly (keyof ExperienceMetrics)[];

/** Effective number exp(H) of a weighted key distribution. */
function effectiveNumber(weightsByKey: Map<string, number>): number {
  let total = 0;
  for (const w of weightsByKey.values()) total += w;
  if (total <= 0) return 0;
  let entropy = 0;
  for (const w of weightsByKey.values()) {
    if (w <= 0) continue;
    const p = w / total;
    entropy -= p * Math.log(p);
  }
  return Math.exp(entropy);
}

/** All seven §9.4 metrics over a cohort exposure sample. */
export function experienceMetrics(items: readonly CohortExposureItem[]): ExperienceMetrics {
  const supported = items.filter((i) => Number.isFinite(i.weight) && i.weight > 0);
  if (supported.length === 0) {
    return {
      sourceDiversity: 0,
      topicDiversity: 0,
      evidenceAccess: 0,
      discussionDepth: 0,
      viewpointGeometry: 0,
      novelty: 0,
      safetyState: 0,
    };
  }
  const totalWeight = supported.reduce((acc, i) => acc + i.weight, 0);

  const sourceWeights = new Map<string, number>();
  const topicWeights = new Map<string, number>();
  const lensWeights = new Map<string, number>();
  let evidenceWeight = 0;
  let depthSum = 0;
  let unfamiliarWeight = 0;
  let safetyWeight = 0;

  for (const item of supported) {
    sourceWeights.set(item.sourceKey, (sourceWeights.get(item.sourceKey) ?? 0) + item.weight);
    // An item's weight splits evenly across its topics/lenses so multi-topic
    // items do not double-count exposure mass.
    if (item.topicIds.length > 0) {
      const per = item.weight / item.topicIds.length;
      for (const topic of item.topicIds) {
        topicWeights.set(topic, (topicWeights.get(topic) ?? 0) + per);
      }
    }
    if (item.lensKeys.length > 0) {
      const per = item.weight / item.lensKeys.length;
      for (const lens of item.lensKeys) {
        lensWeights.set(lens, (lensWeights.get(lens) ?? 0) + per);
      }
    }
    if (item.hasPrimaryEvidence) evidenceWeight += item.weight;
    depthSum += item.discussionDepth * item.weight;
    if (!item.familiarTopic) unfamiliarWeight += item.weight;
    if (item.safetyElevated) safetyWeight += item.weight;
  }

  const unfamiliarShare = unfamiliarWeight / totalWeight;
  return {
    sourceDiversity: effectiveNumber(sourceWeights),
    topicDiversity: effectiveNumber(topicWeights),
    evidenceAccess: evidenceWeight / totalWeight,
    discussionDepth: depthSum / totalWeight,
    viewpointGeometry: effectiveNumber(lensWeights),
    // Balance of familiar and unfamiliar-but-relevant material (§9.4):
    // 1 at a 50/50 mix, 0 when all-familiar or all-unfamiliar.
    novelty: 1 - Math.abs(2 * unfamiliarShare - 1),
    safetyState: safetyWeight / totalWeight,
  };
}

export type SuppressedMetrics =
  | { suppressed: true; reasonCode: 'SUPPRESSED_K_ANONYMITY'; cohortSize: number }
  | { suppressed: false; cohortSize: number; metrics: ExperienceMetrics };

/**
 * k-anonymity gate (WS-H.5.1b-2): metrics for cohorts below the threshold
 * are withheld — distinguishably from a true zero — before they can reach
 * any dashboard or export.
 */
export function suppressBelowK(
  cohortSize: number,
  k: number,
  metrics: ExperienceMetrics,
): SuppressedMetrics {
  if (!Number.isInteger(k) || k < 1) throw new Error(`invalid k-anonymity threshold ${k}`);
  if (cohortSize < k) {
    return { suppressed: true, reasonCode: 'SUPPRESSED_K_ANONYMITY', cohortSize };
  }
  return { suppressed: false, cohortSize, metrics };
}
