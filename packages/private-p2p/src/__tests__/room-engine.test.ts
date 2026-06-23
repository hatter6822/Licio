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
import { roomStateCommitment } from '../reducer/state.js';
import type { SealOpParams } from '../reducer/validate-op.js';
import { sealOp } from '../reducer/validate-op.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';
import {
  decodeSyncMessage,
  encodeSyncMessage,
  type OpRequest,
  type OpResponse,
} from '../sync/op-exchange.js';

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

describe('PrivateRoomEngine — §14.2 structural validation enforced in state', () => {
  it('a device fork (two ops at the same author_seq) does not reach state', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const engine = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));

    const genesis = mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
      op_id: 'genesis',
      lamport: '1',
    });
    // Two founder stories at the SAME author_seq (1) off genesis — a device fork.
    const a = mkOp(story('s-a'), {
      op_id: 'forkA',
      author_seq: 1,
      lamport: '2',
      parents: ['genesis'],
    });
    const b = mkOp(story('s-b'), {
      op_id: 'forkB',
      author_seq: 1,
      lamport: '3',
      parents: ['genesis'],
    });

    const report = await engine.ingest([
      await sealOp(genesis, founderSeal),
      await sealOp(a, founderSeal),
      await sealOp(b, founderSeal),
    ]);
    // All three open cryptographically (each is a valid signed op)…
    expect(report.accepted.sort()).toStrictEqual(['forkA', 'forkB', 'genesis']);
    // …but only the lower-lamport member of the same-seq pair reaches state; the
    // fork is quarantined by the structural pre-pass (§14.2 step 9).
    expect(engine.state().stories.has('s-a')).toBe(true);
    expect(engine.state().stories.has('s-b')).toBe(false);
  });

  it('an op with a genuinely missing parent opens but does not reach state', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const engine = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    await engine.applyLocalOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    // Parent 'ghost' was never ingested → missing_dependency, excluded from the fold.
    const orphan = mkOp(story('s-orphan'), {
      op_id: 'orphan',
      author_seq: 1,
      lamport: '2',
      parents: ['ghost'],
    });
    const report = await engine.ingest([await sealOp(orphan, founderSeal)]);
    expect(report.accepted).toStrictEqual(['orphan']); // crypto-opened
    expect(engine.state().stories.has('s-orphan')).toBe(false); // but not folded
  });

  it('an op whose lamport is not after its parent does not reach state', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const engine = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    await engine.applyLocalOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '5',
      }),
      founderSeal,
    );
    // lamport 3 ≤ parent genesis's 5 → violates §14.3.1, excluded from the fold.
    const acausal = mkOp(story('s-acausal'), {
      op_id: 'acausal',
      author_seq: 1,
      lamport: '3',
      parents: ['genesis'],
    });
    await engine.ingest([await sealOp(acausal, founderSeal)]);
    expect(engine.state().stories.has('s-acausal')).toBe(false);
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

describe('PrivateRoomEngine — device fork (§15) deterministic convergence', () => {
  async function forkPair(r: Awaited<ReturnType<typeof room>>) {
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const genesisEnv = await sealOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    // Two VALID ops sharing op_id 'fork' but with different content (story s-a vs
    // s-b) at the same causal position — a device fork.
    const base = { op_id: 'fork', author_seq: 1, lamport: '2', parents: ['genesis'] };
    const envA = await sealOp(mkOp(story('s-a'), base), founderSeal);
    const envB = await sealOp(mkOp(story('s-b'), base), founderSeal);
    return { genesisEnv, envA, envB };
  }

  it('converges on the SAME fork variant regardless of arrival order', async () => {
    const r = await room();
    const { genesisEnv, envA, envB } = await forkPair(r);
    const e1 = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    const e2 = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    await e1.ingest([genesisEnv, envA, envB]);
    await e2.ingest([genesisEnv, envB, envA]); // opposite order

    // Both keep the deterministically-chosen variant (bytewise-smaller signature),
    // so their state is byte-identical despite the opposite delivery order — the
    // `has(opId)` first-one-wins drop would have diverged them.
    expect(roomStateCommitment(e1.state())).toStrictEqual(roomStateCommitment(e2.state()));
    const e1HasA = e1.state().stories.has('s-a');
    expect(e2.state().stories.has('s-a')).toBe(e1HasA);
    expect(e1.state().stories.has('s-b')).toBe(!e1HasA); // exactly one variant in state
  });

  it('surfaces the losing fork variant as duplicate_op_id evidence (not silently dropped)', async () => {
    const r = await room();
    const { genesisEnv, envA, envB } = await forkPair(r);
    // Deliver the larger-signature variant SECOND so it loses + is reported.
    const [first, second] = envA.signature < envB.signature ? [envA, envB] : [envB, envA];
    const engine = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    const report = await engine.ingest([genesisEnv, first, second]);
    expect(report.quarantined.some((q) => q.reason === 'duplicate_op_id')).toBe(true);
  });
});

