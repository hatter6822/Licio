// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.1 — createPrivateRoom: the founding orchestration produces a real,
// cryptographically-grounded room genesis (real Ed25519 + X25519 + a real
// serialized MLS KeyPackage), and the result drives PrivateRoomEngine end-to-end.
import { describe, expect, it } from 'vitest';
import { deriveEpochState } from '../crypto/epoch.js';
import { generateRecipientKeyPair } from '../crypto/hpke.js';
import {
  addMember,
  decodeKeyPackage,
  encodeKeyPackage,
  findDeviceLeafIndex,
  generateMemberKeyPackage,
} from '../crypto/mls.js';
import { fromBase64Url, toBase64Url, utf8 } from '../crypto/runtime.js';
import { exportPublicKeyRaw, generateDeviceSigningKeyPair } from '../crypto/signatures.js';
import { InMemoryPrivateRoomStorage, PrivateRoomEngine } from '../engine/room-engine.js';
import {
  buildMemberAddOp,
  buildRoomOp,
  computeManifestCommitment,
  createPrivateRoom,
  DEFAULT_PRIVATE_ROOM_POLICY,
  heldKeysOf,
  inviteDevice,
  joinRoom,
  removeDeviceFromRoom,
} from '../engine/room-lifecycle.js';
import { privateRoomManifestSchema } from '../schemas/manifest.js';

const PROFILE = { name: 'Quiet Room', room_type: 'global_topic' } as const;

function baseParams() {
  return {
    roomId: 'room-1',
    founderMemberId: 'founder',
    founderDeviceId: 'founder-dev',
    profile: PROFILE,
    createdAt: '2026-06-22T00:00:00Z',
  };
}

describe('createPrivateRoom', () => {
  it('founds a room whose genesis drives the engine to founder=admin', async () => {
    const created = await createPrivateRoom(baseParams());

    // The manifest is schema-valid and carries the pinned crypto descriptor.
    expect(privateRoomManifestSchema.safeParse(created.manifest).success).toBe(true);
    expect(created.manifest.crypto.current_epoch).toBe(0);
    expect(created.manifest.policy).toStrictEqual(DEFAULT_PRIVATE_ROOM_POLICY);
    expect(created.genesisOp.epoch).toBe(0);

    // Drive the engine with the genesis op.
    const engine = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    const report = await engine.applyLocalOp(created.genesisOp, created.sealParams);
    expect(report.accepted).toStrictEqual(['genesis']);
    expect(engine.state().members.get('founder')?.role).toBe('admin');
    expect(engine.state().devices.get('founder-dev')?.signingPublicKey).toBe(
      created.genesisOp.body.type === 'member.add'
        ? created.genesisOp.body.signing_public_key
        : undefined,
    );
  });

  it('emits a REAL serialized MLS KeyPackage (decodable + usable to add a device)', async () => {
    const created = await createPrivateRoom(baseParams());
    expect(created.genesisOp.body.type).toBe('member.add');
    if (created.genesisOp.body.type !== 'member.add') throw new Error('expected member.add');

    // The genesis op's mls_key_package decodes back to the founder's package…
    const decoded = decodeKeyPackage(fromBase64Url(created.genesisOp.body.mls_key_package));
    expect(decoded).toBeDefined();

    // …and the founder's MLS group can admit a second device with a fresh package
    // (proving the group + package material is real, not a placeholder).
    const bobPkg = await generateMemberKeyPackage(utf8('bob-dev'));
    const outcome = await addMember(created.group, bobPkg.publicPackage);
    expect(outcome.welcome).toBeDefined();
    expect(outcome.commit).toBeDefined();
  });

  it('computeManifestCommitment is deterministic and binds the manifest', async () => {
    const created = await createPrivateRoom(baseParams());
    const again = await computeManifestCommitment(created.manifest);
    expect(again).toStrictEqual(created.manifestCommitment);

    // A changed policy yields a different commitment (the manifest is bound).
    const forked = {
      ...created.manifest,
      policy: { ...created.manifest.policy, replication_target: 7 },
    };
    const forkedCommitment = await computeManifestCommitment(forked);
    expect(forkedCommitment).not.toStrictEqual(created.manifestCommitment);
  });

  it('two rooms get distinct commitments + group ids', async () => {
    const a = await createPrivateRoom(baseParams());
    const b = await createPrivateRoom(baseParams());
    expect(a.roomIdCommitment).not.toStrictEqual(b.roomIdCommitment);
    expect(a.mlsGroupId).not.toStrictEqual(b.mlsGroupId);
  });

  it('decodeKeyPackage rejects non-key-package bytes', () => {
    expect(() => decodeKeyPackage(new Uint8Array([0, 1, 2, 3]))).toThrow();
  });

  it('decodeKeyPackage rejects trailing bytes after a complete message', async () => {
    const pkg = await generateMemberKeyPackage(utf8('trailing-dev'));
    const encoded = encodeKeyPackage(pkg.publicPackage);
    // A well-formed key package with one extra suffix byte must NOT silently decode.
    const withTrailer = new Uint8Array(encoded.length + 1);
    withTrailer.set(encoded, 0);
    expect(() => decodeKeyPackage(encoded)).not.toThrow();
    expect(() => decodeKeyPackage(withTrailer)).toThrow(/complete/);
  });

  it('commits over a manifest with optional + array policy fields (role-gated)', async () => {
    const created = await createPrivateRoom({
      ...baseParams(),
      policy: { posting_policy: 'role_gated', role_gated_posters: ['admin'] },
    });
    expect(created.manifest.policy.role_gated_posters).toStrictEqual(['admin']);
    // A description (string) + role_gated_posters (array) exercise more of the
    // canonicalizer; the commitment stays deterministic.
    const withDesc = {
      ...created.manifest,
      profile: { ...created.manifest.profile, description: 'a quiet place' },
    };
    expect(await computeManifestCommitment(withDesc)).toStrictEqual(
      await computeManifestCommitment(withDesc),
    );
  });
});

