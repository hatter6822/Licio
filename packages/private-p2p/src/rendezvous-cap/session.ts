// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the rendezvous-cap SESSION orchestration (the device + admin lifecycle).
//
// Pure, stateful wrappers that tie the credential primitives into the per-epoch flow the
// room engine drives (the `rendezvous.request` / `rendezvous.issue` ops):
//
//   • RendezvousIssuer — the per-epoch committing admin. Holds the BBS issuer secret key,
//     blind-signs each device's PUBLISHED commitment (it never holds the device's
//     `secret_prover_blind`), and exposes the issuer PUBLIC key to distribute.
//   • RendezvousMember — a device. Holds the long-lived `nid` + ONE blind credential request
//     (commitment + `s'`); it publishes the commitment ONCE (a `rendezvous.request`), then
//     installs the admin's per-epoch signature (from a `rendezvous.issue`) and builds
//     presence announcements + exposes the issuer key for client-side poll-filtering.
//
// Issuance is BLIND: the issuer never learns `nid` (§6.2/§7). A device not enrolled for an
// epoch announces nothing here (the caller rides Tier-1 — fail-open, §6.10).

import type { BbsKeyPair } from '../crypto/bbs/signature.js';
import {
  assembleCredential,
  type CredentialRequest,
  createCredentialRequest,
  deriveIssuerKeyPair,
  generateIssuerKeyPair,
  generateNidSecret,
  issueCredentialForCommitment,
  issuerKeyFromBytes,
  issuerKeyToBytes,
  proveRendezvousPresence,
  type RendezvousCredential,
  type RendezvousPresence,
  rendezvousContext,
  verifyRendezvousCredential,
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

  /** Derive the per-epoch issuer DETERMINISTICALLY from a stable seed — so the admin's issuer
   *  public key is reproducible across reloads + re-issuances (persist ONE seed, not a key
   *  per epoch). */
  static fromSeed(seed: Uint8Array, epoch: string): RendezvousIssuer {
    return new RendezvousIssuer(deriveIssuerKeyPair(seed, enc(epoch)), epoch);
  }

  /** The issuer PUBLIC key `ipk_e` (96-byte G2) — distribute to members + the relay. */
  get publicKey(): Uint8Array {
    return issuerKeyToBytes(this.keyPair.pk);
  }

  /** Blind-sign a device's PUBLISHED commitment → the 80-byte credential. Never sees `nid`. */
  issueForCommitment(commitmentWithProof: Uint8Array): Uint8Array {
    return issueCredentialForCommitment(this.keyPair, commitmentWithProof, enc(this.epoch));
  }
}

/** A device's per-epoch credential state (installed after issuance). */
interface EpochEnrollment {
  readonly issuerPubKey: Uint8Array;
  readonly credential: RendezvousCredential;
}

/**
 * A device's rendezvous-cap state: the long-lived `nid` + ONE blind credential request,
 * plus the per-epoch credentials installed from the admin's signatures.
 */
export class RendezvousMember {
  private readonly request: CredentialRequest;
  private readonly enrolled = new Map<string, EpochEnrollment>();

  /** `nid` (and thus the commitment + `s'`) persist for the life of the device. */
  constructor(private readonly nidSecret: Uint8Array = generateNidSecret()) {
    this.request = createCredentialRequest(nidSecret);
  }

  /** The blind commitment to publish ONCE in a `rendezvous.request` op (reveals no `nid`). */
  get commitment(): Uint8Array {
    return this.request.commitmentWithProof;
  }

  /** Install the admin's per-epoch blind signature + the issuer key for `epoch`. Verifies the
   *  credential against THIS device's current `nid` first — a stale (post-`nid`-rotation) or
   *  corrupt issuance throws, so the caller stays unenrolled (rides Tier-1) rather than
   *  building shows that fail at peers. */
  installCredential(epoch: string, signature: Uint8Array, issuerPubKey: Uint8Array): void {
    const issuerPk = issuerKeyFromBytes(issuerPubKey); // validates the key encoding
    if (
      !verifyRendezvousCredential(
        issuerPk,
        signature,
        this.nidSecret,
        this.request.secretProverBlind,
        enc(epoch),
      )
    ) {
      throw new Error('rendezvous-cap: credential failed verification for this device');
    }
    this.enrolled.set(epoch, {
      issuerPubKey,
      credential: assembleCredential(this.nidSecret, this.request, signature),
    });
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

  /** Drop the credential for an epoch (on rotation/eviction cleanup). */
  forgetEpoch(epoch: string): void {
    this.enrolled.delete(epoch);
  }
}