describe('PrivateRoomEngine — §15.7 op-exchange convergence (two engines, live-protocol)', () => {
  it('reconciles a fresh peer to byte-identical state via head/want/serve, walking the DAG', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');

    // Alice authors a 4-hop chain: genesis → cs1 → add-bob → cs2.
    const alice = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));
    await alice.applyLocalOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    await alice.applyLocalOp(
      mkOp(story('s1'), { op_id: 'cs1', author_seq: 1, lamport: '2', parents: ['genesis'] }),
      founderSeal,
    );
    const bob = await makeDevice();
    await alice.applyLocalOp(
      mkOp(memberAdd('bob', 'bob-dev', bob.pub, 'member'), {
        op_id: 'add-bob',
        author_seq: 2,
        lamport: '3',
        parents: ['cs1'],
      }),
      founderSeal,
    );
    await alice.applyLocalOp(
      mkOp(story('s2'), { op_id: 'cs2', author_seq: 3, lamport: '4', parents: ['add-bob'] }),
      founderSeal,
    );
    expect(alice.heads()).toStrictEqual(['cs2']);

    // A fresh peer holding the SAME room keys + the founder bootstrap pulls from Alice.
    const peer = await PrivateRoomEngine.load(r.engineParams(new InMemoryPrivateRoomStorage()));

    // Drive the §15.7 PULL loop entirely THROUGH the wire codec (encode/decode), so the
    // request/response messages are exercised end-to-end, not just the engine methods.
    let rounds = 0;
    // First wanted set = Alice's announced heads the peer lacks.
    let wantIds = peer.wantedFrom(alice.headAnnouncement());
    while (wantIds.length > 0) {
      if (rounds++ > 16) throw new Error('did not converge');
      // peer → alice: an op_request (round-tripped through the codec).
      const reqBytes = encodeSyncMessage({
        schema: 'licio.private.op_request.v1',
        op_ids: wantIds,
      });
      const req = decodeSyncMessage(reqBytes) as OpRequest;
      // alice serves; the response round-trips through the codec.
      const served = await alice.serveOps(req.op_ids);
      const resBytes = encodeSyncMessage({
        schema: 'licio.private.op_response.v1',
        envelopes: served,
      });
      const res = decodeSyncMessage(resBytes) as OpResponse;
      // peer ingests (the ONLY trust boundary) and recomputes its wants + missing ancestors.
      await peer.ingest(res.envelopes);
      const deps = peer.missingDependencies();
      const wantedNow = peer.wantedFrom(alice.headAnnouncement());
      wantIds = [...new Set([...deps, ...wantedNow])].sort();
    }

    // The peer converged to BYTE-IDENTICAL state with no transport and no archive.
    expect(peer.heads()).toStrictEqual(['cs2']);
    expect(peer.state().members.get('bob')?.role).toBe('member');
    expect(peer.state().stories.get('s2')?.title).toBe('Story s2');
    expect(Array.from(roomStateCommitment(peer.state()))).toEqual(
      Array.from(roomStateCommitment(alice.state())),
    );
    expect(rounds).toBeGreaterThan(1); // it genuinely walked the multi-hop ancestor chain
  });

  it('the sync-message codec round-trips a head announcement', () => {
    const ann = {
      schema: 'licio.private.head_announcement.v1' as const,
      heads: ['a', 'b'],
      op_count_bucket: 0,
    };
    const decoded = decodeSyncMessage(encodeSyncMessage(ann));
    expect(decoded).toStrictEqual(ann);
  });
});
