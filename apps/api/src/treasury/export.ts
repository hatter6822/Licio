// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.5.2b — the accounting/tax export.  Rows are generated ONLY from
// settled intent history (finalized deposits/disbursements, post-submission
// reversals); assets whose LATEST reconciliation snapshot is divergent are
// EXCLUDED and counted in `excluded_unreconciled` — flagged, never silently
// included.  Values are event-time records (the quote captured on the intent),
// never live rates; USD equivalents are null until a rate oracle ships (an
// honest null beats a fabricated valuation).  Access control (stewards +
// authorized finance/compliance staff) is enforced at the route.

import type { AccountingExportResponse, AccountingExportRow } from '@licio/shared';
import { type TreasuryGovernanceError, tgErr } from './profile.js';
import type { PaymentIntentStore, SnapshotStore, TreasuryStore } from './stores.js';
import { allIntentsForTreasury } from './treasury-reconciliation.js';

export interface ExportDeps {
  treasuries: TreasuryStore;
  intents: PaymentIntentStore;
  snapshots: SnapshotStore;
  now: () => number;
}

const DEPOSIT_TARGETS = new Set(['treasury_deposit', 'bounty_contribution']);
/** Post-submission states that represent a reversal for accounting purposes. */
const REVERSAL_STATES = new Set(['reverted', 'reorged']);

export async function buildAccountingExport(
  deps: ExportDeps,
  input: { roomId: string; periodStartIso: string; periodEndIso: string },
): Promise<TreasuryGovernanceError | { ok: true; export: AccountingExportResponse }> {
  const treasury = await deps.treasuries.getByRoom(input.roomId);
  if (treasury === null) return tgErr(404, 'no_treasury', 'This room has no treasury.');
  const startMs = Date.parse(input.periodStartIso);
  const endMs = Date.parse(input.periodEndIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    return tgErr(400, 'invalid_period', 'The export period is invalid.');
  }

  // Reconciliation status per asset (the latest snapshot decides inclusion).
  const assetResult = new Map<string, 'synced' | 'explained' | 'divergent'>();
  // The FULL history via keyset pages — a newest-N slice would silently drop
  // rows from older export periods on busy treasuries (tax records must be
  // complete or explicitly excluded, never truncated).
  const intents = await allIntentsForTreasury(deps.intents, treasury.treasuryId);
  for (const asset of new Set(intents.map((intent) => intent.asset))) {
    const latest = await deps.snapshots.latestByTreasuryAsset(treasury.treasuryId, asset);
    // NO snapshot yet ⇒ the asset has never passed zero-or-explained
    // reconciliation: its rows are EXCLUDED + counted, never exported on faith.
    assetResult.set(asset, latest?.result ?? 'divergent');
  }

  const rows: AccountingExportRow[] = [];
  let excluded = 0;
  for (const intent of intents) {
    const occurredMs = Date.parse(intent.updatedAt);
    if (occurredMs < startMs || occurredMs >= endMs) continue;
    const isFinalized = intent.executionState === 'finalized';
    const isReversal = REVERSAL_STATES.has(intent.executionState);
    if (!isFinalized && !isReversal) continue;
    const result = assetResult.get(intent.asset) ?? 'explained';
    if (result === 'divergent') {
      excluded += 1;
      continue; // flagged via excluded_unreconciled, never silently included
    }
    rows.push({
      event_kind: isReversal
        ? 'reversal'
        : DEPOSIT_TARGETS.has(intent.targetType)
          ? 'deposit'
          : 'disbursement',
      receipt_id: intent.receiptId,
      tx_hash: null, // populated once the indexer exposes per-intent hashes
      asset: intent.asset,
      amount: intent.amount,
      usd_equivalent_at_event: null,
      category: DEPOSIT_TARGETS.has(intent.targetType) ? null : intent.targetType,
      reconciliation_result: result,
      occurred_at: intent.updatedAt,
    });
  }
  rows.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return {
    ok: true,
    export: {
      treasury_id: treasury.treasuryId,
      period_start: new Date(startMs).toISOString(),
      period_end: new Date(endMs).toISOString(),
      export_schema_version: 1,
      rows,
      excluded_unreconciled: excluded,
    },
  };
}
