// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tier-2 rendezvous-cap credential — the end-to-end cap over the BBS stack: a device
// requests a blind-issued per-epoch credential, proves presence emitting a per-(epoch,
// bucket) pseudonym, and the server verifies + dedups by it. Asserts server-blindness
// (the dedup key is the only identity-ish value), the cap (1 nym/device/bucket),
// cross-bucket unlinkability, revocation via epoch rotation, and non-member rejection.

import { describe, expect, it } from 'vitest';
import {
  assembleCredential,
  createCredentialRequest,
  generateIssuerKeyPair,
  generateNidSecret,
  issueCredential,
  PER_EPOCH_BUCKET,
  proveRendezvousPresence,
  pseudonymFromBytes,
  pseudonymToBytes,
  rendezvousContext,
  rendezvousPresentationHeader,
  verifyRendezvousPresence,
} from '../credential.js';

/** The announcement's dial identity a Tier-2 proof binds to (see `rendezvousPresentationHeader`). */
const BIND = new Uint8Array(32).fill(9);

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** Mint a device + its per-epoch credential under `issuer`. */
const enroll = (issuer: ReturnType<typeof generateIssuerKeyPair>, epoch: Uint8Array) => {
  const nidSecret = generateNidSecret();
  const request = createCredentialRequest(nidSecret); // device → admin (blind)
  const signature = issueCredential(issuer, request, epoch); // admin blind-signs
  return assembleCredential(nidSecret, request, signature);
};

