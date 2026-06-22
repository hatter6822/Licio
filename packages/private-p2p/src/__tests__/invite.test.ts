// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.2 — the §10.3 invite + §12.3 join flow: an admin mints + HPKE-seals an
// invite, the invitee opens it and proves invite knowledge, the admin verifies +
// admits the device (MLS Add), and the invitee joins — end-to-end, no transport.
import { describe, expect, it } from 'vitest';
import { deriveEpochState } from '../crypto/epoch.js';
import { generateRecipientKeyPair, openInvite, sealInvite } from '../crypto/hpke.js';
import { generateMemberKeyPackage } from '../crypto/mls.js';
import { fromBase64Url, toBase64Url, utf8 } from '../crypto/runtime.js';
import {
  buildJoinRequest,
  createRoomInvite,
  deriveJoinProof,
  verifyJoinRequest,
} from '../engine/invite.js';
import { createPrivateRoom, inviteDevice, joinRoom } from '../engine/room-lifecycle.js';
import { joinRequestSchema } from '../schemas/invite.js';

const PROFILE = { name: 'Quiet Room', room_type: 'global_topic' } as const;
const FUTURE = '2099-01-01T00:00:00Z';
const NOW = new Date('2026-06-22T00:00:00Z');
const BUCKET = '2026-06-22T00';

async function founded() {
  return createPrivateRoom({
    roomId: 'r',
    founderMemberId: 'alice',
    founderDeviceId: 'alice-dev',
    profile: PROFILE,
    createdAt: '2026-06-22T00:00:00Z',
  });
}

