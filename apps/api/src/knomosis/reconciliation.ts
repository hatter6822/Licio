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
  KnomosisReceiptStore,
  OnChainEventStore,
  ReconciliationResultRecord,
  ReconciliationStore,
  WalletActorMappingStore,
} from './stores.js';

export interface ReconciliationDeps {
  actions: KnomosisActionStore;
  events: OnChainEventStore;
  receipts: KnomosisReceiptStore;
  reconciliation: ReconciliationStore;
  actorMappings: WalletActorMappingStore;
  gateway: () => KnomosisGateway | null;
  config: () => { divergenceCriticalThresholdMinorUnits: string };
  now: () => number;
  uuid: () => string;
  log: (event: string, meta: Record<string, unknown>) => void;
  alert: (event: string, meta: Record<string, unknown>) => void;
}

/** States that are legitimately in flight (never a mismatch on their own).
 *  `settled` is on-chain but PRE-FINALITY (a reorg can still revert it), so it
 *  stays in-flight until it finalizes/reverts rather than being compared against
 *  the finalized/reverted event pair (which would mis-flag it as a mismatch). */
const IN_FLIGHT_STATES = new Set(['submitted', 'accepted', 'settled', 'challenged', 'frozen']);

export interface ActionReconcileOutcome {
  outcome: 'match' | 'mismatch' | 'in_flight';
  detail: string;
}

/**
 * Reconcile ONE action record against BOTH independent sources: the indexed
 * event stream (source 3, `latestEventState`) AND the Knomosis receipt that was
 * written for it (source 2, `receiptState` = the public receipt's `finalState`,
 * or null when NO receipt exists).  The receipt is verified as a genuine third
 * observation — never echoed from the product-DB state — so a missing or
 * disagreeing receipt is itself a divergence (WS-L.3.4a).  Pure decision logic,
 * exported for exhaustive unit testing.
 */
