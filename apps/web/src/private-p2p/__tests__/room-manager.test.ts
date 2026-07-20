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
import type { PrivateEncryptedEnvelope, PrivateRoomStorage } from '@licio/private-p2p';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadPrivateRoomEngine, PrivateRoomSession } from '../room-manager.js';
import { IndexedDbPrivateRoomStorage, PRIVATE_P2P_DB_NAME } from '../storage.js';
import type { PeerChannel } from '../sync-session.js';

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
    op_id: await p2p.deriveOpId('founder-dev', 0),
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
    expect(report.accepted).toStrictEqual([genesis.op_id]);
    expect(engine.state().members.get('founder')?.role).toBe('admin');

    // A brand-new engine over the SAME room re-reads IndexedDB + re-verifies.
    const reloaded = await loadPrivateRoomEngine(params);
    expect(reloaded.state().members.get('founder')?.role).toBe('admin');
    expect(reloaded.heads()).toStrictEqual([genesis.op_id]);
  });
});

describe('PrivateRoomSession — Tier-2 rendezvous cap (WS-S)', () => {
  it('drives the cap on ingest — the device publishes its blind commitment (once)', async () => {
    const founderDeviceId = globalThis.crypto.randomUUID();
    const session = await PrivateRoomSession.create({
      roomName: 'Cap Room',
      roomType: 'global_topic',
      founderMemberId: globalThis.crypto.randomUUID(),
      founderDeviceId,
    });
    // Before any sync: no rendezvous commitment.
    expect(session.state().devices.get(founderDeviceId)?.rendezvousCommitment).toBeUndefined();

    // An ingest drives syncCap → the device authors a rendezvous.request (best-effort wiring
    // that MUST actually fire — if it silently failed, the commitment would stay undefined).
    await session.ingest([]);
    const commitment = session.state().devices.get(founderDeviceId)?.rendezvousCommitment;
    expect(commitment).toBeDefined();

    // Idempotent: a second sync does not re-publish (the converged state already has it).
    await session.ingest([]);
    expect(session.state().devices.get(founderDeviceId)?.rendezvousCommitment).toBe(commitment);
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

    // The covered ops were folded into the persisted base + pruned from IndexedDB
    // by `maybeCompact`; only the latest in-band §14.5 snapshot.commit remains.
    const storage = new IndexedDbPrivateRoomStorage(roomId);
    expect(await storage.listEnvelopes()).toHaveLength(1);

    // A fresh session reloads from the persisted SEALED base (re-verifying only the
    // retained snapshot.commit) and still has the full state.
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

describe('PrivateRoomSession.connectPeer — serializes the live-session engine surface (PRIV-WEB-SESSION-3)', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('queues a session-driven serveOps behind a held local authorOp (the engine never interleaves)', async () => {
    // A storage that PARKS the first ARMED `putEnvelope` on a test-controlled gate, so a local
    // `authorOp` can be held mid-critical-section — i.e. holding the manager op-lock — on demand.
    const inner = new p2p.InMemoryPrivateRoomStorage();
    let armed = false;
    let releaseGate: () => void = () => {};
    let signalReached: () => void = () => {};
    const reached = new Promise<void>((r) => {
      signalReached = r;
    });
    const gated: PrivateRoomStorage = {
      async putEnvelope(opId: string, envelope: PrivateEncryptedEnvelope): Promise<void> {
        if (armed) {
          armed = false; // gate only the FIRST armed write (the lock-holder authorOp)
          signalReached();
          await new Promise<void>((r) => {
            releaseGate = r;
          });
        }
        return inner.putEnvelope(opId, envelope);
      },
      listEnvelopes: () => inner.listEnvelopes(),
      deleteEnvelopes: (ids) => inner.deleteEnvelopes(ids),
      putBlock: (cid, bytes) => inner.putBlock(cid, bytes),
      getBlock: (cid) => inner.getBlock(cid),
      hasBlock: (cid) => inner.hasBlock(cid),
    };

    const session = await PrivateRoomSession.create({
      roomName: 'Serialize Room',
      roomType: 'global_topic',
      founderMemberId: globalThis.crypto.randomUUID(),
      founderDeviceId: globalThis.crypto.randomUUID(),
      createStorage: () => gated, // the engine's envelope store (genesis already written, gate disarmed)
    });

    // A capturing peer channel: record EVERY sent frame + grab the session's message listener.
    const sent: Uint8Array[] = [];
    let deliver: (frame: Uint8Array) => void = () => {};
    const channel: PeerChannel = {
      send: (frame) => {
        sent.push(frame.slice());
      },
      onMessage: (listener) => {
        deliver = listener;
      },
      onClose: () => {},
      close: () => {},
    };
    const sync = session.connectPeer(channel); // sends an opening head_announcement (a sync read)
    const isOpResponse = (frame: Uint8Array): boolean => {
      try {
        return p2p.decodeSyncMessage(frame).schema === 'licio.private.op_response.v1';
      } catch {
        return false;
      }
    };

    // Hold the op-lock: a local `authorOp` (postStory) parked inside the gated `putEnvelope`.
    armed = true;
    const holding = session.postStory({ title: 'lock holder' });
    await reached; // the authorOp now HOLDS the op-lock (parked mid-`applyLocalOp`)

    // Deliver an op_request: the session's `serveOps` runs through the LOCKED engine surface, so it
    // must QUEUE behind the held authorOp and emit NO op_response while the lock is held.
    const request = p2p.encodeSyncMessage({
      schema: 'licio.private.op_request.v1',
      op_ids: [globalThis.crypto.randomUUID()],
    });
    deliver(request);
    await flush();
    // Before the fix (raw engine), serveOps would run immediately and send the response here.
    expect(sent.some(isOpResponse)).toBe(false);

    // Release the lock → the authorOp completes → the queued serveOps runs → the op_response is sent.
    releaseGate();
    await holding;
    await flush();
    expect(sent.some(isOpResponse)).toBe(true);

    sync.close(false);
  });
});
