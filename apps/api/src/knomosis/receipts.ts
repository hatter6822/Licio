// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3.4c — receipt pairing and public/private receipts (SPEC §29.5, §23.5,
// §19.5).  After an action reaches a stable state, TWO receipts exist:
//
//  - PUBLIC: for the room's audit log.  Payload fields come from an EXPLICIT
//    allowlist (action type, room, amount where policy makes it public, tx
//    reference = the typed-data hash, state) — never a civic identity, never
//    an address, never any §19.5 "never on-chain" field.  Tested by asserting
//    the payload's key set is a subset of the allowlist.
//
//  - PRIVATE: owner-scoped and exportable (tax/accounting).  It carries the
//    full signed-field disclosure the owner already saw and signed.
//
// Both pair the human-readable summary to the machine payload by hash
// (§23.5), and both UPDATE when a reorg flips the outcome (WS-L.3.3b).

import { getTypedDataStruct } from '@licio/shared';
import { pairSummaryToPayload } from './preflight.js';
import type {
  KnomosisActionRecordEntity,
  KnomosisReceiptRecord,
  KnomosisReceiptStore,
} from './stores.js';

/** The COMPLETE public-receipt field allowlist (WS-L.3.4c). */
export const PUBLIC_RECEIPT_FIELDS = [
  'action_type',
  'room_id',
  'asset',
  'amount',
  'tx_ref',
  'state',
  'created_at',
] as const;

export interface ReceiptDeps {
  receipts: KnomosisReceiptStore;
  now: () => number;
  uuid: () => string;
}

/** The summary the receipt pairs to its payload.  A forwarded action carries the
 *  EXACT `preflightSummary` the user saw and signed, so the receipt's
 *  `summary_payload_hash` matches the preflight hash and genuinely audits what was
 *  shown before signing (WS-L.3.4c / O2).  Only a pre-O2 / non-forwarded row lacks
 *  it, and falls back to a state-derived summary. */
function receiptSummary(record: KnomosisActionRecordEntity, finalState: string): string {
  if (record.preflightSummary !== undefined) return record.preflightSummary;
  const struct = getTypedDataStruct(record.actionType);
  const name = struct?.actionName ?? record.actionType;
  return `${name} — ${finalState} (${record.typedDataHash.slice(0, 10)}…)`;
}

/** Produce/refresh BOTH receipts for an action's (new) stable state. */
export async function writeReceipts(
  deps: ReceiptDeps,
  record: KnomosisActionRecordEntity,
): Promise<{ publicReceipt: KnomosisReceiptRecord; privateReceipt: KnomosisReceiptRecord }> {
  const nowIso = new Date(deps.now()).toISOString();
  const finalState = record.submissionState;
  const summary = receiptSummary(record, finalState);
  const message = record.signedAction.message;

  const publicPayload: Record<string, unknown> = {
    action_type: record.actionType,
    room_id: record.roomId,
    asset: message['asset'] ?? null,
    amount: message['amount'] ?? null,
    tx_ref: record.typedDataHash,
    state: finalState,
    created_at: record.createdAt,
  };

  const privatePayload: Record<string, unknown> = {
    ...publicPayload,
    action_record_id: record.actionRecordId,
    deployment_id: record.deploymentId,
    nonce: message['nonce'] ?? null,
    expiration: message['expiration'] ?? null,
    signed_fields: message,
    failure_reason: record.failureReason,
    updated_at: nowIso,
  };

  const hash = pairSummaryToPayload(summary, record.typedDataHash);

  const publicReceipt = await deps.receipts.upsert({
    receiptId: deps.uuid(),
    actionRecordId: record.actionRecordId,
    kind: 'public',
    payload: publicPayload,
    summaryPayloadHash: hash,
    ownerUserId: null,
    finalState,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const privateReceipt = await deps.receipts.upsert({
    receiptId: deps.uuid(),
    actionRecordId: record.actionRecordId,
    kind: 'private',
    payload: privatePayload,
    summaryPayloadHash: hash,
    ownerUserId: record.actorUserId,
    finalState,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  return { publicReceipt, privateReceipt };
}

/** Verify a receipt's summary↔payload pairing (§23.5; used by tests + export). */
export function verifyReceiptPairing(
  receipt: KnomosisReceiptRecord,
  record: KnomosisActionRecordEntity,
): boolean {
  return (
    receipt.summaryPayloadHash ===
    pairSummaryToPayload(receiptSummary(record, receipt.finalState), record.typedDataHash)
  );
}
