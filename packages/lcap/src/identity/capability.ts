// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Room capability issuance + verification (OFFLINE_SPEC §11.3, WS-R.1.2).  The
// room authority signs an `authority_signature` proof over the capability body;
// `operations` / `visibility_scope` / `room_id` gate which records the
// capability can authorize, `quotas` and `transfer_policy` bound offline use,
// and the capability validates only within its window.  The
// `revocation_epoch_floor` it carries is consumed by trust projection (the
// verifier's known revocation epoch must reach it), not rejected here.

import { buildAndSign, type DetachedProofV2, verifyDetached } from '../cose/sign1.js';
import { encodeWithSchema } from '../schemas/codec.js';
import type { LcapOperation, LcapVisibilityScope } from '../schemas/common.js';
import { type CapabilityRecordV2, capabilityRecordV2Schema } from '../schemas/records.js';

/** A capability plus the bytes its proof covers and that proof. */
export interface CapabilityBundle {
  readonly capability: CapabilityRecordV2;
  readonly body: Uint8Array;
  readonly proof: DetachedProofV2;
}

export interface IssueCapabilityParams {
  /** The room-authority private signing key (distinct from the account authority). */
  readonly authorityPrivateKey: CryptoKey;
  readonly authoritySignerKeyId: string;
  readonly capability: CapabilityRecordV2;
  readonly networkId: string;
}

/** Encode + authority-sign a room capability, returning the full bundle. */
export async function issueCapability(params: IssueCapabilityParams): Promise<CapabilityBundle> {
  const body = encodeWithSchema(capabilityRecordV2Schema, params.capability);
  const proof = await buildAndSign({
    privateKey: params.authorityPrivateKey,
    signerKeyId: params.authoritySignerKeyId,
    proofKind: 'authority_signature',
    recordKind: 'room_capability',
    recordBody: body,
    networkId: params.networkId,
  });
  return { capability: params.capability, body, proof };
}

export type CapabilityVerifyStatus =
  | 'rejected_bad_authority_proof'
  | 'rejected_wrong_proof_kind'
  | 'rejected_not_yet_valid'
  | 'rejected_expired';

export type CapabilityVerification =
  | { readonly ok: true; readonly capability: CapabilityRecordV2 }
  | { readonly ok: false; readonly status: CapabilityVerifyStatus };

export interface CapabilityVerifyContext {
  readonly networkId: string;
  readonly nowMs: number;
}

/** Verify a capability's authority proof and validity window. */
export async function verifyCapability(
  bundle: CapabilityBundle,
  authorityPublicKey: CryptoKey,
  ctx: CapabilityVerifyContext,
): Promise<CapabilityVerification> {
  const { capability, body, proof } = bundle;
  if (proof.proof_kind !== 'authority_signature') {
    return { ok: false, status: 'rejected_wrong_proof_kind' };
  }
  const verified = await verifyDetached(proof, body, authorityPublicKey, {
    networkId: ctx.networkId,
    expectedRecordKind: 'room_capability',
  });
  if (!verified.ok) return { ok: false, status: 'rejected_bad_authority_proof' };
  if (ctx.nowMs < capability.not_before_ms) return { ok: false, status: 'rejected_not_yet_valid' };
  if (ctx.nowMs >= capability.not_after_ms) return { ok: false, status: 'rejected_expired' };
  return { ok: true, capability };
}

export type AuthorizationDenial =
  | 'room_mismatch'
  | 'visibility_denied'
  | 'operation_denied'
  | 'subject_mismatch';

/** What a record needs the capability to authorize. */
export interface AuthorizationRequest {
  readonly roomId: string;
  readonly visibilityScope: LcapVisibilityScope;
  readonly operation: LcapOperation;
  readonly subjectAccountId: string;
  readonly subjectDeviceKeyId: string;
}

/**
 * Decide whether a capability authorizes a specific record's operation/scope.
 * A capability scoped to `public` authorizes only `public` records; an `in_room`
 * capability authorizes `public` or `in_room`; a `private` capability authorizes
 * any scope (it is the WS-S ciphertext plane and never reaches a server story).
 */
export function capabilityAuthorizes(
  capability: CapabilityRecordV2,
  request: AuthorizationRequest,
): { readonly ok: true } | { readonly ok: false; readonly denial: AuthorizationDenial } {
  if (
    capability.subject_account_id !== request.subjectAccountId ||
    capability.subject_device_key_id !== request.subjectDeviceKeyId
  ) {
    return { ok: false, denial: 'subject_mismatch' };
  }
  if (capability.room_id !== request.roomId) return { ok: false, denial: 'room_mismatch' };
  if (!visibilityAllowed(capability.visibility_scope, request.visibilityScope)) {
    return { ok: false, denial: 'visibility_denied' };
  }
  if (!capability.operations.includes(request.operation)) {
    return { ok: false, denial: 'operation_denied' };
  }
  return { ok: true };
}

const VISIBILITY_RANK: Readonly<Record<LcapVisibilityScope, number>> = {
  public: 0,
  in_room: 1,
  private: 2,
};

/** A capability of scope `cap` authorizes records of an equal-or-narrower scope. */
function visibilityAllowed(cap: LcapVisibilityScope, record: LcapVisibilityScope): boolean {
  return VISIBILITY_RANK[record] <= VISIBILITY_RANK[cap];
}
