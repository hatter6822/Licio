// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.5.2a — the treasury side of three-source reconciliation, consuming the
// shipped WS-L machinery.  Per (treasury, asset) the worker snapshots:
//
//   1. the PRODUCT LEDGER — finalized deposit-class intents minus finalized
//      payout-class intents (the WS-M intent store);
//   2. KNOMOSIS RECEIPTS — the same sums restricted to intents whose finality
//      receipt was actually written (WS-L.3.4c);
//   3. the OBSERVED stream — restricted to intents whose action record carries
//      an INDEXED gateway/on-chain event (WS-L.3.3), the mediated third source
//      under the v0.4 gateway contract.
//
// The result is ZERO-OR-EXPLAINED (§28.3): a gap equal to zero is `synced`
// (and republishes the dashboard balance snapshot); a non-zero gap fully
// attributable to SETTLEMENT LAG — intents finalized within the grace window
// whose receipt or event linkage has not caught up yet, plus in-flight
// movements at the confirmed→finalized boundary — is `explained`, with the
// concrete intent ids in the explanation payload.  A gap larger than the lag
// can explain, or one carried by intents OLDER than the grace window (a
// receipt that never arrived is an incomplete audit trail, exactly what
// WS-L.3.4a flags as a mismatch), is `divergent` — a critical alert, the
// treasury row marked divergent, and a HARD BLOCK on cap/mode expansion
// (consumed by the WS-M.1.1b transition gate).  Snapshots are append-only.

import { decCompare, decSub, decSum } from '@licio/governance';
import { appendChainedAudit } from './audit-chain.js';
import type { IntentDeps } from './intents.js';
import type {
  PaymentIntentRecord,
  PaymentIntentStore,
  SnapshotRecord,
  SnapshotStore,
} from './stores.js';

/** Walk a treasury's complete intent history (keyset pages of 1,000). */
export async function allIntentsForTreasury(
  intents: PaymentIntentStore,
  treasuryId: string,
): Promise<PaymentIntentRecord[]> {
  const all: PaymentIntentRecord[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await intents.listByTreasuryPage(treasuryId, after, 1_000);
    all.push(...page);
    if (page.length < 1_000) return all;
    after = page[page.length - 1]?.paymentIntentId ?? null;
    if (after === null) return all;
  }
}

export interface TreasuryReconciliationDeps extends IntentDeps {
  snapshots: SnapshotStore;
  alert: (event: string, meta: Record<string, unknown>) => void;
  /** How long receipt/event linkage may lag a finalized intent before the gap
   *  stops being explainable (default: one reconciliation cadence). */
  reconciliationGraceMs: () => number;
}

const DEPOSIT_TARGETS = new Set(['treasury_deposit', 'bounty_contribution']);

/** Signed contribution of one intent to a balance (+deposit / −payout). */
function signedAmount(intent: PaymentIntentRecord): string {
  return DEPOSIT_TARGETS.has(intent.targetType) ? intent.amount : `-${intent.amount}`;
}

function absDiff(a: string, b: string): string {
  // decSub (not decSum([a, `-${b}`])): when `b` is already a negative balance
  // string, string-concatenating a sign builds an unparseable `--` literal and
  // reconcileTreasury would throw.  A balance source is negative whenever payouts
  // exceed deposits, so this path is reachable.
  const diff = decSub(a, b);
  return diff.startsWith('-') ? diff.slice(1) : diff;
}

function maxDec(values: string[]): string {
  return values.reduce((acc, v) => (decCompare(v, acc) > 0 ? v : acc), '0');
}

/**
 * Reconcile ONE treasury across every asset it has ever moved.  Returns the
 * appended snapshots.  Runs after every sequenced treasury action and on the
 * scheduler cadence (WS-M.5.2a).
 */
