// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the rendezvous-cap COORDINATOR: the pure bridge between the reducer ops
// (`rendezvous.request` / `rendezvous.issue`, §11) and the device/admin session. The
// carrier reads the engine's converged device commitments + accepted issuance op bodies and
// calls these to (admin) produce an issuance op body and (device) install its credential.
// Nothing here touches the network or the engine internals — it is data-in/data-out.

import { fromBase64Url, toBase64Url } from '../crypto/runtime.js';
import type { RendezvousIssuer, RendezvousMember } from './session.js';

/** A device's published commitment (the converged `DeviceState.rendezvousCommitment`). */
export interface DeviceCommitment {
  readonly deviceId: string;
  /** base64url of the blind commitment-with-proof. */
  readonly commitmentWithProof: string;
}

/** The body of a `rendezvous.issue` op (the carrier authors this through the engine). */
export interface IssuanceOpBody {
  readonly target_epoch: number;
  /** base64url of the per-epoch BBS issuer public key. */
  readonly issuer_public_key: string;
  /** Each device's blind signature (base64url). */
  readonly credentials: ReadonlyArray<{ readonly device_id: string; readonly signature: string }>;
}

/**
 * ADMIN: blind-sign every device commitment for `epoch`, producing a `rendezvous.issue` op
 * body. `skipDeviceIds` are devices already credentialed for this epoch (so re-issuance is
 * incremental for late joiners). A malformed / bad-PoK commitment is skipped (the device
 * re-publishes). Returns `null` when there is nothing to issue.
 */
export function buildIssuanceOpBody(
  issuer: RendezvousIssuer,
  epoch: number,
  commitments: readonly DeviceCommitment[],
  skipDeviceIds: ReadonlySet<string> = new Set(),
): IssuanceOpBody | null {
  const credentials: Array<{ device_id: string; signature: string }> = [];
  for (const c of commitments) {
    if (skipDeviceIds.has(c.deviceId)) continue;
    try {
      const signature = issuer.issueForCommitment(fromBase64Url(c.commitmentWithProof));
      credentials.push({ device_id: c.deviceId, signature: toBase64Url(signature) });
    } catch {
      // a malformed encoding or an invalid commitment PoK ⇒ skip (no credential issued)
    }
  }
  if (credentials.length === 0) return null;
  return {
    target_epoch: epoch,
    issuer_public_key: toBase64Url(issuer.publicKey),
    credentials,
  };
}

/**
 * DEVICE: install this device's credential for `epoch` from the accepted `rendezvous.issue`
 * op bodies (the LATEST matching one wins, so a re-issuance supersedes). Returns whether a
 * credential was installed.
 */
export function installFromIssuances(
  member: RendezvousMember,
  deviceId: string,
  epoch: number,
  issuances: readonly IssuanceOpBody[],
): boolean {
  if (member.isEnrolled(String(epoch))) return true; // idempotent: verified once, then cached
  for (let i = issuances.length - 1; i >= 0; i--) {
    const issuance = issuances[i];
    if (issuance === undefined || issuance.target_epoch !== epoch) continue;
    const cred = issuance.credentials.find((c) => c.device_id === deviceId);
    if (cred === undefined) continue;
    try {
      member.installCredential(
        String(epoch),
        fromBase64Url(cred.signature),
        fromBase64Url(issuance.issuer_public_key),
      );
      return true;
    } catch {
      // a malformed/stale credential (fails verification) ⇒ try an EARLIER issuance; if none
      // verify for this device's current nid, stay unenrolled (ride Tier-1).
    }
  }
  return false;
}
