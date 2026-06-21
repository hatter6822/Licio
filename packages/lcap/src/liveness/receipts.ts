// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Receipt records (OFFLINE_SPEC §20.4, WS-R.10.2).  A receipt authenticates its
// ISSUER and is an availability hint + audit evidence — it advances liveness and
// feeds the scarcity boost (WS-R.5.3) but NEVER raises content trust.  A
// forged-issuer receipt is simply an untrusted hint.

import { buildAndSign, type DetachedProofV2, verifyDetached } from '../cose/sign1.js';
import { encodeWithSchema } from '../schemas/codec.js';
import { type ReceiptRecordV2, receiptRecordV2Schema } from '../schemas/receipt.js';
import type { LivenessState } from './states.js';

export interface ReceiptBundle {
  readonly receipt: ReceiptRecordV2;
  readonly body: Uint8Array;
  readonly proof: DetachedProofV2;
}

/** Build + sign a receipt with the issuer node's key. */
export async function signReceipt(params: {
  issuerPrivateKey: CryptoKey;
  issuerSignerKeyId: string;
  receipt: ReceiptRecordV2;
  networkId: string;
}): Promise<ReceiptBundle> {
  const body = encodeWithSchema(receiptRecordV2Schema, params.receipt);
  const proof = await buildAndSign({
    privateKey: params.issuerPrivateKey,
    signerKeyId: params.issuerSignerKeyId,
    proofKind: 'authority_signature',
    recordKind: 'receipt',
    recordBody: body,
    networkId: params.networkId,
  });
  return { receipt: params.receipt, body, proof };
}

/** Verify a receipt's issuer signature (identifies the issuer; not content trust). */
export async function verifyReceipt(
  bundle: ReceiptBundle,
  issuerPublicKey: CryptoKey,
  ctx: { networkId: string },
): Promise<{ ok: true; issuerKeyId: string } | { ok: false }> {
  const verified = await verifyDetached(bundle.proof, bundle.body, issuerPublicKey, {
    networkId: ctx.networkId,
    expectedRecordKind: 'receipt',
  });
  return verified.ok ? { ok: true, issuerKeyId: bundle.proof.signer_key_id } : { ok: false };
}

/** The liveness state a receipt type advances a subject toward (§20.1/§20.4). */
export function livenessFromReceipt(
  receiptType: ReceiptRecordV2['receipt_type'],
  issuer: 'peer' | 'relay' | 'server',
): LivenessState | undefined {
  switch (receiptType) {
    case 'stored':
      return issuer === 'peer'
        ? 'peer_stored'
        : issuer === 'relay'
          ? 'relay_stored'
          : 'server_stored';
    case 'accepted':
      return 'server_accepted';
    case 'checkpointed':
      return 'checkpointed';
    default:
      return undefined; // rejected / quarantined / evicted do not advance liveness
  }
}