export function decideActionReconciliation(
  record: KnomosisActionRecordEntity,
  latestEventState: string | null,
  receiptState: string | null,
): ActionReconcileOutcome {
  if (IN_FLIGHT_STATES.has(record.submissionState)) {
    // A pending record is noted but not a mismatch by itself (WS-L.3.4a).
    return { outcome: 'in_flight', detail: `in flight (${record.submissionState})` };
  }
  if (record.submissionState === 'failed') {
    // Failed pre-execution: NO gateway event should exist.  ANY event — a
    // `reverted` included — means the action actually reached execution, which
    // contradicts the product state and must surface as a divergence.
    if (latestEventState !== null) {
      return { outcome: 'mismatch', detail: `failed record but event ${latestEventState}` };
    }
    // A settlement receipt is written ONLY for a stable on-chain state, so a
    // failed record that nonetheless carries one is a source-2 divergence.
    if (receiptState !== null) {
      return { outcome: 'mismatch', detail: `failed record but receipt ${receiptState}` };
    }
    return { outcome: 'match', detail: 'failed pre-execution; no indexed event or receipt' };
  }
  // finalized / reverted must agree with the event stream AND the receipt.
  if (latestEventState === null) {
    return {
      outcome: 'mismatch',
      detail: `record ${record.submissionState} but no indexed event`,
    };
  }
  if (receiptState === null) {
    // The stable state was reached but no receipt was persisted — the audit
    // trail is incomplete, which is a divergence, not a silent pass.
    return {
      outcome: 'mismatch',
      detail: `record ${record.submissionState} but no receipt`,
    };
  }
  const eventAgrees =
    (record.submissionState === 'finalized' && latestEventState === 'finalized') ||
    (record.submissionState === 'reverted' && latestEventState === 'reverted');
  const receiptAgrees = receiptState === record.submissionState;
  if (eventAgrees && receiptAgrees) {
    return { outcome: 'match', detail: 'record agrees with the indexed stream and the receipt' };
  }
  if (!receiptAgrees) {
    return {
      outcome: 'mismatch',
      detail: `record ${record.submissionState} vs receipt ${receiptState}`,
    };
  }
  return {
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

/** Action types that MOVE funds (carry an `asset`) — the only in-flight actions
 *  that can explain a per-asset balance timing shortfall (WS-L.3.4b). */
const FUND_MOVEMENT_ACTION_TYPES: ReadonlySet<string> = new Set([
  'treasury_deposit',
  'grant_payout',
  'bounty_contribution',
]);

// MUST cover the SAME event types ingest's `EVENT_STATE` maps (asserted by a parity
// test): a `challenged`/`frozen` event proves the gateway SAW the action, so dropping
// it here would feed `decideActionReconciliation` a `null` latest-event state and let
// a genuinely-diverged (e.g. failed) row reconcile as a clean pre-execution failure
// (WS-L.3.4a).
export const EVENT_STATE_OF_TYPE: Record<string, string> = {
  'knomosis.action.accepted': 'accepted',
  'knomosis.action.settled': 'settled',
  'knomosis.action.finalized': 'finalized',
  'knomosis.action.reverted': 'reverted',
  'knomosis.action.challenged': 'challenged',
  'knomosis.action.frozen': 'frozen',
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

  const records = await deps.actions.listUnreconciled(deploymentId, limit);
  // Query the indexed stream by the EXACT hashes of this batch, not a fixed
  // listByDeployment page — a deployment with >10k events must not let the
  // newest state fall outside the window (WS-L.3.4a).  `listByTypedDataHashes`
  // returns ascending (seq,index), so the last write per hash wins = latest.
  const batchHashes = [...new Set(records.map((r) => r.typedDataHash))];
  const indexed = await deps.events.listByTypedDataHashes(deploymentId, batchHashes);
  const latestStateByHash = new Map<string, string>();
  for (const event of indexed) {
    const hash = event.decodedPayload['typed_data_hash'];
    const state = EVENT_STATE_OF_TYPE[event.eventType];
    if (typeof hash === 'string' && state !== undefined && event.reorgState !== 'reorged') {
      latestStateByHash.set(hash, state);
    }
  }
  const lowWatermark = await deps.events.latestGatewaySeq(deploymentId);

  // The DETERMINISTIC gateway-bound owner per hash: when a duplicate preflight+
  // submit leaves a `failed` loser sharing the winner's `(deployment, hash)`, only
  // the winner owns the indexed event.  A non-owner loser never reached the gateway,
  // so it must reconcile as a clean match — NOT a spurious critical divergence
  // against its sibling's finalized event (WS-L.3.4a).
  const ownerByHash = new Map<string, string>();
  for (const hash of batchHashes) {
    const owner = await deps.actions.getByTypedDataHash(deploymentId, hash);
    if (owner !== null) ownerByHash.set(hash, owner.actionRecordId);
  }

  let matched = 0;
  let mismatched = 0;
  let inFlight = 0;
  for (const record of records) {
    // A duplicate LOSER (a different row owns the hash) reconciles as matched: the
    // indexed event belongs to its gateway-bound sibling, not to this failed row.
    const owner = ownerByHash.get(record.typedDataHash);
    if (owner !== undefined && owner !== record.actionRecordId) {
      await deps.actions.update({ ...record, reconciliationState: 'matched', updatedAt: nowIso });
      matched += 1;
      continue;
    }
    // Source 2 = the ACTUAL persisted public receipt (its finalState), read
    // per-record — never the product state echoed back at itself.
    const receipt = await deps.receipts.getByAction(record.actionRecordId, 'public');
    const receiptState = receipt?.finalState ?? null;
    const decision = decideActionReconciliation(
      record,
      latestStateByHash.get(record.typedDataHash) ?? null,
      receiptState,
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
          knomosis_receipt: receiptState,
          gateway_stream: latestStateByHash.get(record.typedDataHash) ?? null,
        },
        detail: decision.detail,
      },
      lowWatermarkSeq: lowWatermark,
      createdAt: nowIso,
    };
    if (decision.outcome === 'match') {
      // A resolving `match` SUPERSEDES any prior mismatch for this action (a
      // finalized action whose delayed receipt/event finally arrived), so it stops
      // blocking canExpandTreasury.  This resolution pass only runs because
      // mismatched actions stay in the re-check set (listUnreconciled, WS-L.3.4b).
      await deps.reconciliation.append(result);
      // Also supersede any ORPHAN-EVENT mismatch recorded (keyed by this action's
      // `typed_data_hash`) when a gateway event arrived BEFORE this action row
      // existed: now that the action reconciles, that event is accounted for and
      // must stop blocking canExpandTreasury (WS-L.3.3b).  Only append the resolving
      // match when such a mismatch is actually outstanding, so a normal match never
      // writes a redundant row every tick.
      const orphanRef = `event-orphan:${record.typedDataHash}`;
      const orphan = await deps.reconciliation.latestForEntity('action', orphanRef);
      if (orphan !== null && orphan.outcome !== 'match') {
        await deps.reconciliation.append({
          resultId: deps.uuid(),
          deploymentId,
          entityType: 'action',
          entityRef: orphanRef,
          outcome: 'match',
          severity: null,
          details: { kind: 'orphan_event_resolved', resolved_by: record.actionRecordId },
          lowWatermarkSeq: lowWatermark,
          createdAt: nowIso,
        });
      }
      await deps.actions.update({ ...record, reconciliationState: 'matched', updatedAt: nowIso });
      matched += 1;
    } else {
      mismatched += 1;
      // Dedup: an UNCHANGED persistent mismatch is already recorded — don't
      // re-append or re-alert every tick (mirrors the treasury-ledger path).
      const latest = await deps.reconciliation.latestForEntity('action', record.actionRecordId);
      const unchanged =
        latest?.outcome === 'mismatch' &&
        (latest.details as { detail?: string }).detail === decision.detail;
      if (!unchanged) {
        await deps.reconciliation.append(result);
        await deps.actions.update({
          ...record,
          reconciliationState: 'mismatch',
          updatedAt: nowIso,
        });
        await raiseDivergence(deps, result);
      }
    }
  }

  // Treasury LEDGER reconciliation (source-1 vs source-3): even when every action
  // STATE agrees, a per-actor balance divergence — finalized deposits vs the
  // gateway's standing snapshot — must surface, or canExpandTreasury would see
  // zero blockers on a real imbalance.
  mismatched += await reconcileActorLedgers(deps, deploymentId, lowWatermark, nowIso);

  return { matched, mismatched, inFlight, halted: false };
}