describe('membership flow — invite + join (two devices, no transport)', () => {
  it('a joined device derives identical epoch keys and the room state converges', async () => {
    // 1) Alice founds the room and authors genesis.
    const room = await createPrivateRoom({
      roomId: 'r',
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

    // 2) Bob's device keys; the inviter only needs his PUBLIC MLS package.
    const bobSigning = await generateDeviceSigningKeyPair();
    const bobSigningPub = toBase64Url(await exportPublicKeyRaw(bobSigning.publicKey));
    const bobHpke = await generateRecipientKeyPair();
    const bobBundle = await generateMemberKeyPackage(utf8('bob-dev'));

    // 3) Alice admits Bob's device (MLS Add → epoch 1) and derives epoch-1 keys.
    const invited = await inviteDevice(room.group, bobBundle.publicPackage);
    const aliceEpoch1 = await deriveEpochState(
      invited.group,
      room.roomIdCommitment,
      room.manifestCommitment,
    );

    // 4) Bob joins from the Welcome and derives epoch-1 INDEPENDENTLY.
    const bobJoin = await joinRoom({
      welcome: invited.welcome,
      bundle: bobBundle,
      ratchetTree: invited.ratchetTree,
      roomIdCommitment: room.roomIdCommitment,
      manifestCommitment: room.manifestCommitment,
    });

    // THE convergence property: both sides hold byte-identical epoch-1 keys.
    expect(Number(bobJoin.epochState.epoch)).toBe(1);
    expect(bobJoin.epochState.roomEpochSecret).toStrictEqual(aliceEpoch1.roomEpochSecret);
    expect(bobJoin.epochState.keys.contentWrapKey).toStrictEqual(aliceEpoch1.keys.contentWrapKey);
    expect(bobJoin.epochState.keys.syncTopicKey).toStrictEqual(aliceEpoch1.keys.syncTopicKey);
    expect(bobJoin.epochState.keys.rendezvousKey).toStrictEqual(aliceEpoch1.keys.rendezvousKey);

    // 5) Alice authors the member.add op (under epoch 1) + applies it.
    const { op: addBobOp, sealParams: addBobSeal } = await buildMemberAddOp(
      {
        roomId: 'r',
        roomIdCommitment: room.roomIdCommitment,
        epochState: aliceEpoch1,
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
    alice.addEpochKeys(1, heldKeysOf(aliceEpoch1));
    await alice.applyLocalOp(addBobOp, addBobSeal);
    expect(alice.state().members.get('bob')?.role).toBe('member');

    // 6) Alice exports an archive; Bob (epoch-0 history granted + epoch-1 from the
    //    join) imports it and CONVERGES to the same membership state.
    const archive = await alice.exportArchive({
      kind: 'encrypted_member_backup',
      createdAtBucket: '2026-06-22T00',
    });
    const bob = await PrivateRoomEngine.load({
      roomId: 'r',
      roomIdCommitment: room.roomIdCommitment,
      epochs: new Map([
        [0, heldKeysOf(room.epochState)],
        [1, heldKeysOf(bobJoin.epochState)],
      ]),
      bootstrapDevices: [{ deviceId: 'alice-dev', signingPublicKey: aliceSigningPub }],
      storage: new InMemoryPrivateRoomStorage(),
    });
    const report = await bob.importArchive(archive);

    expect(report.accepted.sort()).toStrictEqual(['add-bob', 'genesis']);
    expect(bob.state().members.get('alice')?.role).toBe('admin');
    expect(bob.state().members.get('bob')?.role).toBe('member');
    expect(bob.heads()).toStrictEqual(['add-bob']);
  });
});

describe('content authoring — buildRoomOp + engine metadata helpers', () => {
  it('a founder authors a story + a comment that land in reduced state', async () => {
    const room = await createPrivateRoom(baseParams());
    const engine = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);

    // Author a story (the engine helpers compute parents/lamport/author_seq).
    const { op: storyOp, sealParams: storySeal } = await buildRoomOp(
      {
        roomId: room.roomId,
        roomIdCommitment: room.roomIdCommitment,
        epochState: room.epochState,
        author: {
          memberId: 'founder',
          deviceId: 'founder-dev',
          signingKey: room.founder.signingKeyPair.privateKey,
          seq: engine.nextAuthorSeq('founder-dev'),
        },
        opId: 's1',
        parents: engine.heads(),
        lamport: engine.nextLamport(),
        createdAt: '2026-06-22T00:00:00Z',
      },
      {
        type: 'story.create',
        story_id: 's1',
        thread_id: 't1',
        title: 'Hello',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
    );
    await engine.applyLocalOp(storyOp, storySeal);
    expect(engine.state().stories.get('s1')?.title).toBe('Hello');

    // Author a comment on the story's thread.
    const { op: commentOp, sealParams: commentSeal } = await buildRoomOp(
      {
        roomId: room.roomId,
        roomIdCommitment: room.roomIdCommitment,
        epochState: room.epochState,
        author: {
          memberId: 'founder',
          deviceId: 'founder-dev',
          signingKey: room.founder.signingKeyPair.privateKey,
          seq: engine.nextAuthorSeq('founder-dev'),
        },
        opId: 'c1',
        parents: engine.heads(),
        lamport: engine.nextLamport(),
        createdAt: '2026-06-22T00:00:00Z',
      },
      {
        type: 'contribution.create',
        contribution_id: 'c1',
        thread_id: 't1',
        contribution_type: 'comment',
        body_markdown_lite: 'first!',
        client_draft_id: 'd1',
      },
    );
    await engine.applyLocalOp(commentOp, commentSeal);
    expect(engine.state().contributions.get('c1')?.bodyMarkdownLite).toBe('first!');

    // The metadata helpers advanced across the three founder-dev ops.
    expect(engine.nextAuthorSeq('founder-dev')).toBe(3);
    expect(engine.nextLamport()).toBe('4');
  });
});

describe('membership removal — MLS Remove rotates the epoch (forward secrecy)', () => {
  it('removes a device and the removed device cannot read post-removal content', async () => {
    const room = await createPrivateRoom({
      roomId: 'r',
      founderMemberId: 'alice',
      founderDeviceId: 'alice-dev',
      profile: PROFILE,
      createdAt: '2026-06-22T00:00:00Z',
    });
    const aliceSigningPub = room.engineParams.bootstrapDevices?.[0]?.signingPublicKey;
    if (!aliceSigningPub) throw new Error('expected the founder bootstrap device');

    // Admit Bob (epoch 1); Bob derives epoch-1 keys.
    const bobBundle = await generateMemberKeyPackage(utf8('bob-dev'));
    const invited = await inviteDevice(room.group, bobBundle.publicPackage);
    const bobJoin = await joinRoom({
      welcome: invited.welcome,
      bundle: bobBundle,
      ratchetTree: invited.ratchetTree,
      roomIdCommitment: room.roomIdCommitment,
      manifestCommitment: room.manifestCommitment,
    });

    // The leaf lookup finds each device (and nothing for an unknown identity).
    expect(findDeviceLeafIndex(invited.group, utf8('alice-dev'))).toBe(0);
    expect(findDeviceLeafIndex(invited.group, utf8('bob-dev'))).toBe(1);
    expect(findDeviceLeafIndex(invited.group, utf8('nobody-dev'))).toBeUndefined();

    // Alice removes Bob → epoch 2; the epoch-2 keys differ from epoch-1's.
    const removed = await removeDeviceFromRoom(invited.group, utf8('bob-dev'));
    const aliceEpoch2 = await deriveEpochState(
      removed.group,
      room.roomIdCommitment,
      room.manifestCommitment,
    );
    expect(Number(aliceEpoch2.epoch)).toBe(2);
    expect(aliceEpoch2.keys.contentWrapKey).not.toStrictEqual(
      bobJoin.epochState.keys.contentWrapKey,
    );

    // Alice authors content under epoch-2.
    const aliceStorage = new InMemoryPrivateRoomStorage();
    const alice = await PrivateRoomEngine.load({ ...room.engineParams, storage: aliceStorage });
    await alice.applyLocalOp(room.genesisOp, room.sealParams);
    alice.addEpochKeys(2, heldKeysOf(aliceEpoch2));
    const { op: secretOp, sealParams: secretSeal } = await buildRoomOp(
      {
        roomId: 'r',
        roomIdCommitment: room.roomIdCommitment,
        epochState: aliceEpoch2,
        author: {
          memberId: 'alice',
          deviceId: 'alice-dev',
          signingKey: room.founder.signingKeyPair.privateKey,
          seq: alice.nextAuthorSeq('alice-dev'),
        },
        opId: 'secret',
        parents: alice.heads(),
        lamport: alice.nextLamport(),
        createdAt: '2026-06-22T00:00:00Z',
      },
      {
        type: 'story.create',
        story_id: 'post-removal',
        thread_id: 't9',
        title: 'after Bob left',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
    );
    expect((await alice.applyLocalOp(secretOp, secretSeal)).accepted).toStrictEqual(['secret']);
    const secretEnvelope = (await aliceStorage.listEnvelopes()).find(
      (e) => e.opId === 'secret',
    )?.envelope;
    if (!secretEnvelope) throw new Error('expected the sealed secret envelope');

    // Bob holds only epoch-0/1 keys → he CANNOT open the epoch-2 content.
    const bob = await PrivateRoomEngine.load({
      roomId: 'r',
      roomIdCommitment: room.roomIdCommitment,
      epochs: new Map([
        [0, heldKeysOf(room.epochState)],
        [1, heldKeysOf(bobJoin.epochState)],
      ]),
      bootstrapDevices: [{ deviceId: 'alice-dev', signingPublicKey: aliceSigningPub }],
      storage: new InMemoryPrivateRoomStorage(),
    });
    const bobReport = await bob.ingest([secretEnvelope]);
    // Forward secrecy: Bob CANNOT open the epoch-2 content.  With the cross-epoch
    // self-heal the unopenable envelope is RETAINED (no_epoch_key) rather than dropped —
    // but the security guarantee is unchanged: it never enters Bob's state, and because
    // Bob (removed) can NEVER receive the epoch-2 key, retryPending leaves it unreadable.
    expect(bobReport.accepted).toStrictEqual([]);
    expect(bobReport.quarantined).toHaveLength(0); // pended awaiting a key it will never get
    expect(bob.pendingCount()).toBe(1);
    expect(bob.state().stories.has('secret')).toBe(false);
    const retried = await bob.retryPending();
    expect(retried.accepted).toStrictEqual([]); // still no epoch-2 key ⇒ still unreadable
    expect(bob.pendingCount()).toBe(1);
    expect(bob.state().stories.has('secret')).toBe(false);
  });
});
