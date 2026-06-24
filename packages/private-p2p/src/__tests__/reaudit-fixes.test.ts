// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression tests for the WP-1 re-audit findings (the engine-level ones the unit suite
// originally missed): the §27 retention-pool cap (finding 2), the serveBlocks
// not-held/over-budget distinction (finding 4), and — the CRITICAL one — the §14.5
// snapshot-authority anchoring (finding 3).

import { describe, expect, it } from 'vitest';
import { canonical } from '../crypto/canonical.js';
import { deriveAuthorDeviceIdBlind } from '../crypto/device-blind.js';
import { deriveEpochState } from '../crypto/epoch.js';
import { generateRecipientKeyPair } from '../crypto/hpke.js';
import {
  addMember,
  applyCommit,
  currentEpoch,
  encodeKeyPackage,
  generateMemberKeyPackage,
  proposeAdd,
} from '../crypto/mls.js';
import { randomBytes, sha256, toBase64Url, utf8 } from '../crypto/runtime.js';
import { exportPublicKeyRaw, generateDeviceSigningKeyPair } from '../crypto/signatures.js';
import { buildMemberAddOp, heldKeysOf, inviteDevice, joinRoom } from '../engine/room-lifecycle.js';
import {
  createPrivateRoom,
  encryptAttachment,
  InMemoryPrivateRoomStorage,
  PrivateRoomEngine,
} from '../index.js';
import { sealSnapshotBundle } from '../reducer/snapshot-seal.js';
import { deserializeReducerState, serializeReducerState } from '../reducer/snapshot-state.js';
import { roomStateCommitment } from '../reducer/state.js';
import { sealOp } from '../reducer/validate-op.js';
import { privateRoomOpSchema } from '../schemas/ops.js';
import { buildBlockArchive, encodeBlockArchive } from '../sync/archive.js';

const PROFILE = { name: 'Re-audit', room_type: 'global_topic' } as const;