/**
 * Per-actor treasury-ledger reconciliation: compare each actor's product-side
 * finalized-deposit ledger against the gateway standing snapshot (via the pure
 * `compareActorLedger`), appending a mismatch — deduped per `(wallet, asset)`
 * against the latest recorded value so a persistent imbalance is not re-alerted
 * every tick — for every unexplained divergence.  Returns the newly recorded
 * divergence count.  A null/unavailable gateway skips (never a false "clean").
 */
async function reconcileActorLedgers(
  deps: ReconciliationDeps,
  deploymentId: string,
  lowWatermarkSeq: string | null,
  nowIso: string,
): Promise<number> {
  const gateway = deps.gateway();
  if (gateway === null) return 0;
  // Aggregate EVERY finalized deposit per (wallet, asset) in the store — a fixed
  // page of raw deposits would omit later ones on a high-volume deployment and
  // manufacture false treasury mismatches (WS-L.3.4a).
  const ledgerByWallet = new Map<string, { asset: string; amount: string }[]>();
  for (const row of await deps.actions.sumFinalizedDeposits(deploymentId)) {
    const ledger = ledgerByWallet.get(row.walletAccountId) ?? [];
    ledger.push({ asset: row.asset, amount: row.total });
    ledgerByWallet.set(row.walletAccountId, ledger);
  }
  const threshold = deps.config().divergenceCriticalThresholdMinorUnits;
  let recorded = 0;
  // Iterate EVERY mapped actor for the deployment — NOT just wallets with a
  // finalized deposit.  A gateway actor reporting a nonzero balance while Licio
  // holds no deposit for it (indexer bug / out-of-band credit) must be compared
  // against its expected-ZERO ledger and surface as a blocker; keying off
  // `ledgerByWallet` alone would never call `compareActorLedger` for it (WS-L.3.4a).
  const mappings = await deps.actorMappings.listByDeployment(deploymentId);
  for (const mapping of mappings) {
    const walletAccountId = mapping.walletAccountId;
    const ledger = ledgerByWallet.get(walletAccountId) ?? [];
    const read = await gateway.getBalances(mapping.actorId, null);
    if (read.kind !== 'ok') continue; // unavailable / not-modified: retry next tick
    // Compare at a COMMON watermark: if the standing snapshot is BEHIND the product
    // event cursor, the product ledger may already include a deposit finalized by an
    // event the snapshot has not yet reflected, manufacturing a false shortfall.
    // Defer this actor's comparison until the snapshot catches up (WS-L.3.4a).
    if (lowWatermarkSeq !== null && BigInt(read.knomosisSeq) < BigInt(lowWatermarkSeq)) {
      continue;
    }
    // Sum the pending in-flight fund-movement AMOUNT per asset — a timing
    // shortfall is only explained up to that amount; a larger gap stays critical,
    // and an open proposal_sign/charter_update (no asset/amount) contributes 0.
    const inFlightByAsset = new Map<string, string>();
    for (const open of await deps.actions.listOpenByWallet(walletAccountId)) {
      // Only THIS deployment's FORWARDED actions can explain THIS deployment's balance
      // shortfall: a `reserving` row was never sent to the gateway, and an in-flight
      // action on ANOTHER deployment moves a different treasury — either would wrongly
      // inflate the explained amount and downgrade a real critical delta (WS-L.3.4b).
      if (open.deploymentId !== deploymentId || open.submissionState === 'reserving') continue;
      if (!FUND_MOVEMENT_ACTION_TYPES.has(open.actionType)) continue;
      const asset = open.signedAction.message['asset'];
      const amount = open.signedAction.message['amount'];
      if (typeof asset !== 'string' || typeof amount !== 'string') continue;
      inFlightByAsset.set(asset, decSum([inFlightByAsset.get(asset) ?? '0', amount]));
    }
    const divergences = compareActorLedger(ledger, read.value, threshold, inFlightByAsset);
    const divergentAssets = new Set(divergences.map((d) => d.asset));
    // The entityRef includes the DEPLOYMENT — `latestForEntity` keys on
    // (entityType, entityRef) with no deployment filter, so a shared wallet/asset
    // across deployments must not collide (a divergence on B is not masked by A).
    for (const divergence of divergences) {
      const entityRef = `${deploymentId}:${walletAccountId}:${divergence.asset}`;
      const latest = await deps.reconciliation.latestForEntity('treasury', entityRef);
      if (
        latest?.outcome === 'mismatch' &&
        (latest.details as { actual?: string }).actual === divergence.actual
      ) {
        continue; // an unchanged divergence is already recorded (still a blocker)
      }
      const result: ReconciliationResultRecord = {
        resultId: deps.uuid(),
        deploymentId,
        entityType: 'treasury',
        entityRef,
        outcome: 'mismatch',
        severity: divergence.severity,
        details: {
          asset: divergence.asset,
          expected: divergence.expected,
          actual: divergence.actual,
          detail: `treasury ledger divergence (${divergence.asset})`,
        },
        lowWatermarkSeq,
        createdAt: nowIso,
      };
      await deps.reconciliation.append(result);
      await raiseDivergence(deps, result);
      recorded += 1;
    }
    // RESOLVE: an asset that USED to diverge but now compares clean gets a
    // superseding `match`, or `canExpandTreasury` stays blocked forever on a
    // long-since-corrected balance.
    const allAssets = new Set([...ledger.map((l) => l.asset), ...Object.keys(read.value)]);
    for (const asset of allAssets) {
      if (divergentAssets.has(asset)) continue;
      const entityRef = `${deploymentId}:${walletAccountId}:${asset}`;
      const latest = await deps.reconciliation.latestForEntity('treasury', entityRef);
      if (latest?.outcome !== 'mismatch') continue; // nothing to clear
      await deps.reconciliation.append({
        resultId: deps.uuid(),
        deploymentId,
        entityType: 'treasury',
        entityRef,
        outcome: 'match',
        severity: null,
        details: { asset, detail: `treasury ledger resolved (${asset})` },
        lowWatermarkSeq,
        createdAt: nowIso,
      });
    }
  }
  return recorded;
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
 * §28.3 expansion gate across EVERY ACTIVE deployment — the shape a caller that
 * holds a room, not a deployment, actually needs.
 *
 * `requestWsmModeTransition` gates a ROOM's escalation into (or within) the
 * production modes, and there is no room→deployment mapping: a room's real
 * assets can move through any active deployment.  So the honest bound is the
 * conservative one — an unexplained divergence ANYWHERE the room's funds could
 * be flowing blocks expansion, which is the direction §28.3 asks a gate to fail
 * in.  Inactive (frozen/retired) deployments are excluded: they accept no new
 * submits, so an unresolved mismatch there cannot describe an expansion that is
 * about to happen, and including them would leave a retired deployment blocking
 * every room for ever.
 */
export async function canExpandAnyActiveDeployment(
  deps: Pick<ReconciliationDeps, 'reconciliation'> & {
    deployments: { list(): Promise<ReadonlyArray<{ deploymentId: string; status: string }>> };
  },
): Promise<{ allowed: boolean; blocking: number }> {
  const deployments = await deps.deployments.list();
  let blocking = 0;
  for (const deployment of deployments) {
    if (deployment.status !== 'active') continue;
    const { blocking: count } = await canExpandTreasury(deps, deployment.deploymentId);
    blocking += count;
  }
  return { allowed: blocking === 0, blocking };
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
  // The TOTAL in-flight fund-movement AMOUNT per asset.  A timing shortfall is
  // only "explained" (downgraded to informational) up to that amount — a delta
  // LARGER than the pending movement stays a real divergence, and an open
  // non-balance action (proposal_sign/charter_update) contributes 0 (WS-L.3.4b).
  inFlightByAsset: ReadonlyMap<string, string>,
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
    // Downgrade to informational ONLY when the divergence magnitude is within the
    // pending in-flight amount for this asset — a bigger unexplained gap is still
    // a real divergence even if a smaller movement is in flight.
    const inFlight = inFlightByAsset.get(asset) ?? '0';
    const explainedByInFlight =
      decCompare(magnitude, inFlight) <= 0 && decCompare(inFlight, '0') > 0;
    divergences.push({
      asset,
      expected,
      actual,
      severity: classifyDivergence(magnitude, criticalThreshold, explainedByInFlight),
    });
  }
  return divergences;
}

/** Exact non-negative decimal subtraction (a ≥ b) for divergence magnitude. */
function subtract(a: string, b: string): string {
  // decSum handles signed strings via its parser; reuse it with a negated b.
  return decSum([a, `-${b}`]);
}
