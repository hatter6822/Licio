// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7 — the apps/web private-room client surface: the IndexedDB storage
// adapter (per-room isolation + idempotent upsert) and `loadPrivateRoomEngine`
// (the dynamic-import engine construction) wired end-to-end.  Proves a room
// founded in one engine PERSISTS to IndexedDB and a fresh engine re-verifies it
// on load (§8.3) — real crypto in jsdom, real IndexedDB via fake-indexeddb.
//
// `@licio/private-p2p` is loaded by DYNAMIC import here too (the code-split gate
// `check:private-p2p-split` forbids a static value import anywhere in apps/web/src,
// tests included), mirroring how the app loads it.
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadPrivateRoomEngine, PrivateRoomSession } from '../room-manager.js';
import { IndexedDbPrivateRoomStorage, PRIVATE_P2P_DB_NAME } from '../storage.js';

type P2p = typeof import('@licio/private-p2p');
let p2p: P2p;
beforeAll(async () => {
  p2p = await import('@licio/private-p2p');
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

const ROOM = 'room-1';

async function founderRoom() {
  const roomIdCommitment = p2p.randomBytes(32);
  const epoch0Secret = p2p.randomBytes(32);
  const contentWrapKey = p2p.randomBytes(32);
  const device = await p2p.generateDeviceSigningKeyPair();
  const pub = p2p.toBase64Url(await p2p.exportPublicKeyRaw(device.publicKey));
  const founderBlind = await p2p.deriveAuthorDeviceIdBlind(
    epoch0Secret,
    roomIdCommitment,
    'founder-dev',
    0,
  );
  const params = {
    roomId: ROOM,
    roomIdCommitment,
    epochs: new Map([[0, { roomEpochSecret: epoch0Secret, contentWrapKey }]]),
    bootstrapDevices: [{ deviceId: 'founder-dev', signingPublicKey: pub }],
  };
  const genesis = p2p.privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: ROOM,
    epoch: 0,
    op_id: 'genesis',
    author_member_id: 'founder',
    author_device_id: 'founder-dev',
    author_seq: 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: '1',
    parents: [],
    body: {
      type: 'member.add',
      member_id: 'founder',
      device_id: 'founder-dev',
      signing_public_key: pub,
      hpke_public_key: 'AAAA',
      mls_key_package: 'AAAA',
      granted_role: 'admin',
    },
  });
  const sealParams = {
    roomIdCommitment,
    contentWrapKey,
    deviceSigningKey: device.privateKey,
    authorDeviceIdBlind: founderBlind,
    capabilityRootAtSeq: p2p.randomBytes(16),
  };
  return { params, genesis, sealParams };
}

describe('IndexedDbPrivateRoomStorage', () => {
  it('round-trips an envelope and isolates rooms', async () => {
    const { genesis, sealParams } = await founderRoom();
    const envelope = await p2p.sealOp(genesis, sealParams);

    const roomA = new IndexedDbPrivateRoomStorage('room-A');
    const roomB = new IndexedDbPrivateRoomStorage('room-B');
    await roomA.putEnvelope('genesis', envelope);

    const listedA = await roomA.listEnvelopes();
    expect(listedA).toHaveLength(1);
    expect(listedA[0]?.opId).toBe('genesis');
    // Room B sees nothing — the by_room index isolates rooms.
    expect(await roomB.listEnvelopes()).toHaveLength(0);
  });

  it('upserts idempotently on (roomId, opId)', async () => {
    const { genesis, sealParams } = await founderRoom();
    const envelope = await p2p.sealOp(genesis, sealParams);
    const store = new IndexedDbPrivateRoomStorage('room-A');
    await store.putEnvelope('genesis', envelope);
    await store.putEnvelope('genesis', envelope);
    expect(await store.listEnvelopes()).toHaveLength(1);
  });
});

describe('loadPrivateRoomEngine — persists to IndexedDB + re-verifies on reload', () => {
  it('founds a room, persists it, and a fresh engine re-loads it', async () => {
    const { params, genesis, sealParams } = await founderRoom();

    const engine = await loadPrivateRoomEngine(params);
    const report = await engine.applyLocalOp(genesis, sealParams);
    expect(report.accepted).toStrictEqual(['genesis']);
    expect(engine.state().members.get('founder')?.role).toBe('admin');

    // A brand-new engine over the SAME room re-reads IndexedDB + re-verifies.
    const reloaded = await loadPrivateRoomEngine(params);
    expect(reloaded.state().members.get('founder')?.role).toBe('admin');
    expect(reloaded.heads()).toStrictEqual(['genesis']);
  });
});

describe('PrivateRoomSession — §14.5 compaction persistence (WS-S.7)', () => {
  it('compacts on cadence, prunes the pruned envelopes, and reloads from the base', async () => {
    // A low cadence so a few posts trigger compaction within the test.
    const session = await PrivateRoomSession.create({
      roomName: 'Compact Room',
      roomType: 'global_topic',
      founderMemberId: globalThis.crypto.randomUUID(),
      founderDeviceId: globalThis.crypto.randomUUID(),
      compactEveryOps: 2,
    });
    const roomId = session.roomId;
    await session.postStory({ title: 'A' });
    await session.postStory({ title: 'B' });
    await session.postStory({ title: 'C' });
    expect([...session.state().stories.values()].map((s) => s.title).sort()).toStrictEqual([
      'A',
      'B',
      'C',
    ]);

    // Every op was folded into the persisted base → no loose envelopes remain in
    // IndexedDB (they were pruned by `maybeCompact`).
    const storage = new IndexedDbPrivateRoomStorage(roomId);
    expect(await storage.listEnvelopes()).toHaveLength(0);

    // A fresh session reloads from the persisted base ALONE (zero envelopes to
    // re-verify) and still has the full state.
    const reloaded = await PrivateRoomSession.load(roomId);
    if (!reloaded) throw new Error('expected the room to reload');
    expect([...reloaded.state().stories.values()].map((s) => s.title).sort()).toStrictEqual([
      'A',
      'B',
      'C',
    ]);
    // …and it can author further on top of the reloaded base.
    await reloaded.postStory({ title: 'D' });
    expect([...reloaded.state().stories.values()].map((s) => s.title).sort()).toStrictEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });
});
