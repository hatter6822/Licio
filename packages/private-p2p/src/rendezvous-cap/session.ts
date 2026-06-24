// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the rendezvous-cap SESSION orchestration (the device + admin lifecycle).
//
// Pure, stateful wrappers that tie the credential primitives into the per-epoch flow,
// WITHOUT yet threading them through the MLS commit (the room engine plugs into these):
//
//   • RendezvousIssuer — the per-epoch committing admin. Holds the BBS issuer secret key,
//     blind-signs each member's request, and exposes the issuer PUBLIC key to distribute
//     over the MLS-protected channel + to the relay (first-seen pin).
//   • RendezvousMember — a device. Holds the long-lived `nid` secret; per epoch it creates
//     a blind credential request (→ the admin), installs the returned credential, and then
//     builds presence announcements + the issuer key for poll-filtering.
//
// Issuance is BLIND: the issuer never learns `nid` (§6.2/§7). A device not yet enrolled for
// an epoch simply announces nothing here (the caller rides Tier-1 — fail-open, §6.10).

import type { BbsKeyPair } from '../crypto/bbs/signature.js';
import {
  assembleCredential,
  type CredentialRequest,
  createCredentialRequest,
  generateIssuerKeyPair,
  generateNidSecret,
  issueCredential,
  issuerKeyFromBytes,
  issuerKeyToBytes,
  proveRendezvousPresence,
  type RendezvousCredential,
  type RendezvousPresence,
  rendezvousContext,
} from './credential.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * The per-epoch issuer (the committing admin). Generate one per epoch; distribute
 * `publicKey` to members (over MLS) + let it reach the relay via the first announce.
 */
export class RendezvousIssuer {
  private constructor(
    private readonly keyPair: BbsKeyPair,
    readonly epoch: string,
  ) {}

  /** Generate a fresh per-epoch issuer key pair for `epoch`. */
  static generate(epoch: string): RendezvousIssuer {
    return new RendezvousIssuer(generateIssuerKeyPair(), epoch);
  }

  /** The issuer PUBLIC key `ipk_e` (96-byte G2) — distribute to members + the relay. */
  get publicKey(): Uint8Array {
    return issuerKeyToBytes(this.keyPair.pk);
  }

  /** Blind-sign a member's credential request → the 80-byte credential. Never sees `nid`. */
  issue(request: CredentialRequest): Uint8Array {
    return issueCredential(this.keyPair, request, enc(this.epoch));
  }
}

/** A device's per-epoch credential state (installed after issuance). */
interface EpochEnrollment {
  readonly issuerPubKey: Uint8Array;
  readonly credential: RendezvousCredential;
}

/**
 * A device's rendezvous-cap state: the long-lived `nid` + its per-epoch credentials. Drives
 * enrollment (request → install) and produces presence announcements + the issuer key for
 * client-side poll-filtering.
 */
export class RendezvousMember {
  private readonly pending = new Map<string, CredentialRequest>();
  private readonly enrolled = new Map<string, EpochEnrollment>();

  /** `nid` persists for the life of the device across epochs. */
  constructor(private readonly nidSecret: Uint8Array = generateNidSecret()) {}

  /** Create + remember a blind credential request for `epoch` (send the commitment to the
   *  admin). The commitment reveals no `nid`. */
  beginEnrollment(epoch: string): CredentialRequest {
    const request = createCredentialRequest(this.nidSecret);
    this.pending.set(epoch, request);
    return request;
  }

  /** Install the admin's blind signature + the issuer key for `epoch`. */
  completeEnrollment(epoch: string, signature: Uint8Array, issuerPubKey: Uint8Array): void {
    const request = this.pending.get(epoch);
    if (request === undefined) throw new Error('rendezvous-cap: no pending request for epoch');
    // Validate the issuer key encoding up front (throws on a malformed key).
    issuerKeyFromBytes(issuerPubKey);
    this.enrolled.set(epoch, {
      issuerPubKey,
      credential: assembleCredential(this.nidSecret, request, signature),
    });
    this.pending.delete(epoch);
  }

  /** Whether this device holds a credential for `epoch`. */
  isEnrolled(epoch: string): boolean {
    return this.enrolled.has(epoch);
  }

  /**
   * Build a presence announcement (proof + pseudonym) for `(roomBlindId, epoch, bucket)`,
   * or `null` if not enrolled for the epoch (the caller then rides Tier-1).
   */
  announce(roomBlindId: Uint8Array, epoch: string, bucket: number): RendezvousPresence | null {
    const enrollment = this.enrolled.get(epoch);
    if (enrollment === undefined) return null;
    const context = rendezvousContext(roomBlindId, enc(epoch), bucket);
    return proveRendezvousPresence(
      issuerKeyFromBytes(enrollment.issuerPubKey),
      enrollment.credential,
      enc(epoch),
      context,
    );
  }

  /** The issuer public key for `epoch` (to verify peers' announces), or `null`. */
  issuerKey(epoch: string): Uint8Array | null {
    return this.enrolled.get(epoch)?.issuerPubKey ?? null;
  }

  /** Drop the credential + pending request for an epoch (on rotation/eviction cleanup). */
  forgetEpoch(epoch: string): void {
    this.enrolled.delete(epoch);
    this.pending.delete(epoch);
  }
}