describe('re-audit finding 2 — pendingEnvelopes pool is bounded (DoS)', () => {
  it('caps the retention pool when flooded with unknown_device envelopes', async () => {
    const created = await createPrivateRoom({
      roomId: 'room-flood',
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const alice = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(created.genesisOp, created.sealParams);
    const base = (await alice.serveOps([created.genesisOp.op_id]))[0];
    if (!base) throw new Error('no genesis envelope');

    // A fresh engine that does NOT know any random author-blind: every cloned envelope
    // fails openOp with `unknown_device` (returned BEFORE signature verification), so an
    // unauthenticated peer could flood the pool — except it is now capped.
    const bob = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    const FLOOD = 4_200; // > the 4096 cap
    const garbage = Array.from({ length: FLOOD }, () => ({
      ...base,
      author_device_id_blind: toBase64Url(randomBytes(16)),
      signature: toBase64Url(randomBytes(64)),
    }));
    await bob.ingest(garbage);
    // Bounded: the pool never exceeds the cap (was unbounded before the fix).
    expect(bob.pendingCount()).toBeLessThanOrEqual(4_096);
    expect(bob.pendingCount()).toBeGreaterThan(0);
  });
});

describe('re-audit finding 4 — serveBlocks refuses only over-budget (held), omits not-held', () => {
  it('omits a not-held CID and refuses held-but-over-budget CIDs', async () => {
    const created = await createPrivateRoom({
      roomId: 'room-serve',
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const alice = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    const media = new Uint8Array(40_000); // multiple chunks
    for (let i = 0; i < media.length; i++) media[i] = (i * 3 + 1) & 0xff;
    const encrypted = await encryptAttachment(media, {
      attachmentId: 'a1',
      roomId: 'room-serve',
      roomIdCommitment: created.roomIdCommitment,
      roomEpoch: Number(created.epochState.epoch),
      mediaKind: 'image',
      contentType: 'image/png',
      createdByMemberId: 'founder',
      createdAt: '2026-06-23T00:00:00.000Z',
      contentWrapKey: created.epochState.keys.contentWrapKey,
      metadataStripped: true,
      userConfirmedRightToShare: true,
    });
    await alice.storeAttachment(encrypted);

    const chunkCids = encrypted.manifest.encrypted_chunks.map((c) => c.cid);
    const notHeld = toBase64Url(randomBytes(34)); // a CID we do not hold
    // A budget that fits only the first chunk forces the rest to be refused-as-over-budget.
    const oneChunk = (await alice.serveBlocks([chunkCids[0] as string], 1_000_000)).served[0];
    if (!oneChunk) throw new Error('expected a served chunk');
    const budget = oneChunk.bytes.length + 1;

    const { served, refused } = await alice.serveBlocks([...chunkCids, notHeld], budget);
    // Some served (under budget), the rest refused — but ONLY held blocks are refused.
    expect(served.length).toBeGreaterThanOrEqual(1);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // The not-held CID is OMITTED (neither served nor refused) so the requester does not
    // livelock re-asking a peer that will never have it.
    expect(served.map((b) => b.cid)).not.toContain(notHeld);
    expect(refused).not.toContain(notHeld);
    // Every refused CID is one we actually hold (a chunk), i.e. re-requestable next pass.
    for (const cid of refused) expect(chunkCids).toContain(cid);
  });
});

describe('re-audit finding 3 (CRITICAL) — §14.5 snapshot-authority anchoring', () => {
  // A 2-member room: alice (admin) + bob (a plain `member`).  Bob holds the per-epoch
  // content key, so bob can SEAL a snapshot body + author a snapshot.commit — but the seal
  // proves only "a member made this", never "an admin".
  async function twoMemberRoom() {
    const room = await createPrivateRoom({
      roomId: 'r-auth',
      founderMemberId: 'alice',
      founderDeviceId: 'alice-dev',
      profile: PROFILE,
      createdAt: '2026-06-22T00:00:00Z',
    });
    const aliceSigningPub = room.engineParams.bootstrapDevices?.[0]?.signingPublicKey;
    if (!aliceSigningPub) throw new Error('expected the founder bootstrap device');
    const alice = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(room.genesisOp, room.sealParams);

    // Add bob's device as a plain `member` (MLS Add → epoch 1).
    const bobSigning = await generateDeviceSigningKeyPair();
    const bobSigningPub = toBase64Url(await exportPublicKeyRaw(bobSigning.publicKey));
    const bobHpke = await generateRecipientKeyPair();
    const bobBundle = await generateMemberKeyPackage(utf8('bob-dev'));
    const invited = await inviteDevice(room.group, bobBundle.publicPackage);
    const epoch1 = await deriveEpochState(
      invited.group,
      room.roomIdCommitment,
      room.manifestCommitment,
    );
    const { op: addBob, sealParams: addBobSeal } = await buildMemberAddOp(
      {
        roomId: 'r-auth',
        roomIdCommitment: room.roomIdCommitment,
        epochState: epoch1,
        author: {
          memberId: 'alice',
          deviceId: 'alice-dev',
          signingKey: room.founder.signingKeyPair.privateKey,
          seq: alice.nextAuthorSeq('alice-dev'),
        },
        opId: 'add-bob',
        parents: alice.heads(),
        lamport: alice.nextLamport(),
        createdAt: '2026-06-22T00:00:00Z',
      },
      {
        memberId: 'bob',
        deviceId: 'bob-dev',
        signingPublicKey: bobSigningPub,
        hpkePublicKey: toBase64Url(bobHpke.publicKey),
        mlsKeyPackage: toBase64Url(encodeKeyPackage(bobBundle.publicPackage)),
        role: 'member',
      },
    );
    alice.addEpochKeys(1, heldKeysOf(epoch1));
    await alice.applyLocalOp(addBob, addBobSeal);
    if (alice.state().members.get('bob')?.role !== 'member') {
      throw new Error('setup: bob should be a plain member');
    }
    return { room, alice, epoch1, aliceSigningPub, bobSigning, bobSigningPub };
  }

  // Bob forges an archive whose snapshot BODY grants bob `admin`, with a bob-signed
  // snapshot.commit referencing it (sealed under the epoch-1 content key bob holds).
  async function forgeAdminArchive(
    ctx: Awaited<ReturnType<typeof twoMemberRoom>>,
  ): Promise<Uint8Array> {
    const { room, alice, epoch1, bobSigning } = ctx;
    // Forge the reduced state: promote bob to admin (role + the `admin` capability the
    // snapshot.commit authority check reads).
    const forged = deserializeReducerState(serializeReducerState(alice.state()));
    const bobMember = forged.members.get('bob');
    if (!bobMember) throw new Error('forge: bob missing from state');
    bobMember.role = 'admin';
    bobMember.capabilities = new Set([...bobMember.capabilities, 'admin']);

    const coveredHeads = alice.heads();
    const bundle = {
      serializedState: serializeReducerState(forged),
      coveredOps: [] as [string, string][],
      coveredHeads,
      maxLamport: '0',
      authorSeq: [] as [string, number][],
    };
    const contentWrapKey = epoch1.keys.contentWrapKey;
    const sealed = await sealSnapshotBundle(bundle, {
      roomIdCommitment: room.roomIdCommitment,
      contentWrapKey,
      epoch: 1,
    });
    const stateRoot = toBase64Url(await sha256(roomStateCommitment(forged)));
    const op = privateRoomOpSchema.parse({
      schema: 'licio.private.op.v1',
      room_id: 'r-auth',
      epoch: 1,
      op_id: 'forged-snap-commit',
      author_member_id: 'bob',
      author_device_id: 'bob-dev',
      author_seq: 1,
      created_at: '2026-06-22T01:00:00Z',
      created_at_bucket: '2026-06-22T01',
      lamport: '10',
      parents: coveredHeads,
      body: {
        type: 'snapshot.commit',
        snapshot_id: 'forged-snap',
        includes_ops_up_to: coveredHeads,
        state_merkle_root: stateRoot,
        snapshot_body_cid: sealed.cid,
      },
    });
    const envelope = await sealOp(op, {
      roomIdCommitment: room.roomIdCommitment,
      contentWrapKey,
      deviceSigningKey: bobSigning.privateKey,
      authorDeviceIdBlind: await deriveAuthorDeviceIdBlind(
        epoch1.roomEpochSecret,
        room.roomIdCommitment,
        'bob-dev',
        1,
      ),
      capabilityRootAtSeq: await sha256(canonical([])),
    });
    return encodeBlockArchive(
      buildBlockArchive({
        kind: 'encrypted_member_backup',
        roomIdHash: toBase64Url(room.roomIdCommitment),
        createdAtBucket: '2026-06-22T01',
        envelopes: [envelope],
        sealedSnapshot: sealed,
      }),
    );
  }

  it('an ESTABLISHED importer REJECTS a non-admin member’s forged admin-snapshot', async () => {
    const ctx = await twoMemberRoom();
    const forged = await forgeAdminArchive(ctx);
    // alice is established (her reduced state has real members), so verifySnapshotCommit
    // anchors authority on HER trusted state — where bob is a plain member — and the
    // forged base is NOT adopted.  The privilege escalation is blocked.
    await ctx.alice.importArchive(forged);
    expect(ctx.alice.state().members.get('bob')?.role).toBe('member');
    expect(ctx.alice.state().members.get('bob')?.capabilities.has('admin')).toBe(false);
  });

  it('a FRESH importer falls back to the body (trust-by-delivery) — completeJoin MUST authenticate the grant', async () => {
    const ctx = await twoMemberRoom();
    const forged = await forgeAdminArchive(ctx);
    // A fresh engine has NO trusted state to anchor on, so it falls back to the body.  This
    // is safe ONLY because completeJoin delivers the snapshot inside a §10.3-AUTHENTICATED
    // grant from the inviting admin (never an arbitrary member, see room-lifecycle).  We
    // assert the fallback branch IS exercised, so a regression of the
    // `members.size > 0 ? currentState : candidate` anchor is caught here too.
    const fresh = await PrivateRoomEngine.load({
      roomId: 'r-auth',
      roomIdCommitment: ctx.room.roomIdCommitment,
      epochs: new Map([
        [0, heldKeysOf(ctx.room.epochState)],
        [1, heldKeysOf(ctx.epoch1)],
      ]),
      bootstrapDevices: [
        { deviceId: 'alice-dev', signingPublicKey: ctx.aliceSigningPub },
        { deviceId: 'bob-dev', signingPublicKey: ctx.bobSigningPub },
      ],
      storage: new InMemoryPrivateRoomStorage(),
    });
    await fresh.importArchive(forged);
    expect(fresh.state().members.get('bob')?.role).toBe('admin'); // trust-by-delivery fallback
  });
});

describe('re-audit finding 1 — applyCommit rejects a bare MLS Proposal (not an epoch advance)', () => {
  it('rejects a proposal-as-commit, but accepts a real commit', async () => {
    // alice founds + adds bob (epoch 1); bob joins and holds his OWN epoch-1 group.
    const room = await createPrivateRoom({
      roomId: 'r-commit',
      founderMemberId: 'alice',
      founderDeviceId: 'alice-dev',
      profile: PROFILE,
      createdAt: '2026-06-22T00:00:00Z',
    });
    const bobBundle = await generateMemberKeyPackage(utf8('bob-dev'));
    const invited = await inviteDevice(room.group, bobBundle.publicPackage); // alice → epoch 1
    const bobJoin = await joinRoom({
      welcome: invited.welcome,
      bundle: bobBundle,
      ratchetTree: invited.ratchetTree,
      roomIdCommitment: room.roomIdCommitment,
      manifestCommitment: room.manifestCommitment,
    });
    expect(Number(currentEpoch(bobJoin.group))).toBe(1);

    // A bare Add PROPOSAL from alice (epoch 1) — proposing a third device, NOT committed.
    // It is the SAME handshake wireformat as a commit, so an attacker could relay it in an
    // `mls_commit` slot; bob must NOT mistake it for an epoch advance.
    const charlieBundle = await generateMemberKeyPackage(utf8('charlie-dev'));
    const proposal = await proposeAdd(invited.group, charlieBundle.publicPackage);
    await expect(applyCommit(bobJoin.group, proposal)).rejects.toThrow(/did not advance the epoch/);

    // Control: a REAL commit (the MLS Add) DOES advance bob to epoch 2.
    const realAdd = await addMember(invited.group, charlieBundle.publicPackage); // epoch 1 → 2
    const advanced = await applyCommit(bobJoin.group, realAdd.commit);
    expect(Number(currentEpoch(advanced))).toBe(2);
  });
});

// NOTE: finding 1 (applyCommit rejects a bare MLS Proposal) and finding 3 (CRITICAL —
// snapshot-authority anchoring) now have catch-proof regressions above.  Finding 5
// (admitJoinRequest rejects a mismatched/colliding device id) lives in apps/web — its
// regression is `apps/web/src/private-p2p/__tests__/admit-device-id.test.ts`.
