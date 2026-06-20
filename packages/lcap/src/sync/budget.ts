// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exchange budgets (OFFLINE_SPEC §16.5, WS-R.6.2).  A budget caps a single
// exchange's request/response bytes, table entries, records/proofs/blocks, and
// admitted priority.  Clients SHOULD shrink budgets under battery saver, metered
// data, low storage, high memory pressure, or high-risk privacy mode; the
// strictest reduction, `minimal_mode`, drops to C0 + the smallest T1.  Every
// shrink is MONOTONIC — no field ever grows — so applying constraints in any
// order can only tighten the budget.  Pure functions.

import type { ExchangeBudgetV2 } from '../schemas/sync.js';

/** A balanced default budget for an unconstrained authenticated exchange. */
export const DEFAULT_BUDGET: ExchangeBudgetV2 = {
  max_request_bytes: 256 * 1024,
  max_response_bytes: 1024 * 1024,
  max_pack_table_entries: 1024,
  max_frame_bytes: 256 * 1024,
  max_uncompressed_bytes: 4 * 1024 * 1024,
  max_records: 1024,
  max_proofs: 1024,
  max_blocks: 256,
  priority_floor: 4,
  allow_evidence: true,
  allow_media: true,
  allow_private_encrypted: false,
};

/** The resource/privacy constraints a client is currently under (§16.5). */
export interface BudgetConstraints {
  readonly batterySaver?: boolean;
  readonly meteredConnection?: boolean;
  readonly lowStorage?: boolean;
  readonly memoryPressure?: boolean;
  readonly highRiskPrivacy?: boolean;
  /** Force the strictest mode: C0 + the smallest T1 only. */
  readonly minimal?: boolean;
}

/** Floor a priority to a smaller (numerically lower) admitted ceiling, never higher. */
function tightenPriorityFloor(
  current: ExchangeBudgetV2['priority_floor'],
  proposed: ExchangeBudgetV2['priority_floor'],
): ExchangeBudgetV2['priority_floor'] {
  return (proposed < current ? proposed : current) as ExchangeBudgetV2['priority_floor'];
}

/** Scale an integer budget down by a ratio (floored), never below `min`. */
function scaleDown(value: number, ratio: number, min: number): number {
  return Math.max(min, Math.floor(value * ratio));
}

/**
 * The strictest budget derived from `base`: C0 + the smallest T1 (priority_floor
 * 1, no evidence/media/private), with byte/count caps cut to the minimum needed
 * to move one small text contribution and its trust closure.
 */
export function minimalBudget(base: ExchangeBudgetV2): ExchangeBudgetV2 {
  return {
    ...base,
    max_request_bytes: Math.min(base.max_request_bytes, 16 * 1024),
    max_response_bytes: Math.min(base.max_response_bytes, 16 * 1024),
    max_pack_table_entries: Math.min(base.max_pack_table_entries, 16),
    max_frame_bytes: Math.min(base.max_frame_bytes, 16 * 1024),
    max_uncompressed_bytes: Math.min(base.max_uncompressed_bytes, 64 * 1024),
    max_records: Math.min(base.max_records, 8),
    max_proofs: Math.min(base.max_proofs, 16),
    max_blocks: Math.min(base.max_blocks, 1),
    priority_floor: tightenPriorityFloor(base.priority_floor, 1),
    allow_evidence: false,
    allow_media: false,
    allow_private_encrypted: false,
    minimal_mode: true,
  };
}

/**
 * Shrink a budget under the active constraints (§16.5).  Each flag tightens a
 * subset of fields; `minimal` (or the combination of several severe flags)
 * collapses to {@link minimalBudget}.  Monotonic: the result is ≤ `base` in every
 * field.
 */
export function shrinkBudget(
  base: ExchangeBudgetV2,
  constraints: BudgetConstraints,
): ExchangeBudgetV2 {
  if (constraints.minimal === true) return minimalBudget(base);

  let budget: ExchangeBudgetV2 = { ...base };

  if (constraints.batterySaver === true) {
    budget = {
      ...budget,
      max_response_bytes: scaleDown(budget.max_response_bytes, 0.5, 16 * 1024),
      max_blocks: scaleDown(budget.max_blocks, 0.5, 0),
      allow_media: false,
      battery_saver: true,
      priority_floor: tightenPriorityFloor(budget.priority_floor, 2),
    };
  }

  if (constraints.meteredConnection === true) {
    budget = {
      ...budget,
      max_request_bytes: scaleDown(budget.max_request_bytes, 0.5, 8 * 1024),
      max_response_bytes: scaleDown(budget.max_response_bytes, 0.5, 16 * 1024),
      allow_media: false,
      metered_connection: true,
    };
  }

  if (constraints.lowStorage === true) {
    budget = {
      ...budget,
      max_blocks: scaleDown(budget.max_blocks, 0.25, 0),
      max_records: scaleDown(budget.max_records, 0.5, 4),
      allow_media: false,
    };
  }

  if (constraints.memoryPressure === true) {
    budget = {
      ...budget,
      max_uncompressed_bytes: scaleDown(budget.max_uncompressed_bytes, 0.25, 64 * 1024),
      max_frame_bytes: scaleDown(budget.max_frame_bytes, 0.5, 16 * 1024),
    };
  }

  if (constraints.highRiskPrivacy === true) {
    // High-risk privacy collapses to the strictest mode: reveal/transfer minimum.
    budget = minimalBudget(budget);
  }

  return budget;
}
