// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the rendezvous-cap session lifecycle: admin issues (blind) → device
// enrolls → device announces → a peer poll-filters. The end-to-end device/admin
// orchestration the MLS commit flow plugs into.

import { describe, expect, it } from 'vitest';
import {
  currentBucket,
  filterVerifiedPresence,
  issuerKeyFromBytes,
  pseudonymToBytes,
  RendezvousIssuer,
  RendezvousMember,
  rendezvousContext,
  type VerifiablePresence,
} from '../index.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const ROOM = enc('room-blind-id');
const NOW = 1_700_000_000_000;
const BUCKET = currentBucket(NOW);

/** Enroll a member under `admin` for `epoch` (publish commitment → blind-sign → install). */
function enroll(member: RendezvousMember, admin: RendezvousIssuer, epoch: string): void {
  member.installCredential(epoch, admin.issueForCommitment(member.commitment), admin.publicKey);
}

describe('Tier-2 rendezvous-cap session', () => {
  const EPOCH = 'epoch-9';

  it('issue (blind) → enroll → announce → peer poll-filter verifies', () => {
    const admin = RendezvousIssuer.generate(EPOCH);
    const alice = new RendezvousMember();
    const bob = new RendezvousMember();
    enroll(alice, admin, EPOCH);
    enroll(bob, admin, EPOCH);

    const presence = alice.announce(ROOM, EPOCH, BUCKET);
    expect(presence).not.toBeNull();
    // Bob (a peer holding the same issuer key) verifies Alice's announce client-side.
    const record: VerifiablePresence<string> = {
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      pseudonym: pseudonymToBytes(presence!.pseudonym),
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      proof: presence!.proof,
      epoch: EPOCH,
      bucket: BUCKET,
      value: 'alice',
    };
    const issuerKey = bob.issuerKey(EPOCH);
    expect(issuerKey).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
    const verified = filterVerifiedPresence([record], issuerKeyFromBytes(issuerKey!), ROOM, {
      nowMs: NOW,
    });
    expect(verified.map((v) => v.value)).toEqual(['alice']);
  });

  it('issuance is BLIND — the admin signs a commitment, never the device nid', () => {
    // issueForCommitment accepts the device's PUBLISHED commitment only; there is no
    // parameter through which `nid` or `secret_prover_blind` could reach the admin.
    const admin = RendezvousIssuer.generate(EPOCH);
    const member = new RendezvousMember();
    expect(() => admin.issueForCommitment(member.commitment)).not.toThrow();
    // the issuer public key is a stable 96-byte G2 encoding
    expect(admin.publicKey).toHaveLength(96);
  });

  it('a device not enrolled for an epoch announces nothing (rides Tier-1)', () => {
    const member = new RendezvousMember();
    expect(member.isEnrolled(EPOCH)).toBe(false);
    expect(member.announce(ROOM, EPOCH, BUCKET)).toBeNull();
  });

  it('a credential under a DIFFERENT issuer does not verify against this room', () => {
    const roomAdmin = RendezvousIssuer.generate(EPOCH);
    const otherAdmin = RendezvousIssuer.generate(EPOCH);
    const outsider = new RendezvousMember();
    enroll(outsider, otherAdmin, EPOCH); // credentialed by a different issuer

    const presence = outsider.announce(ROOM, EPOCH, BUCKET);
    expect(presence).not.toBeNull();
    const record: VerifiablePresence<string> = {
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null
      pseudonym: pseudonymToBytes(presence!.pseudonym),
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null
      proof: presence!.proof,
      epoch: EPOCH,
      bucket: BUCKET,
      value: 'outsider',
    };
    // verified against the ROOM admin's key → rejected
    expect(
      filterVerifiedPresence([record], issuerKeyFromBytes(roomAdmin.publicKey), ROOM, {
        nowMs: NOW,
      }),
    ).toHaveLength(0);
  });

  it('holds independent credentials across epochs; forgetEpoch clears one', () => {
    const e1 = 'epoch-1';
    const e2 = 'epoch-2';
    const a1 = RendezvousIssuer.generate(e1);
    const a2 = RendezvousIssuer.generate(e2);
    const member = new RendezvousMember();
    enroll(member, a1, e1);
    enroll(member, a2, e2);
    expect(member.isEnrolled(e1)).toBe(true);
    expect(member.isEnrolled(e2)).toBe(true);
    // a per-bucket pseudonym differs across epochs (independent issuer keys + contexts)
    const p1 = member.announce(ROOM, e1, BUCKET);
    const p2 = member.announce(ROOM, e2, BUCKET);
    const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
    // biome-ignore lint/style/noNonNullAssertion: both enrolled
    expect(hex(pseudonymToBytes(p1!.pseudonym))).not.toBe(hex(pseudonymToBytes(p2!.pseudonym)));
    member.forgetEpoch(e1);
    expect(member.isEnrolled(e1)).toBe(false);
    expect(member.isEnrolled(e2)).toBe(true);
  });
});
