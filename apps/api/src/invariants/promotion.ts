// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.2e — the promotion service: the SINGLE control point through which
// any invariant's shadow_status can change, and the single predicate every
// effect-application site consults. Records are append-only; demotion (the
// kill switch) appends and takes effect on the next read — no redeploy.

import {
  enforcementAllowed,
  type InvariantCard,
  type PromotionRecord,
  resolveShadowStatus,
  runRegressionSuite,
  type ShadowStatus,
  validatePromotion,
} from '@licio/invariants';
import type { PromotionStore } from './stores.js';

const STATUS_RANK: Record<ShadowStatus, number> = {
  shadow: 0,
  soft_constraint: 1,
  hard_constraint: 2,
};

export interface PromotionService {
  /** Current status (no records ⇒ shadow). */
  statusOf(invariantType: string): Promise<ShadowStatus>;
  /** THE enforcement gate: true only in a constraint mode (WS-H.1.2e). */
  effectsEnabled(invariantType: string): Promise<boolean>;
  /**
   * Validate + append a promotion/demotion. Returns null on success or the
   * rejection reason (the route maps it to 422).
   */
  apply(record: PromotionRecord, minShadowDays: number): Promise<string | null>;
  history(invariantType: string): Promise<PromotionRecord[]>;
}

export function createPromotionService(
  store: PromotionStore,
  cardFor: (invariantType: string) => InvariantCard | null,
  log: (event: string, meta: Record<string, unknown>) => void,
  regressionGate: () => { pass: boolean; failures: Array<{ invariant: string }> } = () =>
    runRegressionSuite(),
): PromotionService {
  const history = async (invariantType: string): Promise<PromotionRecord[]> => {
    const rows = await store.listForInvariant(invariantType);
    return rows.map((row) => ({
      invariantType: row.invariantType,
      fromStatus: row.fromStatus as ShadowStatus,
      toStatus: row.toStatus as ShadowStatus,
      evidence: {
        shadowDurationDays: Number(row.evidence['shadowDurationDays'] ?? 0),
        driftReportRef: String(row.evidence['driftReportRef'] ?? ''),
        observedCoverage: Number(row.evidence['observedCoverage'] ?? 0),
        observedConfidence: Number(row.evidence['observedConfidence'] ?? 0),
      },
      owner: row.owner,
      createdAt: row.createdAt,
    }));
  };

  return {
    history,
    async statusOf(invariantType) {
      return resolveShadowStatus(await history(invariantType));
    },
    async effectsEnabled(invariantType) {
      return enforcementAllowed(resolveShadowStatus(await history(invariantType)));
    },
    async apply(record, minShadowDays) {
      const card = cardFor(record.invariantType);
      if (!card) return `unknown invariant type '${record.invariantType}'`;
      const problem = validatePromotion(record, card, await history(record.invariantType), {
        minShadowDays,
      });
      if (problem !== null) {
        log('invariants.promotion_rejected', {
          invariant_type: record.invariantType,
          problem,
        });
        return problem;
      }
      // UPWARD promotions additionally require the regression suite to pass
      // RIGHT NOW against the production algorithm versions — a drifting
      // invariant can never gain authority. Demotions (the kill switch) are
      // NEVER gated: the safety path must always be available.
      if (STATUS_RANK[record.toStatus] > STATUS_RANK[record.fromStatus]) {
        const report = regressionGate();
        if (!report.pass) {
          const failing = [...new Set(report.failures.map((f) => f.invariant))].join(', ');
          const reason = `regression suite failing (${failing}) — promotion blocked`;
          log('invariants.promotion_rejected', {
            invariant_type: record.invariantType,
            problem: reason,
          });
          return reason;
        }
      }
      await store.append({
        invariantType: record.invariantType,
        fromStatus: record.fromStatus,
        toStatus: record.toStatus,
        evidence: { ...record.evidence },
        owner: record.owner,
        createdAt: record.createdAt,
      });
      log('invariants.promotion_applied', {
        invariant_type: record.invariantType,
        from: record.fromStatus,
        to: record.toStatus,
        owner: record.owner,
      });
      return null;
    },
  };
}
