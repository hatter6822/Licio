// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S — PrivateRoomEngine tests: the END-TO-END client lifecycle composed from
// the pure cores.  Create a room (founder genesis), author content + add a
// member, persist + RELOAD with re-verification (storage confers no trust),
// converge an OUT-OF-ORDER batch via the open→fold fixpoint, and quarantine a
// tampered block — all with REAL crypto, no transport.
import { describe, expect, it } from 'vitest';
import { deriveAuthorDeviceIdBlind } from '../crypto/device-blind.js';
import { type PrivateCryptoKeyPair, randomBytes, toBase64Url } from '../crypto/runtime.js';
import { exportPublicKeyRaw, generateDeviceSigningKeyPair } from '../crypto/signatures.js';
import { InMemoryPrivateRoomStorage, PrivateRoomEngine } from '../engine/room-engine.js';
import type { HeldEpochKeys } from '../reducer/intake-context.js';
import type { SealOpParams } from '../reducer/validate-op.js';
import { sealOp } from '../reducer/validate-op.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

const ROOM = 'room-1';

let n = 0;
function mkOp(
  body: PrivateOpBody,
  fields: {
    op_id?: string;
    author_member_id?: string;
    author_device_id?: string;
    author_seq?: number;
    lamport?: string;
    parents?: string[];
  } = {},
): PrivateRoomOp {
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: ROOM,
    epoch: 0,
    op_id: fields.op_id ?? `op-${++n}`,
    author_member_id: fields.author_member_id ?? 'founder',
    author_device_id: fields.author_device_id ?? 'founder-dev',
    author_seq: fields.author_seq ?? 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: fields.lamport ?? '1',
    parents: fields.parents ?? [],
    body,
  });
}

const story = (id: string): PrivateOpBody => ({
  type: 'story.create',
  story_id: id,
  thread_id: `t-${id}`,
  title: `Story ${id}`,
  submission_type: 'original_brief',
  topic_ids: [],
  submission_metadata: {},
});

async function makeDevice(): Promise<{ device: PrivateCryptoKeyPair; pub: string }> {
  const device = await generateDeviceSigningKeyPair();
  return { device, pub: toBase64Url(await exportPublicKeyRaw(device.publicKey)) };
}

function memberAdd(
  memberId: string,
  deviceId: string,
  pub: string,
  role: 'admin' | 'member',
): PrivateOpBody {
  return {
    type: 'member.add',
    member_id: memberId,
    device_id: deviceId,
    signing_public_key: pub,
    hpke_public_key: 'AAAA',
    mls_key_package: 'AAAA',
    granted_role: role,
  };
}

async function room() {
  const roomIdCommitment = randomBytes(32);
  const epoch0Secret = randomBytes(32);
  const contentWrapKey = randomBytes(32);
  const epochs = new Map<number, HeldEpochKeys>([
    [0, { roomEpochSecret: epoch0Secret, contentWrapKey }],
  ]);
  const founder = await makeDevice();

  const sealParamsFor = async (
    device: PrivateCryptoKeyPair,
    deviceId: string,
  ): Promise<SealOpParams> => ({
    roomIdCommitment,
    contentWrapKey,
    deviceSigningKey: device.privateKey,
    authorDeviceIdBlind: await deriveAuthorDeviceIdBlind(
      epoch0Secret,
      roomIdCommitment,
      deviceId,
      0,
    ),
    capabilityRootAtSeq: randomBytes(16),
  });

  const engineParams = (storage: InMemoryPrivateRoomStorage) => ({
    roomId: ROOM,
    roomIdCommitment,
    storage,
    epochs,
    // The founder's own device is the genesis bootstrap (known out of band).
    bootstrapDevices: [{ deviceId: 'founder-dev', signingPublicKey: founder.pub }],
  });

  return {
    roomIdCommitment,
    epoch0Secret,
    contentWrapKey,
    epochs,
    founder,
    sealParamsFor,
    engineParams,
  };
}

describe('PrivateRoomEngine — create + author lifecycle', () => {
  it('founds a room, posts a story, and adds a member', async () => {
    const r = await room();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load(r.engineParams(storage));
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');

    // 1) Genesis: the founder self-add.
    const genesis = mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
      op_id: 'genesis',
      lamport: '1',
    });
    const g = await engine.applyLocalOp(genesis, founderSeal);
    expect(g.accepted).toStrictEqual(['genesis']);
    expect(engine.state().members.get('founder')?.role).toBe('admin');

    // 2) The founder posts a story.
    const post = mkOp(story('s1'), {
      op_id: 'cs1',
      author_seq: 1,
      lamport: '2',
      parents: ['genesis'],
    });
    await engine.applyLocalOp(post, founderSeal);
    expect(engine.state().stories.get('s1')?.title).toBe('Story s1');

    // 3) The founder adds bob.
    const bob = await makeDevice();
    const addBob = mkOp(memberAdd('bob', 'bob-dev', bob.pub, 'member'), {
      op_id: 'add-bob',
      author_seq: 2,
      lamport: '3',
      parents: ['cs1'],
    });
    await engine.applyLocalOp(addBob, founderSeal);
    expect(engine.state().members.get('bob')?.role).toBe('member');
    expect(engine.state().rejected).toHaveLength(0);
    expect(engine.heads()).toStrictEqual(['add-bob']);
  });
});

