// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Revocation authority verification (OFFLINE_SPEC §11.5, WS-R.1.4).  A revocation is
// only trustworthy when an AUTHORITY signs it, and only an authority with jurisdiction
// over the revoked target may revoke it: an account authority signs device / account /
// proof revocations (the account that owns the device/proof), a room authority signs
// capability / room_policy revocations (the room whose policy granted them).  Indexing an
// unsigned or wrong-scope revocation would let any peer deny service to an arbitrary
// device, account, or capability (§27 DoS) — so a server runs this verifier BEFORE
// `RevocationIndex.index`.  Pure: the caller injects the authority-key resolver and
// performs the index write only on `ok`.

import { type DetachedProofV2, verifyDetached } from '../cose/sign1.js';
import type { RevocationRecordV2 } from '../schemas/records.js';
import type { RevokedKind } from './revocation.js';

/** Which authority class may sign a revocation of `kind` (§11.5). */
export type RevocationAuthorityScope = 'account' | 'room';

/**
 * Capability + room_policy revocations are governed by the room's authority; device,
 * account, and proof revocations are governed by the owning account's authority.
 */
export function revocationAuthorityScope(kind: RevokedKind): RevocationAuthorityScope {
  return kind === 'capability' || kind === 'room_policy' ? 'room' : 'account';
}

/** A registered authority key plus the scope + id it is authoritative for. */
export interface RevocationAuthorityBinding {
  readonly key: CryptoKey;
  readonly scope: RevocationAuthorityScope;
  /** The account id (account scope) or room id (room scope) this key governs. */
  readonly scopeId: string;
}

export type RevocationAuthorityStatus =
  | 'rejected_wrong_proof_kind'
  | 'rejected_missing_scope_binding'
  | 'rejected_unknown_authority'
  | 'rejected_authority_scope_mismatch'
  | 'rejected_bad_authority_proof';

export type RevocationAuthorityResult =
  | { readonly ok: true; readonly scope: RevocationAuthorityScope; readonly scopeId: string }
  | { readonly ok: false; readonly status: RevocationAuthorityStatus };

export interface VerifyRevocationAuthorityParams {
  readonly revocation: RevocationRecordV2;
  /** The deterministic LDC revocation body the proof covers (its `record_cid` preimage). */
  readonly body: Uint8Array;
  readonly proof: DetachedProofV2;
  /** Resolve a registered authority binding by the proof's `signer_key_id`. */
  readonly resolveAuthority: (signerKeyId: string) => RevocationAuthorityBinding | undefined;
  readonly networkId: string;
}

/**
 * Verify that `proof` is an `authority_signature` over the revocation body by a key with
 * jurisdiction over the revoked target.  The required scope follows from `revoked_kind`;
 * the revocation must name its governing id (`account_id` for account scope, `room_id` for
 * room scope), and the resolved authority's `(scope, scopeId)` must match it exactly
 * before the COSE signature is checked.  Returns the discharged scope on success.
 */
export async function verifyRevocationAuthority(
  params: VerifyRevocationAuthorityParams,
): Promise<RevocationAuthorityResult> {
  const { revocation, body, proof } = params;
  if (proof.proof_kind !== 'authority_signature') {
    return { ok: false, status: 'rejected_wrong_proof_kind' };
  }
  const scope = revocationAuthorityScope(revocation.revoked_kind);
  const scopeId = scope === 'account' ? revocation.account_id : revocation.room_id;
  if (scopeId === undefined) return { ok: false, status: 'rejected_missing_scope_binding' };
  const authority = params.resolveAuthority(proof.signer_key_id);
  if (!authority) return { ok: false, status: 'rejected_unknown_authority' };
  if (authority.scope !== scope || authority.scopeId !== scopeId) {
    return { ok: false, status: 'rejected_authority_scope_mismatch' };
  }
  const verified = await verifyDetached(proof, body, authority.key, {
    networkId: params.networkId,
    expectedRecordKind: 'revocation',
  });
  if (!verified.ok) return { ok: false, status: 'rejected_bad_authority_proof' };
  return { ok: true, scope, scopeId };
}
