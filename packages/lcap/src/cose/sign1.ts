// SPDX-License-Identifier: AGPL-3.0-or-later
//
// COSE_Sign1 detached-payload proofs (OFFLINE_SPEC §10.2).  The signed payload
// is the deterministic record body (the same bytes that produced `record_cid`),
// so an off-the-shelf COSE_Sign1 verifier interoperates, while `record_cid`
// binds the proof to a stable identity that is independent of the signature
// bytes (§5.1) — one body MAY carry several proofs (device + witnesses) without
// changing its identity.
//
//   protected   = LDC({1: -7})                         // alg ES256, signed
//   Sig_structure = ["Signature1", protected, external_aad, record_body]
//   ToBeSigned  = LDC(Sig_structure)
//   signature   = ECDSA-low-S(priv, SHA-256, ToBeSigned)

import { decode } from '../cbor/decode.js';
import { compareBytes, encode } from '../cbor/encode.js';
import type { LdcKey, LdcValue } from '../cbor/types.js';
import { cidFor } from '../cid/index.js';
import { buildExternalAad, domainSeparator } from './aad.js';
import { checkCanonicalSignature, signEs256, verifyEs256Raw } from './ecdsa.js';
import { resolveSuiteByAlg } from './suites.js';

/** The three proof kinds carried by `DetachedProofV2.proof_kind` (§10.2). */
export type ProofKind = 'device_signature' | 'authority_signature' | 'witness_signature';

const COSE_ALG_LABEL = 1;
const ES256_COSE_ALG = -7;
/** COSE_Sign1 context string for the `Sig_structure` (RFC 9052 §4.4). */
const SIGN1_CONTEXT = 'Signature1';
/** Object kind used in a proof's domain separator (§9.5). */
const PROOF_OBJECT_KIND = 'proof';

/**
 * A detached ES256 proof (§10.2).  This is the proof shape produced/consumed by
 * the codec layer; the `schemas/` layer adds the closed zod validation and the
 * optional `cose_unprotected` / `created_at_claim_ms` / `proof_scope` fields.
 */
export interface DetachedProofV2 {
  readonly proof_version: 2;
  readonly proof_kind: ProofKind;
  readonly record_cid: string;
  readonly record_kind: string;
  readonly cose_protected: Uint8Array;
  readonly external_aad: Uint8Array;
  readonly signature: Uint8Array;
  readonly signer_key_id: string;
}

function buildProtectedHeader(coseAlg: number): Uint8Array {
  // The algorithm lives ONLY in the protected (signed) header (§10.2.1).
  return encode(new Map<LdcKey, LdcValue>([[COSE_ALG_LABEL, coseAlg]]));
}

function buildToBeSigned(
  coseProtected: Uint8Array,
  externalAad: Uint8Array,
  recordBody: Uint8Array,
): Uint8Array {
  const sigStructure: LdcValue[] = [SIGN1_CONTEXT, coseProtected, externalAad, recordBody];
  return encode(sigStructure);
}

export interface BuildAndSignParams {
  readonly privateKey: CryptoKey;
  readonly signerKeyId: string;
  readonly proofKind: ProofKind;
  readonly recordKind: string;
  /** The deterministic record body bytes (the §9.2 CID preimage). */
  readonly recordBody: Uint8Array;
  readonly networkId: string;
}

/**
 * Build and sign a detached ES256 proof over `recordBody`.  The returned
 * proof's `record_cid` equals `cidFor('record', recordBody)`, and the signed
 * `ToBeSigned` is exactly the §10.2.3 layout.
 */
export async function buildAndSign(params: BuildAndSignParams): Promise<DetachedProofV2> {
  const coseProtected = buildProtectedHeader(ES256_COSE_ALG);
  const separator = domainSeparator(params.networkId, PROOF_OBJECT_KIND, params.proofKind);
  const externalAad = buildExternalAad({
    separator,
    networkId: params.networkId,
    recordKind: params.recordKind,
    proofKind: params.proofKind,
  });
  const toBeSigned = buildToBeSigned(coseProtected, externalAad, params.recordBody);
  const signature = await signEs256(params.privateKey, toBeSigned);
  const recordCid = await cidFor('record', params.recordBody);
  return {
    proof_version: 2,
    proof_kind: params.proofKind,
    record_cid: recordCid,
    record_kind: params.recordKind,
    cose_protected: coseProtected,
    external_aad: externalAad,
    signature,
    signer_key_id: params.signerKeyId,
  };
}