describe('PrivateRoomEngine — persistence + verify-on-load', () => {
  it('reloads byte-identical state by re-verifying stored envelopes', async () => {
    const r = await room();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load(r.engineParams(storage));
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');

    await engine.applyLocalOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    await engine.applyLocalOp(
      mkOp(story('s1'), { op_id: 'cs1', author_seq: 1, lamport: '2', parents: ['genesis'] }),
      founderSeal,
    );

    // A fresh engine over the SAME storage re-verifies every envelope on load.
    const reloaded = await PrivateRoomEngine.load(r.engineParams(storage));
    expect(reloaded.state().members.get('founder')?.role).toBe('admin');
    expect(reloaded.state().stories.get('s1')?.title).toBe('Story s1');
    expect(reloaded.heads()).toStrictEqual(['cs1']);
  });
});

describe('PrivateRoomEngine — fixpoint convergence + quarantine', () => {
  it('converges an OUT-OF-ORDER batch (a child arrives before its author is added)', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const bob = await makeDevice();
    const bobSeal = await r.sealParamsFor(bob.device, 'bob-dev');

    // Build + seal genesis, add-bob (by founder), and a bob-authored story.
    const genesis = mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
      op_id: 'genesis',
      lamport: '1',
    });
    const addBob = mkOp(memberAdd('bob', 'bob-dev', bob.pub, 'member'), {
      op_id: 'add-bob',
      author_seq: 1,
      lamport: '2',
      parents: ['genesis'],
    });
    const bobStory = mkOp(story('s1'), {
      op_id: 'cs1',
      author_member_id: 'bob',
      author_device_id: 'bob-dev',
      author_seq: 0,
      lamport: '3',
      parents: ['add-bob'],
    });
    const envelopes = [
      await sealOp(bobStory, bobSeal), // delivered FIRST, but unopenable until bob is added
      await sealOp(addBob, founderSeal),
      await sealOp(genesis, founderSeal),
    ];

    const engine = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    const report = await engine.ingest(envelopes);
    expect(report.accepted.sort()).toStrictEqual(['add-bob', 'cs1', 'genesis']);
    expect(report.quarantined).toHaveLength(0);
    expect(engine.state().stories.get('s1')?.authorMemberId).toBe('bob');
  });

  it('quarantines a tampered envelope (never enters state)', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const engine = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));

    const genesisEnv = await sealOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    const tampered = { ...genesisEnv, ciphertext: toBase64Url(randomBytes(64)) };
    const report = await engine.ingest([tampered]);
    expect(report.accepted).toHaveLength(0);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]?.reason).toBe('signature_invalid');
    expect(engine.state().members.size).toBe(0);
  });
});

describe('PrivateRoomEngine — §15.6 sync surface', () => {
  it('announces heads + computes what a peer wants', async () => {
    const r = await room();
    const engine = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    await engine.applyLocalOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    await engine.applyLocalOp(
      mkOp(story('s1'), { op_id: 'cs1', author_seq: 1, lamport: '2', parents: ['genesis'] }),
      founderSeal,
    );

    const announcement = engine.headAnnouncement('snap-1');
    expect(announcement.heads).toStrictEqual(['cs1']);
    expect(announcement.latest_snapshot_id).toBe('snap-1');

    // A fresh peer wants the announced head; once it holds it, it wants nothing.
    const peer = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    expect(peer.wantedFrom(announcement)).toStrictEqual(['cs1']);
    expect(engine.wantedFrom(announcement)).toStrictEqual([]);
  });
});

describe('PrivateRoomEngine — §15.9 archive export/import (two-engine convergence)', () => {
  it('a second engine converges to the same state by importing the archive', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const bob = await makeDevice();

    // Alice builds the room: genesis → add bob → a story.
    const alice = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    await alice.applyLocalOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    await alice.applyLocalOp(
      mkOp(memberAdd('bob', 'bob-dev', bob.pub, 'member'), {
        op_id: 'add-bob',
        author_seq: 1,
        lamport: '2',
        parents: ['genesis'],
      }),
      founderSeal,
    );
    await alice.applyLocalOp(
      mkOp(story('s1'), { op_id: 'cs1', author_seq: 2, lamport: '3', parents: ['add-bob'] }),
      founderSeal,
    );

    const archive = await alice.exportArchive({
      kind: 'encrypted_member_backup',
      createdAtBucket: '2026-06-22T00',
    });

    // Bob — a member with the SAME room keys — imports the archive and converges.
    const bobEngine = await PrivateRoomEngine.load(
      r.engineParams(new InMemoryPrivateRoomStorage()),
    );
    const report = await bobEngine.importArchive(archive);
    expect(report.accepted.sort()).toStrictEqual(['add-bob', 'cs1', 'genesis']);
    expect(bobEngine.state().members.get('founder')?.role).toBe('admin');
    expect(bobEngine.state().members.get('bob')?.role).toBe('member');
    expect(bobEngine.state().stories.get('s1')?.title).toBe('Story s1');
    expect(bobEngine.heads()).toStrictEqual(['cs1']);
  });

  it('refuses to export an empty room', async () => {
    const r = await room();
    const engine = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    await expect(
      engine.exportArchive({ kind: 'encrypted_member_backup', createdAtBucket: '2026-06-22T00' }),
    ).rejects.toThrow(/no content/);
  });

  it('refuses to import an archive for a different room', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const alice = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    await alice.applyLocalOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    const archive = await alice.exportArchive({
      kind: 'encrypted_member_backup',
      createdAtBucket: '2026-06-22T00',
    });

    // A different room (fresh commitment) rejects the archive.
    const other = await room();
    const otherEngine = await PrivateRoomEngine.load(
      other.engineParams(new InMemoryPrivateRoomStorage()),
    );
    await expect(otherEngine.importArchive(archive)).rejects.toThrow(/different room/);
  });
});