describe('§10.3 invite + §12.3 join flow', () => {
  it('mints → seals → opens → proves → admits → joins (converges)', async () => {
    const room = await founded();
    const bobHpke = await generateRecipientKeyPair();

    // Alice mints + HPKE-seals an invite to Bob's long-term key.
    const invite = createRoomInvite({
      roomPublicKey: room.manifest.crypto.room_public_key,
      grantedRole: 'member',
      expiresAt: FUTURE,
    });
    const sealed = await sealInvite(bobHpke.publicKey, invite);

    // Bob opens it and builds a proof-carrying join request.
    const opened = await openInvite(bobHpke.privateKey, bobHpke.publicKey, sealed);
    expect(opened.invite_id).toBe(invite.invite_id);
    const bobBundle = await generateMemberKeyPackage(utf8('bob-dev'));
    const joinReq = await buildJoinRequest({
      invite: opened,
      keyPackage: bobBundle.publicPackage,
      proposedDisplayName: 'Bob',
      requestedAtBucket: BUCKET,
    });

    // Alice verifies the request, then admits the verified KeyPackage.
    const verdict = await verifyJoinRequest(invite, joinReq, { now: NOW });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('expected ok');
    expect(verdict.grantedRole).toBe('member');

    const invited = await inviteDevice(room.group, verdict.keyPackage);
    const aliceEpoch1 = await deriveEpochState(
      invited.group,
      room.roomIdCommitment,
      room.manifestCommitment,
    );
    const bobJoin = await joinRoom({
      welcome: invited.welcome,
      bundle: bobBundle,
      ratchetTree: invited.ratchetTree,
      roomIdCommitment: room.roomIdCommitment,
      manifestCommitment: room.manifestCommitment,
    });
    expect(bobJoin.epochState.keys.contentWrapKey).toStrictEqual(aliceEpoch1.keys.contentWrapKey);
  });

  it('rejects an expired invite', async () => {
    const room = await founded();
    const invite = createRoomInvite({
      roomPublicKey: room.manifest.crypto.room_public_key,
      grantedRole: 'member',
      expiresAt: '2020-01-01T00:00:00Z',
    });
    const bobBundle = await generateMemberKeyPackage(utf8('bob-dev'));
    const joinReq = await buildJoinRequest({
      invite,
      keyPackage: bobBundle.publicPackage,
      proposedDisplayName: 'Bob',
      requestedAtBucket: BUCKET,
    });
    const verdict = await verifyJoinRequest(invite, joinReq, { now: NOW });
    expect(verdict).toStrictEqual({ ok: false, reason: 'expired' });
  });

  it('rejects once max_uses is exhausted', async () => {
    const room = await founded();
    const invite = createRoomInvite({
      roomPublicKey: room.manifest.crypto.room_public_key,
      grantedRole: 'member',
      expiresAt: FUTURE,
      maxUses: 1,
    });
    const bobBundle = await generateMemberKeyPackage(utf8('bob-dev'));
    const joinReq = await buildJoinRequest({
      invite,
      keyPackage: bobBundle.publicPackage,
      proposedDisplayName: 'Bob',
      requestedAtBucket: BUCKET,
    });
    const verdict = await verifyJoinRequest(invite, joinReq, { now: NOW, usesSoFar: 1 });
    expect(verdict).toStrictEqual({ ok: false, reason: 'exhausted' });
  });

  it('rejects a tampered proof', async () => {
    const room = await founded();
    const invite = createRoomInvite({
      roomPublicKey: room.manifest.crypto.room_public_key,
      grantedRole: 'member',
      expiresAt: FUTURE,
    });
    const bobBundle = await generateMemberKeyPackage(utf8('bob-dev'));
    const joinReq = await buildJoinRequest({
      invite,
      keyPackage: bobBundle.publicPackage,
      proposedDisplayName: 'Bob',
      requestedAtBucket: BUCKET,
    });
    const tampered = joinRequestSchema.parse({
      ...joinReq,
      proof_of_invite_secret: toBase64Url(new Uint8Array(32).fill(1)),
    });
    const verdict = await verifyJoinRequest(invite, tampered, { now: NOW });
    expect(verdict).toStrictEqual({ ok: false, reason: 'proof_invalid' });
  });

  it('rejects a request built for a DIFFERENT invite (blind id mismatch)', async () => {
    const room = await founded();
    const inviteA = createRoomInvite({
      roomPublicKey: room.manifest.crypto.room_public_key,
      grantedRole: 'member',
      expiresAt: FUTURE,
    });
    const inviteB = createRoomInvite({
      roomPublicKey: room.manifest.crypto.room_public_key,
      grantedRole: 'member',
      expiresAt: FUTURE,
    });
    const bobBundle = await generateMemberKeyPackage(utf8('bob-dev'));
    const joinReq = await buildJoinRequest({
      invite: inviteA,
      keyPackage: bobBundle.publicPackage,
      proposedDisplayName: 'Bob',
      requestedAtBucket: BUCKET,
    });
    const verdict = await verifyJoinRequest(inviteB, joinReq, { now: NOW });
    expect(verdict).toStrictEqual({ ok: false, reason: 'invite_id_mismatch' });
  });

  it('rejects a malformed KeyPackage (valid proof over garbage bytes)', async () => {
    const room = await founded();
    const invite = createRoomInvite({
      roomPublicKey: room.manifest.crypto.room_public_key,
      grantedRole: 'member',
      expiresAt: FUTURE,
    });
    const garbage = toBase64Url(new Uint8Array([1, 2, 3, 4]));
    const badReq = joinRequestSchema.parse({
      schema: 'licio.private.join_request.v1',
      invite_id_blind: (
        await buildJoinRequest({
          invite,
          keyPackage: (await generateMemberKeyPackage(utf8('x'))).publicPackage,
          proposedDisplayName: 'x',
          requestedAtBucket: BUCKET,
        })
      ).invite_id_blind,
      recipient_device_key_package: garbage,
      proposed_display_name: 'Bob',
      proof_of_invite_secret: await deriveJoinProof(
        fromBase64Url(invite.invite_secret),
        garbage,
        BUCKET,
      ),
      requested_at_bucket: BUCKET,
    });
    const verdict = await verifyJoinRequest(invite, badReq, { now: NOW });
    expect(verdict).toStrictEqual({ ok: false, reason: 'malformed_key_package' });
  });
});