/** The subset of `ObjectStatusV2.status` (§16.11) a proof check can emit. */
export type VerifyStatus =
  | 'rejected_bad_cid'
  | 'rejected_bad_signature'
  | 'rejected_high_s_signature';

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: VerifyStatus };

export interface VerifyParams {
  readonly networkId: string;
  readonly expectedRecordKind: string;
}

/**
 * Verify a detached proof against the record body and the signer's public key,
 * executing the §10.2.4 six steps in order with exact status mapping:
 *  1. recompute `record_cid` and compare        → `rejected_bad_cid`
 *  2. parse the protected header; require a known, enabled, non-downgraded alg
 *                                                → `rejected_bad_signature`
 *  3. rebuild `external_aad` from local params and byte-compare
 *                                                → `rejected_bad_signature`
 *  4. rebuild `Sig_structure` / `ToBeSigned`
 *  5. canonical low-S check                      → `rejected_high_s_signature`
 *  6. ECDSA verify                               → `rejected_bad_signature`
 */
export async function verifyDetached(
  proof: DetachedProofV2,
  recordBody: Uint8Array,
  publicKey: CryptoKey,
  params: VerifyParams,
): Promise<VerifyResult> {
  // Step 1 — record_cid binding.
  const recomputed = await cidFor('record', recordBody);
  if (recomputed !== proof.record_cid) return { ok: false, status: 'rejected_bad_cid' };

  // Step 2 — algorithm: known, enabled, non-downgraded (no stripping to the
  // unprotected header, since the alg is read only from the protected header).
  let header: LdcValue;
  try {
    header = decode(proof.cose_protected);
  } catch {
    return { ok: false, status: 'rejected_bad_signature' };
  }
  if (!(header instanceof Map)) return { ok: false, status: 'rejected_bad_signature' };
  const alg = header.get(COSE_ALG_LABEL);
  if (typeof alg !== 'number') return { ok: false, status: 'rejected_bad_signature' };
  if (!resolveSuiteByAlg(alg).ok) return { ok: false, status: 'rejected_bad_signature' };

  // Step 3 — rebuild external_aad from LOCAL expectations and byte-compare.  A
  // proof minted for a different network / record kind / proof kind embeds a
  // different AAD and is rejected here.
  let rebuiltAad: Uint8Array;
  try {
    const separator = domainSeparator(params.networkId, PROOF_OBJECT_KIND, proof.proof_kind);
    rebuiltAad = buildExternalAad({
      separator,
      networkId: params.networkId,
      recordKind: params.expectedRecordKind,
      proofKind: proof.proof_kind,
    });
  } catch {
    return { ok: false, status: 'rejected_bad_signature' };
  }
  if (compareBytes(rebuiltAad, proof.external_aad) !== 0) {
    return { ok: false, status: 'rejected_bad_signature' };
  }

  // Step 4 — rebuild ToBeSigned exactly as the signer did.
  const toBeSigned = buildToBeSigned(proof.cose_protected, proof.external_aad, recordBody);

  // Step 5 — canonical low-S (range + low-S); non-canonical → high-S status.
  const canonical = checkCanonicalSignature(proof.signature);
  if (!canonical.ok) {
    return {
      ok: false,
      status:
        canonical.reason === 'malformed' ? 'rejected_bad_signature' : 'rejected_high_s_signature',
    };
  }

  // Step 6 — cryptographic verification.
  const valid = await verifyEs256Raw(publicKey, toBeSigned, proof.signature);
  return valid ? { ok: true } : { ok: false, status: 'rejected_bad_signature' };
}