describe('Tier-2 rendezvous-cap credential', () => {
  const roomBlindId = enc('room-blind-id-bucket-window');
  const epoch = enc('epoch-100');

  it('full flow: request → blind-issue → prove → server verifies + dedups', () => {
    const issuer = generateIssuerKeyPair();
    const cred = enroll(issuer, epoch);
    const ctx = rendezvousContext(roomBlindId, epoch, 3);
    const { proof, pseudonym } = proveRendezvousPresence(
      issuer.pk,
      cred,
      epoch,
      ctx,
      rendezvousPresentationHeader(BIND),
    );
    expect(
      verifyRendezvousPresence(
        issuer.pk,
        proof,
        pseudonym,
        epoch,
        ctx,
        rendezvousPresentationHeader(BIND),
      ),
    ).toBe(true);
    // the pseudonym round-trips through its wire form (the server's dedup key)
    expect(hex(pseudonymToBytes(pseudonymFromBytes(pseudonymToBytes(pseudonym))))).toBe(
      hex(pseudonymToBytes(pseudonym)),
    );
  });

  it('THE CAP: one device → one stable slot per bucket; unlinkable across buckets', () => {
    const issuer = generateIssuerKeyPair();
    const cred = enroll(issuer, epoch);
    const b3a = proveRendezvousPresence(
      issuer.pk,
      cred,
      epoch,
      rendezvousContext(roomBlindId, epoch, 3),
      rendezvousPresentationHeader(BIND),
    );
    const b3b = proveRendezvousPresence(
      issuer.pk,
      cred,
      epoch,
      rendezvousContext(roomBlindId, epoch, 3),
      rendezvousPresentationHeader(BIND),
    );
    const b4 = proveRendezvousPresence(
      issuer.pk,
      cred,
      epoch,
      rendezvousContext(roomBlindId, epoch, 4),
      rendezvousPresentationHeader(BIND),
    );
    // a re-announce in the same bucket yields the SAME pseudonym → the server keeps 1 slot
    expect(hex(pseudonymToBytes(b3a.pseudonym))).toBe(hex(pseudonymToBytes(b3b.pseudonym)));
    // the proofs themselves are randomized (unlinkable shows)
    expect(hex(b3a.proof)).not.toBe(hex(b3b.proof));
    // a different bucket → an independent, unlinkable pseudonym
    expect(hex(pseudonymToBytes(b3a.pseudonym))).not.toBe(hex(pseudonymToBytes(b4.pseudonym)));
  });

  it('two devices in the same bucket get two distinct slots (cap is per-device)', () => {
    const issuer = generateIssuerKeyPair();
    const ctx = rendezvousContext(roomBlindId, epoch, 3);
    const a = proveRendezvousPresence(
      issuer.pk,
      enroll(issuer, epoch),
      epoch,
      ctx,
      rendezvousPresentationHeader(BIND),
    );
    const b = proveRendezvousPresence(
      issuer.pk,
      enroll(issuer, epoch),
      epoch,
      ctx,
      rendezvousPresentationHeader(BIND),
    );
    expect(hex(pseudonymToBytes(a.pseudonym))).not.toBe(hex(pseudonymToBytes(b.pseudonym)));
    expect(
      verifyRendezvousPresence(
        issuer.pk,
        a.proof,
        a.pseudonym,
        epoch,
        ctx,
        rendezvousPresentationHeader(BIND),
      ),
    ).toBe(true);
    expect(
      verifyRendezvousPresence(
        issuer.pk,
        b.proof,
        b.pseudonym,
        epoch,
        ctx,
        rendezvousPresentationHeader(BIND),
      ),
    ).toBe(true);
  });

  it('revocation: a credential for one epoch does not verify in another (epoch rotation)', () => {
    const issuer = generateIssuerKeyPair();
    const cred = enroll(issuer, epoch); // issued for epoch-100
    const newEpoch = enc('epoch-101');
    const ctx = rendezvousContext(roomBlindId, newEpoch, 3);
    // showing the old credential against the new epoch fails (a removed device is not re-issued)
    const presence = proveRendezvousPresence(
      issuer.pk,
      cred,
      newEpoch,
      ctx,
      rendezvousPresentationHeader(BIND),
    );
    expect(
      verifyRendezvousPresence(
        issuer.pk,
        presence.proof,
        presence.pseudonym,
        newEpoch,
        ctx,
        rendezvousPresentationHeader(BIND),
      ),
    ).toBe(false);
  });

  it('non-member / wrong-issuer shows are rejected', () => {
    const issuer = generateIssuerKeyPair();
    const cred = enroll(issuer, epoch);
    const ctx = rendezvousContext(roomBlindId, epoch, 3);
    const { proof, pseudonym } = proveRendezvousPresence(
      issuer.pk,
      cred,
      epoch,
      ctx,
      rendezvousPresentationHeader(BIND),
    );
    // a credential blind-issued by a DIFFERENT issuer cannot pass against this issuer key
    const otherIssuer = generateIssuerKeyPair();
    expect(
      verifyRendezvousPresence(
        otherIssuer.pk,
        proof,
        pseudonym,
        epoch,
        ctx,
        rendezvousPresentationHeader(BIND),
      ),
    ).toBe(false);
    // wrong context (different room/bucket) is rejected
    expect(
      verifyRendezvousPresence(
        issuer.pk,
        proof,
        pseudonym,
        epoch,
        rendezvousContext(roomBlindId, epoch, 9),
        rendezvousPresentationHeader(BIND),
      ),
    ).toBe(false);
  });

  it('per-epoch granularity: one stable pseudonym across all buckets of an epoch', () => {
    const issuer = generateIssuerKeyPair();
    const cred = enroll(issuer, epoch);
    const a = proveRendezvousPresence(
      issuer.pk,
      cred,
      epoch,
      rendezvousContext(roomBlindId, epoch, PER_EPOCH_BUCKET),
      rendezvousPresentationHeader(BIND),
    );
    const b = proveRendezvousPresence(
      issuer.pk,
      cred,
      epoch,
      rendezvousContext(roomBlindId, epoch, PER_EPOCH_BUCKET),
      rendezvousPresentationHeader(BIND),
    );
    expect(hex(pseudonymToBytes(a.pseudonym))).toBe(hex(pseudonymToBytes(b.pseudonym)));
    expect(
      verifyRendezvousPresence(
        issuer.pk,
        a.proof,
        a.pseudonym,
        epoch,
        rendezvousContext(roomBlindId, epoch, PER_EPOCH_BUCKET),
        rendezvousPresentationHeader(BIND),
      ),
    ).toBe(true);
  });
});
