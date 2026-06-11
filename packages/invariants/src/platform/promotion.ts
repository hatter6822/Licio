// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.2e — the shadow-to-enforcement promotion gate (pure logic).
//
// "Shadow before enforcement" has exactly one control point: an invariant's
// shadow_status advances shadow → soft_constraint → hard_constraint ONLY
// through a recorded promotion that passes the checklist below. Demotion
// (the kill switch) is always legal, takes effect by appending a record —
// no redeploy — and is logged like any promotion. Status is resolved from
// the append-only record history (latest record wins; no records = shadow).
//
// While an invariant is in shadow it computes and logs but carries ZERO
// enforcement authority; `enforcementAllowed` is the single predicate every
// effect-application site must consult (the M2 "no hidden sanctions" gate).

import type { InvariantCard, ShadowStatus } from '../schemas/card.js';
import { SHADOW_STATUSES } from '../schemas/card.js';

export interface PromotionEvidence {
  /** Continuous shadow operation behind this promotion, in days. */
  shadowDurationDays: number;
  /** Reference to the drift-free regression report (run id or doc path). */
  driftReportRef: string;
  /** Observed mean coverage over the shadow window. */
  observedCoverage: number;
  /** Observed mean confidence over the shadow window. */
  observedConfidence: number;
}

export interface PromotionRecord {
  invariantType: string;
  fromStatus: ShadowStatus;
  toStatus: ShadowStatus;
  evidence: PromotionEvidence;
  /** Named owner signing off (never a service account). */
  owner: string;
  createdAt: string;
}

export interface PromotionPolicy {
  /** Minimum continuous shadow days before ANY promotion (default 14). */
  minShadowDays: number;
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = { minShadowDays: 14 };

const STATUS_ORDER: Record<ShadowStatus, number> = {
  shadow: 0,
  soft_constraint: 1,
  hard_constraint: 2,
};

/** Resolve the current status from the append-only history. */
export function resolveShadowStatus(records: readonly PromotionRecord[]): ShadowStatus {
  const last = records[records.length - 1];
  return last?.toStatus ?? 'shadow';
}

/**
 * Validate a proposed promotion against the checklist. Returns null when
 * valid, or the (logged) rejection reason. Demotions — `toStatus` strictly
 * below `fromStatus` — are always valid kill-switch paths but still require
 * an owner.
 */
export function validatePromotion(
  record: PromotionRecord,
  card: InvariantCard,
  history: readonly PromotionRecord[],
  policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
): string | null {
  if (!SHADOW_STATUSES.includes(record.fromStatus) || !SHADOW_STATUSES.includes(record.toStatus)) {
    return 'unknown shadow status';
  }
  if (record.owner.trim().length === 0) return 'a named owner sign-off is required';
  const current = resolveShadowStatus(history);
  if (record.fromStatus !== current) {
    return `fromStatus '${record.fromStatus}' does not match current status '${current}'`;
  }
  if (record.toStatus === record.fromStatus) return 'promotion must change the status';

  // Demotion — the kill switch — is always allowed (logged, owner-signed).
  if (STATUS_ORDER[record.toStatus] < STATUS_ORDER[record.fromStatus]) return null;

  // Promotions advance one step at a time: shadow can never jump straight
  // to hard_constraint.
  if (STATUS_ORDER[record.toStatus] - STATUS_ORDER[record.fromStatus] !== 1) {
    return 'promotion must advance exactly one status step';
  }
  const { evidence } = record;
  if (!(evidence.shadowDurationDays >= policy.minShadowDays)) {
    return `promotion requires >= ${policy.minShadowDays} shadow days (got ${evidence.shadowDurationDays})`;
  }
  if (evidence.driftReportRef.trim().length === 0) {
    return 'promotion requires a drift-free regression report reference';
  }
  if (!(evidence.observedCoverage >= card.coverage_bounds.min_acceptable)) {
    return `observed coverage ${evidence.observedCoverage} below the card minimum ${card.coverage_bounds.min_acceptable}`;
  }
  if (!(evidence.observedConfidence >= card.confidence_bounds.min)) {
    return `observed confidence ${evidence.observedConfidence} below the card minimum ${card.confidence_bounds.min}`;
  }
  return null;
}

/**
 * THE enforcement predicate: an invariant's effect may apply only in a
 * constraint mode. Every ranking/moderation effect site consults this.
 */
export function enforcementAllowed(status: ShadowStatus): boolean {
  return status === 'soft_constraint' || status === 'hard_constraint';
}
