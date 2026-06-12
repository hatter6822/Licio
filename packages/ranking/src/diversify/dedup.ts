// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.4a — matroid-rank-based dedup (SPEC §7, §13.4). Items are grouped by
// their MERI duplicate cluster; at most `meri_max_per_cluster` items of one
// cluster occupy primary feed positions (repetition is not independence). The
// kept items are the highest-scoring of their cluster; the remainder stay
// available for "more on this story" expansion — demoted, never deleted.
// Items with no cluster (unique items) are unconstrained.
//
// Determinism: ties break on item id, so identical inputs produce identical
// partitions (a replay requirement, WS-I.2.5b).

import type { ConstraintApplication } from '../schemas/decision-log.js';

export interface DedupInput {
  itemId: string;
  /** Final score after penalties + distribution multipliers. */
  score: number;
  /** MERI duplicate-cluster id; null/undefined ⇒ unique item. */
  clusterId: string | null;
}

export interface DedupResult {
  /** Items keeping primary feed eligibility, original relative order. */
  kept: DedupInput[];
  /** clusterId → demoted items ("more on this story" expansion). */
  expansions: Map<string, DedupInput[]>;
  applications: ConstraintApplication[];
  /** Largest cluster encountered (observability). */
  largestClusterSize: number;
}

/**
 * Apply the cluster cap. `items` must already be sorted by descending score
 * (the orchestrator's ordering); the pass is stable — kept items preserve
 * their relative order.
 */
export function applyMatroidDedup(
  items: readonly DedupInput[],
  maxPerCluster: number,
): DedupResult {
  const cap = Math.max(1, Math.floor(maxPerCluster));
  const seenPerCluster = new Map<string, number>();
  const kept: DedupInput[] = [];
  const expansions = new Map<string, DedupInput[]>();
  const applications: ConstraintApplication[] = [];
  let largestClusterSize = 0;
  const clusterTotals = new Map<string, number>();
  for (const item of items) {
    if (item.clusterId !== null) {
      const total = (clusterTotals.get(item.clusterId) ?? 0) + 1;
      clusterTotals.set(item.clusterId, total);
      largestClusterSize = Math.max(largestClusterSize, total);
    }
  }
  for (const item of items) {
    if (item.clusterId === null) {
      kept.push(item);
      continue;
    }
    const seen = seenPerCluster.get(item.clusterId) ?? 0;
    if (seen < cap) {
      seenPerCluster.set(item.clusterId, seen + 1);
      kept.push(item);
      continue;
    }
    const bucket = expansions.get(item.clusterId) ?? [];
    bucket.push(item);
    expansions.set(item.clusterId, bucket);
    applications.push({
      constraint: 'meri_duplicate_cluster_cap',
      item_id: item.itemId,
      threshold: cap,
      actual: item.clusterId,
      action: 'demoted',
      enforced: true,
    });
  }
  return { kept, expansions, applications, largestClusterSize };
}
