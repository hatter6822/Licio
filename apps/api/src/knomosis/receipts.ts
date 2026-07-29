// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3.4c — receipt pairing and public/private receipts (SPEC §29.5, §23.5,
// §19.5).  After an action reaches a stable state, TWO receipts exist:
//
//  - PUBLIC: for the room's audit log.  Payload fields are PROJECTED through
//    an explicit allowlist (action type, room, amount where policy makes it
//    public, tx reference = the typed-data hash, state) — never a civic
//    identity, never an address, never any §19.5 "never on-chain" field.  The
//    projection (`projectPublicReceiptPayload`) is the enforcement, not a
//    convention: an unlisted key cannot survive it, and a listed key cannot be
//    dropped without a compile error.  Tested by asserting the payload's key
//    set equals the allowlist and that an extra field cannot pass through.
//
//  - PRIVATE: owner-scoped and exportable (tax/accounting).  It carries the
//    full signed-field disclosure the owner already saw and signed.
//
// Both pair the human-readable summary to the machine payload (§23.5), and
// both UPDATE when a reorg flips the outcome (WS-L.3.3b).  The pairing is TWO
// checks, not one hash: `summaryPayloadHash` binds the summary to the signed
// `typedDataHash` (and must stay equal to the PREFLIGHT hash the user saw, so
// the payload cannot be folded into it), while `verifyReceiptPairing`
// RE-DERIVES the payload from the action record and compares it field for
// field.  Without the second check a stored or exported payload could have its
// room, amount or state rewritten and still verify.

import { canonicalJson, getTypedDataStruct } from '@licio/shared';
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

export type PublicReceiptField = (typeof PUBLIC_RECEIPT_FIELDS)[number];

/**
 * Project a candidate payload THROUGH the allowlist — the structural half of
 * the §19.5 guarantee.
 *
 * The allowlist previously existed only as a documented constant: the public
 * payload was an object literal that happened to agree with it, so nothing
 * stopped a later edit from adding a civic identity, an address, or any other
 * "never on-chain" field to the room's PUBLIC audit log. Building the payload
 * here makes the leak unrepresentable in two directions at once:
 *
 *   • only listed keys survive the projection (an unlisted key cannot egress
 *     even if a caller supplies one), and
 *   • the `Record<PublicReceiptField, unknown>` parameter makes every listed
 *     field REQUIRED, so removing one is a compile error rather than a
 *     silently-thinner receipt.
 */
export function projectPublicReceiptPayload(
  candidate: Readonly<Record<PublicReceiptField, unknown>>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of PUBLIC_RECEIPT_FIELDS) payload[field] = candidate[field];
  return payload;
}

/**
 * The PUBLIC payload an action record implies, built through the allowlist.
 *
 * Extracted so that writing a receipt and VERIFYING one derive the payload the
 * same way. Verification re-derives rather than trusting the stored copy,
 * which is what makes a stored receipt tamper-EVIDENT rather than merely
 * well-formed at creation: every field here comes from the action record,
 * whose `typedDataHash` is what the actor signed.
 */
export function buildPublicReceiptPayload(
  record: KnomosisActionRecordEntity,
  finalState: string,
): Record<string, unknown> {
  const message = record.signedAction.message;
  return projectPublicReceiptPayload({
    action_type: record.actionType,
    room_id: record.roomId,
    asset: message['asset'] ?? null,
    amount: message['amount'] ?? null,
    tx_ref: record.typedDataHash,
    state: finalState,
    created_at: record.createdAt,
  });
}

/** The PRIVATE payload: the public projection plus the owner-only disclosure. */
export function buildPrivateReceiptPayload(
  record: KnomosisActionRecordEntity,
  finalState: string,
  updatedAt: string,
): Record<string, unknown> {
  const message = record.signedAction.message;
  return {
    ...buildPublicReceiptPayload(record, finalState),
    action_record_id: record.actionRecordId,
    deployment_id: record.deploymentId,
    nonce: message['nonce'] ?? null,
    expiration: message['expiration'] ?? null,
    signed_fields: message,
    failure_reason: record.failureReason,
    updated_at: updatedAt,
  };
}

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

  // Built THROUGH the allowlist (never as a free object literal): the
  // projection is what actually enforces "no civic identity, no address, no
  // §19.5 field" on the room's public audit log. The same builders are what
  // verification re-derives from, so the two can never drift.
  const publicPayload = buildPublicReceiptPayload(record, finalState);
  const privatePayload = buildPrivateReceiptPayload(record, finalState, nowIso);

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

/**
 * Verify a receipt's summary↔payload pairing (§23.5; used by tests + export).
 *
 * TWO independent checks, because `summaryPayloadHash` alone cannot make a
 * stored receipt tamper-evident:
 *
 *  1. The SUMMARY pairing — the hash must equal `sha256(typedDataHash ⧺
 *     summary)`. This is deliberately independent of the payload so that a
 *     forwarded action's receipt hash equals the PREFLIGHT hash the user saw
 *     before signing (WS-L.3.4c / O2); folding the payload in would break that
 *     equality, which is why the payload is checked separately rather than
 *     mixed into this hash.
 *
 *  2. The PAYLOAD itself, RE-DERIVED from the action record and compared field
 *     for field. The hash covers the summary and the typed-data hash only, so
 *     without this an exported or stored payload could have its `room_id`,
 *     `amount` or `state` rewritten and still verify — the module header
 *     claimed the summary was paired to the machine payload, and this is what
 *     makes that true. The record is the trustworthy side: its `typedDataHash`
 *     is what the actor actually signed.
 *
 * `updated_at` is taken from the receipt ROW rather than from its own payload,
 * so a payload whose copy of it disagrees with the row is rejected too.
 */
export function verifyReceiptPairing(
  receipt: KnomosisReceiptRecord,
  record: KnomosisActionRecordEntity,
): boolean {
  const paired =
    receipt.summaryPayloadHash ===
    pairSummaryToPayload(receiptSummary(record, receipt.finalState), record.typedDataHash);
  if (!paired) return false;
  const expected =
    receipt.kind === 'public'
      ? buildPublicReceiptPayload(record, receipt.finalState)
      : buildPrivateReceiptPayload(record, receipt.finalState, receipt.updatedAt);
  return canonicalJson(expected) === canonicalJson(receipt.payload);
}