export async function reconcileTreasury(
  deps: TreasuryReconciliationDeps,
  treasuryId: string,
): Promise<SnapshotRecord[]> {
  const treasury = await deps.treasuries.getById(treasuryId);
  if (treasury === null) return [];
  // The treasury's FULL intent history via keyset pages — a fixed newest-N
  // slice would silently drop older finalized rows from the product ledger
  // and mask real divergences on busy treasuries.
  const intents = await allIntentsForTreasury(deps.intents, treasuryId);
  const assets = new Set<string>([...treasury.acceptedAssets, ...intents.map((i) => i.asset)]);
  const snapshots: SnapshotRecord[] = [];
  const observedBalances: Record<string, string> = {};
  let anyDivergent = false;
  let anyExplained = false;

  const graceCutoffMs = deps.now() - deps.reconciliationGraceMs();
  for (const asset of assets) {
    const ofAsset = intents.filter((intent) => intent.asset === asset);
    const finalized = ofAsset.filter((intent) => intent.executionState === 'finalized');
    const productLedger = decSum(finalized.map(signedAmount));
    const receipted = decSum(
      finalized.filter((intent) => intent.receiptId !== null).map(signedAmount),
    );
    // Source 3: only finalized intents whose action record carries an INDEXED
    // event count as observed (the gateway-mediated stream).  While walking,
    // classify every linkage gap as RECENT lag (explainable) or PERSISTENT
    // (a real divergence — the receipt/indexer never caught up).
    const observedParts: string[] = [];
    const laggedIntentIds: string[] = [];
    const laggedTotalParts: string[] = [];
    let persistentGap = false;
    for (const intent of finalized) {
      const action =
        intent.actionRecordId === null ? null : await deps.actions.getById(intent.actionRecordId);
      const indexed = action !== null && action.indexedEventRef !== null;
      if (indexed) observedParts.push(signedAmount(intent));
      const missingLinkage = intent.receiptId === null || !indexed;
      if (missingLinkage) {
        if (Date.parse(intent.updatedAt) >= graceCutoffMs) {
          laggedIntentIds.push(intent.paymentIntentId);
          laggedTotalParts.push(intent.amount);
        } else {
          persistentGap = true;
        }
      }
    }
    const observed = decSum(observedParts);
    observedBalances[asset] = observed;

    const inFlight = ofAsset.filter((intent) =>
      ['submitted', 'pending', 'confirmed'].includes(intent.executionState),
    );
    const inFlightTotal = decSum(inFlight.map((intent) => intent.amount));
    const laggedTotal = decSum(laggedTotalParts);
    const explainable = decSum([laggedTotal, inFlightTotal]);
    const gap = maxDec([
      absDiff(productLedger, receipted),
      absDiff(productLedger, observed),
      absDiff(receipted, observed),
    ]);

    let result: SnapshotRecord['result'];
    let explanation: Record<string, unknown> | null = null;
    // A zero NET gap is not enough: old finalized movements whose receipt/
    // event linkage never arrived can offset each other to zero while the
    // audit trail stays incomplete (WS-L.3.4a) — any persistent missing
    // linkage blocks `synced` regardless of the arithmetic.
    if (decCompare(gap, 0) === 0 && !persistentGap) {
      result = 'synced';
    } else if (
      !persistentGap &&
      decCompare(explainable, '0') > 0 &&
      decCompare(gap, explainable) <= 0
    ) {
      // Explained REQUIRES the concrete items (WS-M.5.2a: an `explained`
      // result must reference what explains it, never a bare label).
      result = 'explained';
      explanation = {
        cause: 'settlement_lag',
        lagged_payment_intent_ids: laggedIntentIds,
        in_flight_payment_intent_ids: inFlight.map((intent) => intent.paymentIntentId),
        explainable_total: explainable,
      };
    } else {
      result = 'divergent';
      anyDivergent = true;
    }
    if (result === 'explained') anyExplained = true;

    const snapshot: SnapshotRecord = {
      snapshotId: deps.uuid(),
      treasuryId,
      asset,
      productLedgerBalance: productLedger,
      receiptsBalance: receipted,
      onchainObservedBalance: observed,
      gap,
      explanation,
      result,
      observedAt: new Date(deps.now()).toISOString(),
    };
    await deps.snapshots.append(snapshot);
    snapshots.push(snapshot);
  }

  // Publish the treasury-level state: any divergent asset marks the treasury
  // divergent (the expansion blocker); explained-only keeps it pending; fully
  // synced republishes the OBSERVED balances as the dashboard snapshot.
  const nowIso = new Date(deps.now()).toISOString();
  if (anyDivergent) {
    await deps.treasuries.setReconciliation(treasuryId, 'divergent', null, null);
    deps.alert('wsm.treasury.reconciliation_divergent', {
      treasury_id: treasuryId,
      room_id: treasury.roomId,
      action: 'treasury_freeze_review_requested',
    });
  } else if (anyExplained) {
    await deps.treasuries.setReconciliation(treasuryId, 'pending', null, null);
  } else {
    await deps.treasuries.setReconciliation(treasuryId, 'synced', observedBalances, nowIso);
  }
  await appendChainedAudit(deps, {
    roomId: treasury.roomId,
    actionType: 'reconciliation_snapshot',
    actorUserId: null,
    details: {
      treasury_id: treasuryId,
      results: snapshots.map((s) => ({ asset: s.asset, result: s.result, gap: s.gap })),
    },
    treasuryId,
  });
  return snapshots;
}

/** §28.3: cap/mode expansion is allowed only with no unexplained divergence. */
export async function canExpandWsmTreasury(
  deps: Pick<TreasuryReconciliationDeps, 'treasuries'>,
  roomId: string,
): Promise<{ allowed: boolean; reason: string | null }> {
  const treasury = await deps.treasuries.getByRoom(roomId);
  if (treasury === null) return { allowed: true, reason: null }; // nothing to diverge
  return treasury.reconciliationState === 'divergent'
    ? {
        allowed: false,
        reason: 'The treasury has an unexplained reconciliation divergence (§28.3).',
      }
    : { allowed: true, reason: null };
}
