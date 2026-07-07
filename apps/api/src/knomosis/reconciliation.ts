// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3.4a/b — three-source reconciliation and divergence detection.  Under
// the v0.4 gateway contract the third source is MEDIATED by Knomosis: Licio
// compares (1) product-DB state (action records + the per-actor deposit
// ledger they imply), (2) Knomosis receipts (the verdicts/receipts attached
// to those records), and (3) the gateway's authoritative indexer views
// (standing reads + the indexed post-reorg event stream) — reconciled only up
// to a COMMON LOW-WATERMARK X-Knomosis-Seq so mismatched per-entity snapshots
// cannot hide or falsely report a gap.  In-flight (not-yet-reflected)
// submissions are IN-FLIGHT, not mismatches.
//
// Divergences classify as informational (timing), warning (small unexplained
// delta), or critical (material delta / lost events); critical fires an
// un-silenceable alert and opens a treasury freeze REVIEW (a human decides —
// never an automatic freeze), and ANY unexplained divergence blocks treasury
// expansion (§28.3: the gap must be zero or explained before expansion).

import { decCompare, decSum } from '@licio/governance';
import type { KnomosisGateway } from './gateway.js';
import type {
  KnomosisActionRecordEntity,
  KnomosisActionStore,
  OnChainEventStore,
  ReconciliationResultRecord,
  ReconciliationStore,
  WalletActorMappingStore,
} from './stores.js';

export interface ReconciliationDeps {
  actions: KnomosisActionStore;
  events: OnChainEventStore;
  reconciliation: ReconciliationStore;
  actorMappings: WalletActorMappingStore;
  gateway: () => KnomosisGateway | null;
  config: () => { divergenceCriticalThresholdMinorUnits: string };
  now: () => number;
  uuid: () => string;
  log: (event: string, meta: Record<string, unknown>) => void;
  alert: (event: string, meta: Record<string, unknown>) => void;
}

/** States that are legitimately in flight (never a mismatch on their own). */
const IN_FLIGHT_STATES = new Set(['submitted', 'accepted', 'challenged', 'frozen']);

export interface ActionReconcileOutcome {
  outcome: 'match' | 'mismatch' | 'in_flight';
  detail: string;
}

/**
 * Reconcile ONE action record against the indexed event stream (source 3)
 * and its own receipt state (source 2).  Pure decision logic, exported for
 * exhaustive unit testing.
 */
export function decideActionReconciliation(
  record: KnomosisActionRecordEntity,
  latestEventState: string | null,
): ActionReconcileOutcome {
  if (IN_FLIGHT_STATES.has(record.submissionState)) {
    // A pending record is noted but not a mismatch by itself (WS-L.3.4a).
    return { outcome: 'in_flight', detail: `in flight (${record.submissionState})` };
  }
  if (record.submissionState === 'failed') {
    // Failed pre-execution: no event should exist; one appearing is a mismatch.
    return latestEventState === null || latestEventState === 'reverted'
      ? { outcome: 'match', detail: 'failed pre-execution; no settled event' }
      : { outcome: 'mismatch', detail: `failed record but event ${latestEventState}` };
  }
  // finalized / reverted must agree with the event stream.
  if (latestEventState === null) {
    return {
      outcome: 'mismatch',
      detail: `record ${record.submissionState} but no indexed event`,
    };
  }
  const agrees =
    (record.submissionState === 'finalized' && latestEventState === 'finalized') ||
    (record.submissionState === 'reverted' && latestEventState === 'reverted');
  return agrees
    ? { outcome: 'match', detail: 'record state agrees with the indexed stream' }
    : {
        outcome: 'mismatch',
        detail: `record ${record.submissionState} vs event ${latestEventState}`,
      };
}

/** Classify a divergence (WS-L.3.4b). */
export function classifyDivergence(
  deltaMinorUnits: string,
  criticalThreshold: string,
  withinConfirmationWindow: boolean,
): 'informational' | 'warning' | 'critical' {
  if (withinConfirmationWindow) return 'informational';
  if (decCompare(deltaMinorUnits, criticalThreshold) >= 0) return 'critical';
  return 'warning';
}

const EVENT_STATE_OF_TYPE: Record<string, string> = {
  'knomosis.action.accepted': 'accepted',
  'knomosis.action.settled': 'settled',
  'knomosis.action.finalized': 'finalized',
  'knomosis.action.reverted': 'reverted',
};

/**
 * Run reconciliation for a deployment: every unreconciled action, plus the
 * per-actor deposit ledger vs the gateway's standing snapshot at the common
 * low-watermark.  Appends a result per entity; returns the summary.
 */
