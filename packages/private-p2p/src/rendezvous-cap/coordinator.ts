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
 * The CANONICAL Tier-2 issuer key for `epoch` (PRIV-CAP-3): the `issuer_public_key` of the EARLIEST
 * (first-reduced / lowest-Lamport) `rendezvous.issue` op for that epoch.  The op log reduces
 * byte-identically on every device, so ALL devices agree on ONE issuer key per `(room, epoch)`.
 * `issuances` MUST be in reduced (Lamport) order — the engine's `rendezvousIssuances()` is.  Returns
 * `undefined` when no issuance for the epoch exists yet (the device rides Tier-1).
 */
export function canonicalIssuerKey(
  epoch: number,
  issuances: readonly IssuanceOpBody[],
): string | undefined {
  return issuances.find((i) => i.target_epoch === epoch)?.issuer_public_key;
}

/**
 * DEVICE: install this device's credential for `epoch` from the accepted `rendezvous.issue` op
 * bodies, CONVERGING on the canonical issuer key (PRIV-CAP-3).  Without convergence a multi-admin or
 * seed-regenerated room fragments into per-issuer keys — a legit peer's cap would then fail to verify
 * at a peer that installed a DIFFERENT admin's key, silently DENYING capped discovery instead of
 * riding Tier-1.  So: install ONLY a credential issued under the canonical key; re-install when the
 * already-enrolled key differs from canonical (e.g. a credential installed earlier under a
 * later-superseded key, or out-of-order op delivery); and drop a stale enrollment that has no
 * canonical-key credential so this device never announces under a key peers will reject.  Returns
 * whether a canonical credential is now installed.
 */
export function installFromIssuances(
  member: RendezvousMember,
  deviceId: string,
  epoch: number,
  issuances: readonly IssuanceOpBody[],
): boolean {
  const epochStr = String(epoch);
  const canonical = canonicalIssuerKey(epoch, issuances);
  if (canonical === undefined) {
    member.forgetEpoch(epochStr); // no issuance for this epoch yet ⇒ drop any stale enroll, ride Tier-1
    return false;
  }
  // Idempotent ONLY when already enrolled under the CANONICAL key.
  const enrolledKey = member.issuerKey(epochStr);
  if (enrolledKey !== null && toBase64Url(enrolledKey) === canonical) return true;
  // (Re)install this device's credential, but ONLY from an issuance under the canonical key (the
  // LATEST canonical-key issuance wins, so an incremental re-issuance supersedes).
  for (let i = issuances.length - 1; i >= 0; i--) {
    const issuance = issuances[i];
    if (issuance === undefined || issuance.target_epoch !== epoch) continue;
    if (issuance.issuer_public_key !== canonical) continue; // ignore a non-canonical issuer's op
    const cred = issuance.credentials.find((c) => c.device_id === deviceId);
    if (cred === undefined) continue;
    try {
      member.installCredential(epochStr, fromBase64Url(cred.signature), fromBase64Url(canonical));
      return true;
    } catch {
      // a malformed/stale credential (fails verification for this device's nid) ⇒ try an EARLIER
      // canonical-key issuance.
    }
  }
  // No canonical-key credential for this device — drop any stale (non-canonical) enrollment so it
  // does NOT announce under a key peers will reject; it rides Tier-1 instead.
  member.forgetEpoch(epochStr);
  return false;
}
