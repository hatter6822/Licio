// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Re-audit finding 5 (catch-proof regression): admitJoinRequest must DERIVE the reducer
// device id from the proof-bound Ed25519 signing key — base64url(SHA-256(pubkey)) — NOT
// trust the joiner-chosen MLS KeyPackage credential identity (which the joiner fully
// controls, and MLS dedups only by signature key).  Otherwise a joiner could pick a
// device_id that desyncs the reducer from MLS or mis-targets a §10.9 removal.  The admit
// path fail-closed rejects (a) a KeyPackage whose identity ≠ the derived id and (b) a
// derived id that collides with an existing device.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PrivateRoomSession } from '../room-manager.js';

const FUTURE = '2099-01-01T00:00:00Z';

async function storeFactory(): Promise<(roomId: string) => unknown> {
  const p2p = await import('@licio/private-p2p');
  return () => new p2p.InMemoryPrivateRoomStorage();
}

// The same coarse bucket coarseBucket() produces (bound into the join-request proof).
function bucket(): string {
  return new Date().toISOString().slice(0, 13);
}

beforeEach(() => {
  indexedDB.deleteDatabase('licio_private_p2p');
});

describe('re-audit finding 5 — admitJoinRequest binds device_id to the proof-bound signing key', () => {
  it('REJECTS a join request whose KeyPackage identity ≠ the derived device id', async () => {
    const p2p = await import('@licio/private-p2p');
    const store = await storeFactory();
    const founder = await PrivateRoomSession.create({
      roomName: 'R',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: store as (roomId: string) => never,
    });

    // A real invite for the joiner's HPKE key.
    const hpke = await p2p.generateRecipientKeyPair();
    const { invite, inviteUrl } = await founder.createInvite({
      inviteePublicKey: p2p.toBase64Url(hpke.publicKey),
      expiresAt: FUTURE,
    });
    const fragment = inviteUrl.slice(inviteUrl.indexOf('#invite=') + '#invite='.length);
    const opened = await p2p.openInvite(hpke.privateKey, hpke.publicKey, fragment);

    // A VALID proof over the joiner's signing key — but a KeyPackage whose credential
    // identity is attacker-chosen (NOT base64url(SHA-256(signingKey))).
    const signing = await p2p.generateDeviceSigningKeyPair(false);
    const signingPub = p2p.toBase64Url(await p2p.exportPublicKeyRaw(signing.publicKey));
    const forgedKp = await p2p.generateMemberKeyPackage(p2p.utf8('attacker-chosen-id'));
    const request = await p2p.buildJoinRequest({
      invite: opened,
      keyPackage: forgedKp.publicPackage,
      deviceSigningPublicKey: signingPub,
      proposedDisplayName: 'Mallory',
      requestedAtBucket: bucket(),
    });

    const { verdict, grant } = await founder.admitJoinRequest(invite, request);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('malformed_key_package');
    expect(grant).toBeUndefined();
    // No device was admitted (only the founder remains).
    expect(founder.state().devices.size).toBe(1);
  });

  it('REJECTS a second device whose derived id COLLIDES with an existing device', async () => {
    const p2p = await import('@licio/private-p2p');
    const store = await storeFactory();
    const founder = await PrivateRoomSession.create({
      roomName: 'R',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: store as (roomId: string) => never,
    });

    // One joiner signing key → one derived device id (base64url(SHA-256(pubkey))).
    const signing = await p2p.generateDeviceSigningKeyPair(false);
    const signingPub = p2p.toBase64Url(await p2p.exportPublicKeyRaw(signing.publicKey));
    const derivedId = p2p.toBase64Url(await p2p.sha256(p2p.fromBase64Url(signingPub)));

    // Admit using a fresh invite + a KeyPackage (its identity = the derived id).  Reused for
    // both attempts; the second uses a DIFFERENT MLS leaf so the MLS Add itself succeeds and
    // the collision is what rejects it.
    const admit = async (keyPackage: unknown) => {
      const hpke = await p2p.generateRecipientKeyPair();
      const { invite, inviteUrl } = await founder.createInvite({
        inviteePublicKey: p2p.toBase64Url(hpke.publicKey),
        expiresAt: FUTURE,
      });
      const fragment = inviteUrl.slice(inviteUrl.indexOf('#invite=') + '#invite='.length);
      const opened = await p2p.openInvite(hpke.privateKey, hpke.publicKey, fragment);
      const request = await p2p.buildJoinRequest({
        invite: opened,
        keyPackage: keyPackage as never,
        deviceSigningPublicKey: signingPub,
        proposedDisplayName: 'Mallory',
        requestedAtBucket: bucket(),
      });
      return founder.admitJoinRequest(invite, request);
    };

    // First device joins legitimately.
    const kp1 = await p2p.generateMemberKeyPackage(p2p.utf8(derivedId));
    const first = await admit(kp1.publicPackage);
    expect(first.verdict.ok).toBe(true);
    expect(founder.state().devices.has(derivedId)).toBe(true);

    // Second request reuses the SAME signing key → SAME derived id → collision.
    const kp2 = await p2p.generateMemberKeyPackage(p2p.utf8(derivedId));
    const second = await admit(kp2.publicPackage);
    expect(second.verdict.ok).toBe(false);
    if (!second.verdict.ok) expect(second.verdict.reason).toBe('malformed_key_package');
  });
});
