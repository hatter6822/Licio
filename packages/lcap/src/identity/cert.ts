// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Device certificate issuance + verification (OFFLINE_SPEC §11.1, §11.2,
// WS-R.1.1).  The Licio account authority (WS-D) signs an `authority_signature`
// proof binding `account_id ↔ device_key_id`; the device's own signing key is
// generated locally and never exported (§10.5).  A certificate is UNTRUSTED
// without a valid authority proof, and its validity window + `account_epoch` are
// enforced at verification time.

import { buildAndSign, type DetachedProofV2, verifyDetached } from '../cose/sign1.js';
import { encodeWithSchema } from '../schemas/codec.js';
import {
  type DeviceCertificateRecordV2,
  deviceCertificateRecordV2Schema,
} from '../schemas/records.js';

/** A certificate plus the bytes its proof covers and that proof. */
export interface CertificateBundle {
  readonly certificate: DeviceCertificateRecordV2;
  /** The deterministic LDC body that `proof.record_cid` addresses. */
  readonly body: Uint8Array;
  readonly proof: DetachedProofV2;
}

export interface IssueCertificateParams {
  /** The account-authority private signing key (WS-D-provisioned). */
  readonly authorityPrivateKey: CryptoKey;
  readonly authoritySignerKeyId: string;
  readonly certificate: DeviceCertificateRecordV2;
  readonly networkId: string;
}

/** Encode + authority-sign a device certificate, returning the full bundle. */
export async function issueDeviceCertificate(
  params: IssueCertificateParams,
): Promise<CertificateBundle> {
  const body = encodeWithSchema(deviceCertificateRecordV2Schema, params.certificate);
  const proof = await buildAndSign({
    privateKey: params.authorityPrivateKey,
    signerKeyId: params.authoritySignerKeyId,
    proofKind: 'authority_signature',
    recordKind: 'device_certificate',
    recordBody: body,
    networkId: params.networkId,
  });
  return { certificate: params.certificate, body, proof };
}

export type CertVerifyStatus =
  | 'rejected_bad_authority_proof'
  | 'rejected_wrong_proof_kind'
  | 'rejected_not_yet_valid'
  | 'rejected_expired'
  | 'rejected_stale_account_epoch';

export interface CertVerified {
  readonly ok: true;
  readonly accountId: string;
  readonly deviceId: string;
  readonly deviceKeyId: string;
  readonly accountEpoch: number;
}

export type CertVerification =
  | CertVerified
  | { readonly ok: false; readonly status: CertVerifyStatus };

export interface CertVerifyContext {
  readonly networkId: string;
  readonly nowMs: number;
  /** Reject certificates issued below this account epoch (rotation floor). */
  readonly minAccountEpoch?: number;
}

/**
 * Verify a device certificate against the account-authority public key: the
 * `authority_signature` proof must verify over the certificate body, the proof
 * kind must be `authority_signature`, `nowMs` must lie in the validity window,
 * and `account_epoch` must be at/above the rotation floor.
 */
export async function verifyDeviceCertificate(
  bundle: CertificateBundle,
  authorityPublicKey: CryptoKey,
  ctx: CertVerifyContext,
): Promise<CertVerification> {
  const { certificate, body, proof } = bundle;
  if (proof.proof_kind !== 'authority_signature') {
    return { ok: false, status: 'rejected_wrong_proof_kind' };
  }
  const verified = await verifyDetached(proof, body, authorityPublicKey, {
    networkId: ctx.networkId,
    expectedRecordKind: 'device_certificate',
  });
  if (!verified.ok) return { ok: false, status: 'rejected_bad_authority_proof' };
  if (ctx.nowMs < certificate.not_before_ms) return { ok: false, status: 'rejected_not_yet_valid' };
  if (ctx.nowMs >= certificate.not_after_ms) return { ok: false, status: 'rejected_expired' };
  if (certificate.account_epoch < (ctx.minAccountEpoch ?? 0)) {
    return { ok: false, status: 'rejected_stale_account_epoch' };
  }
  return {
    ok: true,
    accountId: certificate.account_id,
    deviceId: certificate.device_id,
    deviceKeyId: certificate.device_key_id,
    accountEpoch: certificate.account_epoch,
  };
}
