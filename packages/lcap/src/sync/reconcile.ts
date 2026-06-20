// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Frontier-first reconciliation order (OFFLINE_SPEC §17.1, WS-R.7.1).  v0.2
// reconciles trust/liveness frontiers BEFORE content: (1) revocation frontier,
// (2) room checkpoint frontier, (3) policy epoch frontier, (4) device sequence
// frontier, (5) explicit missing-dependency wants, (6) recent object summaries,
// (7) optional large-cache filters.  A peer behind on revocations is fed
// revocations first (§17.3).  Pure ordering logic; no I/O.

import type { WantRequestV2 } from '../schemas/sync.js';

/** The seven reconciliation categories in their §17.1 processing order. */
export type ReconciliationCategory =
  | 'revocation_frontier'
  | 'checkpoint_frontier'
  | 'policy_epoch_frontier'
  | 'device_sequence_frontier'
  | 'missing_dependency_wants'
  | 'recent_object_summaries'
  | 'optional_filters';

/** The canonical §17.1 order (index = rank; lower processed first). */
export const RECONCILIATION_ORDER: readonly ReconciliationCategory[] = [
  'revocation_frontier',
  'checkpoint_frontier',
  'policy_epoch_frontier',
  'device_sequence_frontier',
  'missing_dependency_wants',
  'recent_object_summaries',
  'optional_filters',
];

const CATEGORY_RANK: ReadonlyMap<ReconciliationCategory, number> = new Map(
  RECONCILIATION_ORDER.map((category, index) => [category, index]),
);

/** The processing rank of a reconciliation category (lower = sooner). */
export function reconciliationRank(category: ReconciliationCategory): number {
  return CATEGORY_RANK.get(category) ?? RECONCILIATION_ORDER.length;
}

/**
 * The reconciliation category a want belongs to — so trust/liveness wants
 * (revocation, checkpoint) are always ordered ahead of content wants (§17.1).
 */
export function wantCategory(reason: WantRequestV2['reason']): ReconciliationCategory {
  switch (reason) {
    case 'revocation_gap':
      return 'revocation_frontier';
    case 'checkpoint_gap':
      return 'checkpoint_frontier';
    case 'missing_dependency':
      return 'missing_dependency_wants';
    default:
      // explicit_user_request / room_interest / resume_partial / scarce_replica
      return 'recent_object_summaries';
  }
}

/**
 * Order wants by §17.1 reconciliation category, then by any priority override
 * (lower = sooner), then by CID for a fully deterministic result.  Revocation
 * and checkpoint wants therefore always precede content wants.  Stable and pure
 * (operates on a copy).
 */
export function orderWants(wants: readonly WantRequestV2[]): WantRequestV2[] {
  return [...wants].sort((a, b) => {
    const byCategory =
      reconciliationRank(wantCategory(a.reason)) - reconciliationRank(wantCategory(b.reason));
    if (byCategory !== 0) return byCategory;
    const byPriority = (a.priority_override ?? 4) - (b.priority_override ?? 4);
    if (byPriority !== 0) return byPriority;
    return a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0;
  });
}