export async function reconcileDeployment(
  deps: ReconciliationDeps,
  deploymentId: string,
  limit = 200,
): Promise<{ matched: number; mismatched: number; inFlight: number; halted: boolean }> {
  const nowIso = new Date(deps.now()).toISOString();

  // A halted deployment (unsupported event / gap) stays halted until the
  // schema/rebuild path clears it — reconciliation never silently resumes.
  const unresolved = await deps.reconciliation.listUnresolvedMismatches(deploymentId);
  const halted = unresolved.some(
    (r) => r.outcome === 'halted_unsupported_version' || r.outcome === 'halted_event_gap',
  );
  if (halted) {
    deps.log('knomosis.reconcile.halted', { deployment_id: deploymentId });
    return { matched: 0, mismatched: 0, inFlight: 0, halted: true };
  }

  const indexed = await deps.events.listByDeployment(deploymentId, 10_000);
  const latestStateByHash = new Map<string, string>();
  for (const event of indexed) {
    const hash = event.decodedPayload['typed_data_hash'];
    const state = EVENT_STATE_OF_TYPE[event.eventType];
    if (typeof hash === 'string' && state !== undefined && event.reorgState !== 'reorged') {
      latestStateByHash.set(hash, state);
    }
  }
  const lowWatermark = await deps.events.latestGatewaySeq(deploymentId);

  let matched = 0;
  let mismatched = 0;
  let inFlight = 0;
  const records = await deps.actions.listUnreconciled(deploymentId, limit);
  for (const record of records) {
    const decision = decideActionReconciliation(
      record,
      latestStateByHash.get(record.typedDataHash) ?? null,
    );
    if (decision.outcome === 'in_flight') {
      inFlight += 1;
      continue;
    }
    const result: ReconciliationResultRecord = {
      resultId: deps.uuid(),
      deploymentId,
      entityType: 'action',
      entityRef: record.actionRecordId,
      outcome: decision.outcome,
      severity:
        decision.outcome === 'mismatch'
          ? classifyDivergence(
              record.signedAction.message['amount'] ?? '0',
              deps.config().divergenceCriticalThresholdMinorUnits,
              false,
            )
          : null,
      details: {
        sources: {
          product_db: record.submissionState,
          knomosis_receipt: record.submissionState,
          gateway_stream: latestStateByHash.get(record.typedDataHash) ?? null,
        },
        detail: decision.detail,
      },
      lowWatermarkSeq: lowWatermark,
      createdAt: nowIso,
    };
    await deps.reconciliation.append(result);
    await deps.actions.update({
      ...record,
      reconciliationState: decision.outcome === 'match' ? 'matched' : 'mismatch',
      updatedAt: nowIso,
    });
    if (decision.outcome === 'match') matched += 1;
    else {
      mismatched += 1;
      await raiseDivergence(deps, result);
    }
  }

  return { matched, mismatched, inFlight, halted: false };
}

/** WS-L.3.4b — alert + freeze-review escalation for a mismatch. */
async function raiseDivergence(
  deps: ReconciliationDeps,
  result: ReconciliationResultRecord,
): Promise<void> {
  deps.log('knomosis.reconcile.divergence', {
    entity: result.entityRef,
    severity: result.severity,
  });
  if (result.severity === 'critical') {
    // Un-silenceable critical path: page ops/security AND open the treasury
    // freeze REVIEW (a human decides; never an automatic freeze).
    deps.alert('knomosis.reconcile.critical_divergence', {
      deployment_id: result.deploymentId,
      entity_type: result.entityType,
      entity_ref: result.entityRef,
      action: 'treasury_freeze_review_requested',
    });
  }
}

/**
 * §28.3 expansion gate: treasury limits may expand ONLY when no unexplained
 * divergence exists for the deployment.
 */
export async function canExpandTreasury(
  deps: Pick<ReconciliationDeps, 'reconciliation'>,
  deploymentId: string,
): Promise<{ allowed: boolean; blocking: number }> {
  const unresolved = await deps.reconciliation.listUnresolvedMismatches(deploymentId);
  return { allowed: unresolved.length === 0, blocking: unresolved.length };
}

/**
 * Treasury-ledger comparison for one actor at the common low-watermark: the
 * product-side deposit ledger (finalized deposit-type actions per asset) vs
 * the gateway's standing snapshot.  A short-fall within the in-flight window
 * is informational; anything else classifies by the configured threshold.
 * Exported for the treasury reconciliation sweep + tests.
 */
export function compareActorLedger(
  finalizedDeposits: readonly { asset: string; amount: string }[],
  gatewayBalances: Readonly<Record<string, string>>,
  criticalThreshold: string,
  hasInFlight: boolean,
): {
  asset: string;
  expected: string;
  actual: string;
  severity: 'informational' | 'warning' | 'critical';
}[] {
  const expectedByAsset = new Map<string, string>();
  for (const deposit of finalizedDeposits) {
    expectedByAsset.set(
      deposit.asset,
      decSum([expectedByAsset.get(deposit.asset) ?? '0', deposit.amount]),
    );
  }
  const divergences: {
    asset: string;
    expected: string;
    actual: string;
    severity: 'informational' | 'warning' | 'critical';
  }[] = [];
  const assets = new Set([...expectedByAsset.keys(), ...Object.keys(gatewayBalances)]);
  for (const asset of assets) {
    const expected = expectedByAsset.get(asset) ?? '0';
    const actual = gatewayBalances[asset] ?? '0'; // absent cell reads "0"
    if (decCompare(expected, actual) === 0) continue;
    const magnitude =
      decCompare(expected, actual) > 0 ? subtract(expected, actual) : subtract(actual, expected);
    divergences.push({
      asset,
      expected,
      actual,
      severity: classifyDivergence(magnitude, criticalThreshold, hasInFlight),
    });
  }
  return divergences;
}

/** Exact non-negative decimal subtraction (a ≥ b) for divergence magnitude. */
function subtract(a: string, b: string): string {
  // decSum handles signed strings via its parser; reuse it with a negated b.
  return decSum([a, `-${b}`]);
}
