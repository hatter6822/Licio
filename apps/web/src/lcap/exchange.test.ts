// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.10 — the client §16 exchange ENGINE moves content end-to-end: peer A advertises a gap
// (a quarantined missing dependency) as a `want`; peer B serves it from its `lcap_v2` store; A
// ingests the served `response_pack` and now HOLDS the content (CID-verified, no transport trust).
// Two isolated fake-indexeddb stores stand in for the two devices.

import 'fake-indexeddb/auto';
import { cidFor } from '@licio/lcap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LCAP_DB_VERSION, LCAP_MIGRATIONS, LCAP_STORE, openLcapDb } from './db.js';
import {
  buildClientExchangeRequest,
  ingestClientExchangeResponse,
  ingestPackIntoStore,
  requestHasUnfilledWants,
  respondToClientExchange,
  responsePrivacyLabel,
} from './exchange.js';
import type { RecordRow } from './store.js';
import {
  bytesToHex,
  collectShareableRecordRows,
  getHeldObject,
  putBlock,
  readBlockBytes,
  roomHashToBytes,
} from './store.js';

/** The AUTHENTIC room key for a roomId — `hex(roomIdHash('licio', roomId))` — matching the client's
 *  #BG derivation (default networkId 'licio'), so a fixture's stored room hash is the one a record's
 *  signed body authenticates to. */
async function roomKeyHex(lcap: typeof import('@licio/lcap'), roomId: string): Promise<string> {
  return bytesToHex(await lcap.roomIdHash('licio', roomId));
}

let peerA: IDBDatabase;
let peerB: IDBDatabase;

beforeEach(async () => {
  const suffix = Math.random().toString(36).slice(2);
  peerA = await openLcapDb(`lcap_v2-xchg-A-${suffix}`, LCAP_DB_VERSION, LCAP_MIGRATIONS);
  peerB = await openLcapDb(`lcap_v2-xchg-B-${suffix}`, LCAP_DB_VERSION, LCAP_MIGRATIONS);
});

afterEach(() => {
  peerA.close();
  peerB.close();
});

/** Write a quarantine row so `collectQuarantineWants` advertises `missing` as a §16 `want`. */
async function quarantineMissing(
  db: IDBDatabase,
  parentCid: string,
  missing: string[],
  roomHash?: string,
  publicFlag?: boolean,
): Promise<void> {
  const tx = db.transaction(LCAP_STORE.quarantine, 'readwrite');
  tx.objectStore(LCAP_STORE.quarantine).put({
    cid: parentCid,
    reason: 'missing_dependency',
    firstSeen: 1,
    missingDeps: missing,
    byteSize: 0,
    ...(roomHash !== undefined ? { roomHash } : {}),
    ...(publicFlag !== undefined ? { public: publicFlag } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Put a real, decodable contribution_event record (the given visibility) into `db`'s records. */
let recordSeq = 0;

async function putPublicRecord(
  db: IDBDatabase,
  lcap: typeof import('@licio/lcap'),
  visibility: 'public' | 'in_room' | 'private',
  opts: {
    deps?: string[];
    recordDeps?: string[];
    priority?: 0 | 1 | 2 | 3 | 4;
    roomHash?: string;
  } = {},
): Promise<string> {
  const capabilityCid = await lcap.cidFor('record', new Uint8Array([0]));
  const priority = opts.priority ?? 2;
  const seq = recordSeq++; // distinct per call so records never collide on recordCid
  const body = lcap.encodeContributionEvent({
    record_version: 2,
    kind: 'contribution_event',
    event_type: 'post',
    home_room_id: 'room-1',
    visibility_scope: visibility,
    author_account_id: 'acct',
    author_device_id: 'dev',
    author_device_key_id: 'key',
    device_seq: seq + 1,
    capability_cid: capabilityCid,
    policy_epoch_claim: 0,
    revocation_epoch_claim: 0,
    client_nonce: new Uint8Array([1, 2, 3, seq & 0xff]),
    priority,
    // The record's content block in the SIGNED body — so the share closure derives it from the body
    // (#O), not from unauthenticated row.deps metadata.  Tests pass the block as the single dep.
    ...(opts.deps?.[0] !== undefined ? { body_block_cid: opts.deps[0] } : {}),
    // RECORD prerequisites in the SIGNED body (#RR test) — the repack derives the pack-entry deps the
    // peer's importPack resolves over from these, so a dropped one re-quarantines this record.
    ...(opts.recordDeps !== undefined ? { parent_record_cids: opts.recordDeps } : {}),
  });
  const recordCid = await lcap.cidFor('record', body);
  const tx = db.transaction(LCAP_STORE.records, 'readwrite');
  tx.objectStore(LCAP_STORE.records).put({
    recordCid,
    body,
    kind: 'contribution_event',
    lane: 'C0',
    priority,
    roomHash: opts.roomHash ?? '',
    state: 'integrity_verified',
    size: body.length,
    ...(opts.deps ? { deps: opts.deps } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return recordCid;
}

/** Put a `room_capability` record with the given visibility (room_capability ALSO carries
 *  visibility_scope — the #5 case the contribution-only filter missed). */
async function putCapabilityRecord(
  db: IDBDatabase,
  lcap: typeof import('@licio/lcap'),
  visibility: 'public' | 'in_room' | 'private',
  roomId = 'room-1',
): Promise<string> {
  const body = lcap.encodeWithSchema(lcap.capabilityRecordV2Schema, {
    record_version: 2,
    kind: 'room_capability',
    capability_id: `cap-${visibility}-${roomId}`,
    subject_account_id: 'acct',
    subject_device_id: 'dev',
    subject_device_key_id: 'key',
    room_id: roomId,
    visibility_scope: visibility,
    operations: [],
    policy_epoch: 0,
    revocation_epoch_floor: 0,
    not_before_ms: 0,
    not_after_ms: 1_000_000,
    quotas: {
      max_offline_events: 10,
      max_total_payload_bytes: 1000,
      max_single_event_bytes: 100,
      max_media_bytes: 100,
    },
    transfer_policy: {
      may_export_bundle: false,
      may_share_with_relay: true,
      may_share_with_courier: true,
      may_share_with_unknown_peer: true,
    },
  });
  const recordCid = await lcap.cidFor('record', body);
  // Store the AUTHENTIC room hash the body authenticates to, so the repack stamps a table room_id_hash
  // the importer's #BG cross-check accepts.
  const roomHash = await roomKeyHex(lcap, roomId);
  const tx = db.transaction(LCAP_STORE.records, 'readwrite');
  tx.objectStore(LCAP_STORE.records).put({
    recordCid,
    body,
    kind: 'room_capability',
    lane: 'C0',
    priority: 0,
    roomHash,
    state: 'integrity_verified',
    size: body.length,
  });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return recordCid;
}

describe('client §16 exchange engine', () => {
  it('moves content: A wants a quarantined dep → B serves it → A ingests + holds it', async () => {
    // B holds a block A is missing — reachable from a PUBLIC record B holds (so it is shareable;
    // an orphan block with no public record referencing it is correctly NOT served).
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    const lcap = await import('@licio/lcap');
    await putPublicRecord(peerB, lcap, 'public', { deps: [blockCid] });

    // A has quarantined some parent record awaiting that block.
    await quarantineMissing(peerA, 'parent-record-cid', [blockCid]);
    expect(await readBlockBytes(peerA, blockCid)).toBeUndefined(); // A does NOT have it yet

    // A builds a request advertising the want; B serves it; A ingests the response.
    const request = await buildClientExchangeRequest(peerA, 'courier');
    const response = await respondToClientExchange(peerB, request);
    expect(response).not.toBeNull();
    const counts = await ingestClientExchangeResponse(peerA, response as Uint8Array);

    expect(counts?.blocks).toBe(1); // the served block was committed
    expect(await readBlockBytes(peerA, blockCid)).toEqual(bytes); // A now HOLDS the content
  });

  it('SECURITY: never serves a block that belongs to a NON-PUBLIC record (even if wanted)', async () => {
    const bytes = new Uint8Array([1, 1, 2, 3, 5]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    const lcap = await import('@licio/lcap');
    await putPublicRecord(peerB, lcap, 'in_room', { deps: [blockCid] }); // the block's record is in_room
    await quarantineMissing(peerA, 'parent', [blockCid]);

    const request = await buildClientExchangeRequest(peerA, 'courier');
    const response = await respondToClientExchange(peerB, request);
    const counts = await ingestClientExchangeResponse(peerA, response as Uint8Array);
    expect(counts).toBeNull(); // nothing served — the in-room block never leaves the device
    expect(await readBlockBytes(peerA, blockCid)).toBeUndefined();
  });

  it('SECURITY: a priority cap keeps over-priority content from being served', async () => {
    const bytes = new Uint8Array([9, 9, 9, 9]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    const lcap = await import('@licio/lcap');
    await putPublicRecord(peerB, lcap, 'public', { deps: [blockCid], priority: 4 }); // P4
    await quarantineMissing(peerA, 'parent', [blockCid]);

    const request = await buildClientExchangeRequest(peerA, 'courier');
    // The responder caps sharing at P1 — the P4 record (+ its block) is NOT served.
    const response = await respondToClientExchange(peerB, request, { maxPriorityClass: 1 });
    expect(await ingestClientExchangeResponse(peerA, response as Uint8Array)).toBeNull();
  });

  it('SECURITY: a room allowlist keeps other rooms’ content from being served', async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    const lcap = await import('@licio/lcap');
    await putPublicRecord(peerB, lcap, 'public', { deps: [blockCid], roomHash: 'room-X' });
    await quarantineMissing(peerA, 'parent', [blockCid]);

    const request = await buildClientExchangeRequest(peerA, 'courier');
    // The responder shares only `room-Y` — `room-X`'s content (+ its block) is NOT served.
    const response = await respondToClientExchange(peerB, request, {
      roomHashAllowlist: ['room-Y'],
    });
    expect(await ingestClientExchangeResponse(peerA, response as Uint8Array)).toBeNull();
  });

  it('a room-scoped REQUEST advertises ONLY the scoped room’s gaps (#K)', async () => {
    const lcap = await import('@licio/lcap');
    const depY = await cidFor('record', new Uint8Array([1]));
    const depX = await cidFor('record', new Uint8Array([2]));
    await quarantineMissing(peerA, 'parentY', [depY], 'bbbbbbbb');
    await quarantineMissing(peerA, 'parentX', [depX], 'aaaaaaaa');
    const request = await buildClientExchangeRequest(peerA, 'courier', {
      roomHashAllowlist: ['bbbbbbbb'],
    });
    const decoded = lcap.decodeWithSchema(lcap.exchangeRequestV2Schema, request);
    const wantCids = (decoded.want ?? []).map((w) => w.cid);
    expect(wantCids).toContain(depY);
    expect(wantCids).not.toContain(depX); // an unrelated room's gap is never advertised
  });

  it('a request never exceeds its advertised max_request_bytes, even with many wants (#AK)', async () => {
    const lcap = await import('@licio/lcap');
    // Seed far more distinct quarantine gaps than fit a minimal-mode budget.
    for (let i = 0; i < 300; i++) {
      await quarantineMissing(peerA, `parent-${i}`, [
        await cidFor('record', new Uint8Array([i & 0xff, (i >> 8) & 0xff])),
      ]);
    }
    // The MINIMAL (stealth) budget is tight enough that 300 wants exercise the trim.
    const request = await buildClientExchangeRequest(peerA, 'courier', undefined, true);
    const decoded = lcap.decodeWithSchema(lcap.exchangeRequestV2Schema, request);
    // The WHOLE encoded request (pulse + wants + push + wrapper), not just the push, fits the budget.
    expect(request.length).toBeLessThanOrEqual(decoded.pulse.budgets.max_request_bytes);
  });

  it('SECURITY: a NON-PUBLIC quarantine row never advertises its wants on the public plane (#NN)', async () => {
    const lcap = await import('@licio/lcap');
    const publicWant = await cidFor('record', new Uint8Array([7]));
    const privateWant = await cidFor('record', new Uint8Array([8]));
    // A PUBLIC quarantine row (gap safe to advertise) and a NON-PUBLIC one (an in_room/private record
    // from a manual contains_in_room_metadata file import) — only the public want may leave (#NN).
    await quarantineMissing(peerA, 'pubrec', [publicWant], undefined, true);
    await quarantineMissing(peerA, 'privrec', [privateWant], undefined, false);

    const request = await buildClientExchangeRequest(peerA, 'courier');
    const decoded = lcap.decodeWithSchema(lcap.exchangeRequestV2Schema, request);
    const wantCids = (decoded.want ?? []).map((w) => w.cid);
    expect(wantCids).toContain(publicWant);
    expect(wantCids).not.toContain(privateWant); // the in_room gap never leaks on the courier plane
  });

  it('a courier pulse is HONEST: full budget by default, a shrunk SELECTION budget only when minimal (#XX)', async () => {
    const lcap = await import('@licio/lcap');
    // Default courier: an HONEST FULL budget — a courier FERRIES content, so it must be able to fetch
    // the priority-2 / media blocks it wants; it must NOT falsely claim minimal_mode (#XX).
    const full = lcap.decodeWithSchema(
      lcap.exchangeRequestV2Schema,
      await buildClientExchangeRequest(peerA, 'courier'),
    );
    expect(full.pulse.budgets.minimal_mode).not.toBe(true);
    expect(full.pulse.budgets.allow_media).toBe(true);
    expect(full.pulse.budgets.max_response_bytes).toBe(lcap.DEFAULT_BUDGET.max_response_bytes);
    // Explicit SELECTION-minimal (stealth / emergency): the numerics AND the priority/media floor
    // shrink TOGETHER — not just the flag.
    const min = lcap.decodeWithSchema(
      lcap.exchangeRequestV2Schema,
      await buildClientExchangeRequest(peerA, 'courier', undefined, true),
    );
    expect(min.pulse.budgets.minimal_mode).toBe(true);
    expect(min.pulse.budgets.max_response_bytes).toBeLessThan(
      lcap.DEFAULT_BUDGET.max_response_bytes,
    );
    expect(min.pulse.budgets.allow_media).toBe(false);
  });

  it('SECURITY: a responder honors the peer’s SELECTION floor for media (minimal request) but serves it on a full one (#BF)', async () => {
    const lcap = await import('@licio/lcap');
    // B holds a media block reachable from a PUBLIC record (so it is shareable).
    const bytes = new Uint8Array([4, 4, 4, 4]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    await putPublicRecord(peerB, lcap, 'public', { deps: [blockCid] });
    await quarantineMissing(peerA, 'parent', [blockCid]);

    // A MINIMAL (stealth) request: allow_media false → the responder WITHHOLDS the media block.
    const minReq = await buildClientExchangeRequest(peerA, 'courier', undefined, true);
    const minResp = await respondToClientExchange(peerB, minReq);
    if (minResp) await ingestClientExchangeResponse(peerA, minResp);
    expect(await readBlockBytes(peerA, blockCid)).toBeUndefined(); // withheld for the minimal selection (#BF)

    // A DEFAULT (full) courier request: the same block IS served (a courier ferries full content).
    const fullReq = await buildClientExchangeRequest(peerA, 'courier');
    const fullResp = await respondToClientExchange(peerB, fullReq);
    if (fullResp) await ingestClientExchangeResponse(peerA, fullResp);
    expect(await readBlockBytes(peerA, blockCid)).toEqual(bytes);
  });

  it('a minimal PUSH pack honors the priority floor — excludes over-floor records (PUB-EXCHANGE-2)', async () => {
    const lcap = await import('@licio/lcap');
    // peerA holds two shareable PUBLIC records: a P0 (within the minimal floor) + a P3 (over it).
    const p0 = await putPublicRecord(peerA, lcap, 'public', { priority: 0 });
    const p3 = await putPublicRecord(peerA, lcap, 'public', { priority: 3 });

    // MINIMAL (stealth) request: priority_floor 1 ⇒ the gossip-out push carries P0 but NOT P3.
    const minReq = lcap.decodeWithSchema(
      lcap.exchangeRequestV2Schema,
      await buildClientExchangeRequest(peerA, 'courier', undefined, true),
    );
    expect(minReq.push_pack).toBeDefined();
    const minRead = await lcap.readPack(minReq.push_pack as Uint8Array);
    if (!minRead.ok) throw new Error('minimal push pack unreadable');
    expect(minRead.pack.frames.has(p0)).toBe(true);
    expect(minRead.pack.frames.has(p3)).toBe(false); // over the floor ⇒ excluded (PUB-EXCHANGE-1)

    // FULL request: the push carries BOTH (no selection floor).
    const fullReq = lcap.decodeWithSchema(
      lcap.exchangeRequestV2Schema,
      await buildClientExchangeRequest(peerA, 'courier'),
    );
    const fullRead = await lcap.readPack(fullReq.push_pack as Uint8Array);
    if (!fullRead.ok) throw new Error('full push pack unreadable');
    expect(fullRead.pack.frames.has(p3)).toBe(true);
  });

  it('a minimal PUSH pack WITHHOLDS a within-floor record’s B4 body block (PUB-EXCHANGE-1)', async () => {
    const lcap = await import('@licio/lcap');
    // A P0 record (WITHIN the minimal floor) whose SIGNED body references a body block.  A block is
    // class B4 (priority 4) — OVER a priority_floor of 1 — so the minimal push must carry the record
    // but NOT the block (the bug: the record's deps were seeded regardless of the advertised floor).
    const blockBytes = new Uint8Array([4, 4, 4, 4]);
    const blockCid = await lcap.cidFor('block', blockBytes);
    await putBlock(peerA, { blockCid, state: 'integrity_verified', size: blockBytes.length }, [
      blockBytes,
    ]);
    const p0 = await putPublicRecord(peerA, lcap, 'public', { priority: 0, deps: [blockCid] });

    // MINIMAL (stealth) push: priority_floor 1 ⇒ the P0 RECORD is carried, its B4 block is withheld.
    const minReq = lcap.decodeWithSchema(
      lcap.exchangeRequestV2Schema,
      await buildClientExchangeRequest(peerA, 'courier', undefined, true),
    );
    const minRead = await lcap.readPack(minReq.push_pack as Uint8Array);
    if (!minRead.ok) throw new Error('minimal push pack unreadable');
    expect(minRead.pack.frames.has(p0)).toBe(true); // within the floor
    expect(minRead.pack.frames.has(blockCid)).toBe(false); // B4 ⇒ over the floor ⇒ withheld

    // FULL push: no selection floor ⇒ the record AND its block are both carried.
    const fullReq = lcap.decodeWithSchema(
      lcap.exchangeRequestV2Schema,
      await buildClientExchangeRequest(peerA, 'courier'),
    );
    const fullRead = await lcap.readPack(fullReq.push_pack as Uint8Array);
    if (!fullRead.ok) throw new Error('full push pack unreadable');
    expect(fullRead.pack.frames.has(p0)).toBe(true);
    expect(fullRead.pack.frames.has(blockCid)).toBe(true);
  });

  it('SECURITY: a scoped INGEST does not admit a block matching an UNRELATED room’s gap (#UU)', async () => {
    const roomA = 'aaaaaaaaaaaaaaaa';
    const roomB = 'bbbbbbbbbbbbbbbb';
    const bytes = new Uint8Array([7, 7, 7, 1]);
    const blockCid = await cidFor('block', bytes);
    // A holds a quarantine gap for that block in room A — UNRELATED to the room-B sync below.
    await quarantineMissing(peerA, 'parent', [blockCid], roomA);
    // B serves a pack that happens to carry that block; A ingests it SCOPED to room B only.
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    const lcap = await import('@licio/lcap');
    const pack = await lcap.repackHeldObjects(
      (cid) => getHeldObject(peerB, cid),
      [blockCid],
      1_000_000,
    );
    await ingestPackIntoStore(peerA, pack.pack as Uint8Array, { roomHashAllowlist: [roomB] });

    // room A's gap must NOT admit the block into the room-B-scoped closure (#UU).
    expect(await readBlockBytes(peerA, blockCid)).toBeUndefined();
  });

  it('counts WANTS after de-dup so a distinct gap is not starved by many shared rows (#I)', async () => {
    const lcap = await import('@licio/lcap');
    const depShared = await cidFor('record', new Uint8Array([3]));
    const depDistinct = await cidFor('record', new Uint8Array([4]));
    // 260 rows (> the 256 want cap) all share ONE missing dep; ONE later-sorting row has a DISTINCT
    // dep.  Capping by raw rows would read only the 256 shared rows and never advertise the distinct
    // gap; counting UNIQUE wants reaches it.
    const tx = peerA.transaction(LCAP_STORE.quarantine, 'readwrite');
    const store = tx.objectStore(LCAP_STORE.quarantine);
    for (let i = 0; i < 260; i++) {
      store.put({
        cid: `a-shared-${i}`,
        reason: 'missing_dependency',
        firstSeen: 1,
        missingDeps: [depShared],
        byteSize: 0,
      });
    }
    store.put({
      cid: 'z-distinct',
      reason: 'missing_dependency',
      firstSeen: 1,
      missingDeps: [depDistinct],
      byteSize: 0,
    });
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    const request = await buildClientExchangeRequest(peerA, 'courier');
    const decoded = lcap.decodeWithSchema(lcap.exchangeRequestV2Schema, request);
    const wantCids = new Set((decoded.want ?? []).map((w) => w.cid));
    expect(wantCids.has(depShared)).toBe(true);
    expect(wantCids.has(depDistinct)).toBe(true); // not starved by the 260 shared rows
  });

  it('SECURITY: a room-scoped INGEST commits ONLY the allowlisted room’s records (#M)', async () => {
    const lcap = await import('@licio/lcap');
    const roomA = 'aaaaaaaaaaaaaaaa';
    const roomB = 'bbbbbbbbbbbbbbbb';
    const capA = await putCapabilityRecord(peerB, lcap, 'public', roomA);
    const capB = await putCapabilityRecord(peerB, lcap, 'public', roomB);
    // A pack carrying BOTH rooms' records, as a (possibly hostile) peer's response_pack would.
    const pack = await lcap.repackHeldObjects(
      (cid) => getHeldObject(peerB, cid),
      [capA, capB],
      1_000_000,
    );
    const counts = await ingestPackIntoStore(peerA, pack.pack as Uint8Array, {
      roomHashAllowlist: [await roomKeyHex(lcap, roomB)],
    });
    expect(counts?.records).toBe(1); // only roomB's record committed
    expect(await getHeldObject(peerA, capB)).toBeDefined();
    expect(await getHeldObject(peerA, capA)).toBeUndefined(); // roomA dropped past the scope
  });

  it('SECURITY: a public record requiring a DROPPED (non-public) dep is re-quarantined, not committed (#RR)', async () => {
    const lcap = await import('@licio/lcap');
    // D: a NON-PUBLIC record the public ingress will drop.  R: a PUBLIC record that DECLARES D as a
    // dep.  importPack resolves R's dep over every CID-verified frame (D is present in the pack), so
    // without #RR R would commit even though D is filtered out and absent from the store.
    const depRecord = await putPublicRecord(peerB, lcap, 'in_room');
    const publicRecord = await putPublicRecord(peerB, lcap, 'public', { recordDeps: [depRecord] });
    const pack = await lcap.repackHeldObjects(
      (cid) => getHeldObject(peerB, cid),
      [publicRecord, depRecord],
      1_000_000,
    );

    const counts = await ingestPackIntoStore(peerA, pack.pack as Uint8Array);
    expect(counts?.records).toBe(0); // R was NOT committed — its dropped dep re-quarantined it (#RR)
    expect(await getHeldObject(peerA, publicRecord)).toBeUndefined(); // R is not in the records store
    expect(await getHeldObject(peerA, depRecord)).toBeUndefined(); // D was dropped (non-public)
    expect(counts?.quarantined).toBeGreaterThan(0); // R's gap is now tracked as a want
  });

  it('serves a held CHUNK as a chunk frame — its CID kind is preserved, not reported as block (#AN)', async () => {
    const lcap = await import('@licio/lcap');
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const chunkCid = await lcap.cidFor('chunk', bytes); // a CHUNK CID (distinct kind prefix)
    await putBlock(peerB, { blockCid: chunkCid, state: 'integrity_verified', size: bytes.length }, [
      bytes,
    ]);
    const held = await getHeldObject(peerB, chunkCid);
    expect(held?.kind).toBe('chunk'); // derived from the CID prefix, NOT reported as 'block' (#AN)
  });

  it('SECURITY: a NON-PUBLIC quarantine gap does not admit a block on the public plane (#AO)', async () => {
    const bytes = new Uint8Array([8, 8, 8, 1]);
    const blockCid = await cidFor('block', bytes);
    // A NON-PUBLIC quarantine row (an in_room/private file import) whose missing dep is this block.
    await quarantineMissing(peerA, 'privrec', [blockCid], undefined, false);
    // A public pack that happens to carry that block (no record references it).
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    const lcap = await import('@licio/lcap');
    const pack = await lcap.repackHeldObjects(
      (cid) => getHeldObject(peerB, cid),
      [blockCid],
      1_000_000,
    );
    await ingestPackIntoStore(peerA, pack.pack as Uint8Array);
    // The non-public gap must NOT pull the block into the public-plane closure (#AO).
    expect(await readBlockBytes(peerA, blockCid)).toBeUndefined();
  });

  it('SECURITY: ingest re-checks shouldCommit at the LEAF (before the store write), not just the boundary (#BA)', async () => {
    const lcap = await import('@licio/lcap');
    const cap = await putCapabilityRecord(peerB, lcap, 'public', 'roomba');
    const pack = await lcap.repackHeldObjects((cid) => getHeldObject(peerB, cid), [cap], 1_000_000);

    // shouldCommit() FALSE — even though the read/import/closure all ran (awaits), nothing is written.
    const aborted = await ingestPackIntoStore(
      peerA,
      pack.pack as Uint8Array,
      undefined,
      () => false,
    );
    expect(aborted?.records).toBe(0);
    expect(await getHeldObject(peerA, cap)).toBeUndefined();

    // shouldCommit() TRUE — the same pack commits.
    const live = await ingestPackIntoStore(peerA, pack.pack as Uint8Array, undefined, () => true);
    expect(live?.records).toBe(1);
    expect(await getHeldObject(peerA, cap)).toBeDefined();
  });

  it('SECURITY: re-quarantines a record whose body needs a block the pack TABLE omits (#AC)', async () => {
    const lcap = await import('@licio/lcap');
    const missingBlock = await cidFor('block', new Uint8Array([7, 7, 7, 2])); // NOT in pack, NOT held
    const body = lcap.encodeContributionEvent({
      record_version: 2,
      kind: 'contribution_event',
      event_type: 'post',
      home_room_id: 'room-1',
      visibility_scope: 'public',
      author_account_id: 'a',
      author_device_id: 'd',
      author_device_key_id: 'k',
      device_seq: 1,
      capability_cid: await cidFor('record', new Uint8Array([0])),
      policy_epoch_claim: 0,
      revocation_epoch_claim: 0,
      client_nonce: new Uint8Array([3]),
      priority: 2,
      body_block_cid: missingBlock,
    });
    const recordCid = await cidFor('record', body);
    // A crafted pack whose record table deps are EMPTY (a peer omitted the body's block) — importPack
    // sees no missing dep and would commit the record even though its SIGNED body needs the absent block.
    const pack = await lcap.writePack({
      objects: [
        {
          cid: recordCid,
          cidKind: 'record',
          frameKind: 'record_body',
          payload: body,
          lane: 'C0',
          priority: 2,
          roomIdHash: await lcap.roomIdHash('licio', 'room-1'), // AUTHENTIC (matches the body's room, #BG)
          deps: [],
        },
      ],
      transportProfile: 'manual_bundle',
      privacyLabel: 'public',
      maxUncompressedBytes: body.length + 1024,
    });
    const counts = await ingestPackIntoStore(peerA, pack as Uint8Array);
    expect(counts?.records).toBe(0); // NOT committed — re-quarantined on the absent body block (#AC)
    expect(await getHeldObject(peerA, recordCid)).toBeUndefined();
    expect(counts?.quarantined).toBeGreaterThan(0); // the missing block is tracked as a want
  });

  it('SECURITY: the responder SKIPS the push ingest when liveness has gone false mid-build (#OO)', async () => {
    const lcap = await import('@licio/lcap');
    const bytes = new Uint8Array([5, 5, 5, 5]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    await putPublicRecord(peerB, lcap, 'public', { deps: [blockCid] });
    // peerB builds a request that PUSHES its shareable content (the record + its block).
    const request = await buildClientExchangeRequest(peerB, 'courier');

    // The courier was STOPPED while this responder was awaiting → the push must NOT be committed.
    await respondToClientExchange(peerA, request, undefined, () => false);
    expect(await readBlockBytes(peerA, blockCid)).toBeUndefined(); // push ingest gated off (#OO)

    // A LIVE check ingests the same push.
    await respondToClientExchange(peerA, request, undefined, () => true);
    expect(await readBlockBytes(peerA, blockCid)).toEqual(bytes);
  });

  it('SECURITY: a block listed only in row.deps metadata (not the signed body) is NOT shared (#O)', async () => {
    const lcap = await import('@licio/lcap');
    // A held block (e.g. another record's in-room media) that a crafted public record tries to ride.
    const secret = new Uint8Array([4, 2]);
    const secretBlockCid = await cidFor('block', secret);
    await putBlock(
      peerB,
      { blockCid: secretBlockCid, state: 'integrity_verified', size: secret.length },
      [secret],
    );
    // A PUBLIC record whose SIGNED body does NOT reference the block; only its row.deps metadata does.
    const body = lcap.encodeContributionEvent({
      record_version: 2,
      kind: 'contribution_event',
      event_type: 'post',
      home_room_id: 'room-1',
      visibility_scope: 'public',
      author_account_id: 'acct',
      author_device_id: 'dev',
      author_device_key_id: 'key',
      device_seq: 99,
      capability_cid: await lcap.cidFor('record', new Uint8Array([0])),
      policy_epoch_claim: 0,
      revocation_epoch_claim: 0,
      client_nonce: new Uint8Array([9, 9]),
      priority: 2,
    });
    const recordCid = await lcap.cidFor('record', body);
    const tx = peerB.transaction(LCAP_STORE.records, 'readwrite');
    tx.objectStore(LCAP_STORE.records).put({
      recordCid,
      body,
      kind: 'contribution_event',
      lane: 'C0',
      priority: 2,
      roomHash: '',
      state: 'integrity_verified',
      size: body.length,
      deps: [secretBlockCid], // unauthenticated metadata lists the block the body never references
    });
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    // A peer wants the secret block; the responder must NOT serve it (the body never references it).
    await quarantineMissing(peerA, 'parent', [secretBlockCid]);
    const request = await buildClientExchangeRequest(peerA, 'courier');
    const response = await respondToClientExchange(peerB, request);
    expect(await ingestClientExchangeResponse(peerA, response as Uint8Array)).toBeNull();
  });

  it('SECURITY: a record stamped with an allowed room hash but a DIFFERENT body room is dropped (#BG)', async () => {
    const lcap = await import('@licio/lcap');
    const body = lcap.encodeContributionEvent({
      record_version: 2,
      kind: 'contribution_event',
      event_type: 'post',
      home_room_id: 'roomA', // the SIGNED body authenticates to roomA
      visibility_scope: 'public',
      author_account_id: 'a',
      author_device_id: 'd',
      author_device_key_id: 'k',
      device_seq: 1,
      capability_cid: await cidFor('record', new Uint8Array([0])),
      policy_epoch_claim: 0,
      revocation_epoch_claim: 0,
      client_nonce: new Uint8Array([2]),
      priority: 2,
    });
    const recordCid = await cidFor('record', body);
    // The pack TABLE stamps roomB's (allowed) hash even though the signed body says roomA.
    const pack = await lcap.writePack({
      objects: [
        {
          cid: recordCid,
          cidKind: 'record',
          frameKind: 'record_body',
          payload: body,
          lane: 'C0',
          priority: 2,
          roomIdHash: await lcap.roomIdHash('licio', 'roomB'),
          deps: [],
        },
      ],
      transportProfile: 'manual_bundle',
      privacyLabel: 'public',
      maxUncompressedBytes: body.length + 1024,
    });
    const counts = await ingestPackIntoStore(peerA, pack as Uint8Array, {
      roomHashAllowlist: [await roomKeyHex(lcap, 'roomB')],
    });
    expect(counts?.records).toBe(0); // the spoofed record is NOT committed as roomB (#BG)
    expect(await getHeldObject(peerA, recordCid)).toBeUndefined();
  });

  it('SECURITY: a non-public record is NOT committed on the public ingress (#P)', async () => {
    const lcap = await import('@licio/lcap');
    const inRoomCid = await putCapabilityRecord(peerB, lcap, 'in_room', 'aaaaaaaa');
    const publicCid = await putCapabilityRecord(peerB, lcap, 'public', 'bbbbbbbb');
    // A pack carrying BOTH (as a hostile peer would), then the PUBLIC ingress commits only public.
    const pack = await lcap.repackHeldObjects(
      (cid) => getHeldObject(peerB, cid),
      [inRoomCid, publicCid],
      1_000_000,
    );
    const counts = await ingestPackIntoStore(peerA, pack.pack as Uint8Array);
    expect(counts?.records).toBe(1); // only the public record committed
    expect(await getHeldObject(peerA, publicCid)).toBeDefined();
    expect(await getHeldObject(peerA, inRoomCid)).toBeUndefined(); // the in_room record dropped (#P)
  });

  it('SECURITY: a scoped ingress drops a block no committed record / want references (#GG)', async () => {
    const lcap = await import('@licio/lcap');
    const wantedBytes = new Uint8Array([1, 1, 1]);
    const wantedCid = await cidFor('block', wantedBytes);
    const foreignBytes = new Uint8Array([2, 2, 2]);
    const foreignCid = await cidFor('block', foreignBytes);
    await putBlock(
      peerB,
      { blockCid: wantedCid, state: 'integrity_verified', size: wantedBytes.length },
      [wantedBytes],
    );
    await putBlock(
      peerB,
      { blockCid: foreignCid, state: 'integrity_verified', size: foreignBytes.length },
      [foreignBytes],
    );
    // A WANTS the wanted block; a hostile peer's pack ALSO attaches an unrelated foreign block.
    await quarantineMissing(peerA, 'parent', [wantedCid]);
    const pack = await lcap.repackHeldObjects(
      (cid) => getHeldObject(peerB, cid),
      [wantedCid, foreignCid],
      1_000_000,
    );
    await ingestPackIntoStore(peerA, pack.pack as Uint8Array);
    expect(await readBlockBytes(peerA, wantedCid)).toEqual(wantedBytes); // our WANT is committed
    expect(await readBlockBytes(peerA, foreignCid)).toBeUndefined(); // the foreign block is dropped
  });

  it('serves nothing (empty response) when the peer holds none of the wants', async () => {
    await quarantineMissing(peerA, 'parent', [await cidFor('block', new Uint8Array([9]))]);
    const request = await buildClientExchangeRequest(peerA, 'courier');
    const response = await respondToClientExchange(peerB, request); // B holds nothing
    expect(response).not.toBeNull();
    // A valid response with no response_pack ⇒ nothing to ingest.
    expect(await ingestClientExchangeResponse(peerA, response as Uint8Array)).toBeNull();
  });

  it('SECURITY: responsePrivacyLabel gates the RESPONDER leg fail-closed (PUB-RESPONDER-PUBLIC-ONLY)', async () => {
    const lcap = await import('@licio/lcap');
    // (a) UNDECODABLE bytes → a non-public label, so a carriesPrivate:false carrier DROPS the reply.
    expect(await responsePrivacyLabel(new Uint8Array([1, 2, 3, 4]))).not.toBe('public');

    // (b) a REAL public response (B serves a held public block) → 'public'.
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    await putPublicRecord(peerB, lcap, 'public', { deps: [blockCid] });
    await quarantineMissing(peerA, 'parent-cid', [blockCid]);
    const request = await buildClientExchangeRequest(peerA, 'courier');
    const publicResponse = (await respondToClientExchange(peerB, request)) as Uint8Array;
    expect(await responsePrivacyLabel(publicResponse)).toBe('public');

    // (c) a response carrying a NON-PUBLIC pack → the pack's own non-public label (fail closed).
    // Reuse the real response's valid pulse and swap in a non-public served pack.
    const decoded = lcap.decodeWithSchema(lcap.exchangeResponseV2Schema, publicResponse);
    const nonPublicPack = lcap.writePack({
      objects: [],
      transportProfile: 'relay',
      privacyLabel: 'contains_in_room_metadata',
      maxUncompressedBytes: 1_000_000,
    });
    const nonPublicResponse = lcap.encodeWithSchema(
      lcap.exchangeResponseV2Schema,
      lcap.buildExchangeResponse({
        pulse: decoded.pulse,
        status: 'ok',
        responsePack: nonPublicPack,
      }),
    );
    expect(await responsePrivacyLabel(nonPublicResponse)).toBe('contains_in_room_metadata');
  });

  it('PUSH (gossip-out): a request includes a push_pack of our PUBLIC content', async () => {
    const lcap = await import('@licio/lcap');
    await putPublicRecord(peerA, lcap, 'public');
    const request = await buildClientExchangeRequest(peerA, 'courier');
    const decoded = lcap.decodeWithSchema(lcap.exchangeRequestV2Schema, request);
    expect(decoded.push_pack).toBeDefined(); // our public record is gossiped out
  });

  it('PUSH is PUBLIC-ONLY: a non-public record is NEVER pushed', async () => {
    const lcap = await import('@licio/lcap');
    await putPublicRecord(peerA, lcap, 'in_room'); // the ONLY record A holds is non-public
    const request = await buildClientExchangeRequest(peerA, 'courier');
    const decoded = lcap.decodeWithSchema(lcap.exchangeRequestV2Schema, request);
    expect(decoded.push_pack).toBeUndefined(); // nothing public to push → no leak
  });

  it('getHeldObject threads a record’s CANONICAL room hash (hex → bytes) for the repack (#6)', async () => {
    const roomHex = 'a1a1a1a1a1a1a1a1';
    const capCid = await cidFor('record', new Uint8Array([1, 2, 3]));
    // The hex→bytes threading is a STORAGE concern, independent of the #BG room authentication — store a
    // record with a KNOWN stored roomHash directly.
    const storeRec = async (db: IDBDatabase, roomHash: string): Promise<void> => {
      const tx = db.transaction(LCAP_STORE.records, 'readwrite');
      tx.objectStore(LCAP_STORE.records).put({
        recordCid: capCid,
        body: new Uint8Array([1, 2, 3]),
        kind: 'room_capability',
        lane: 'C0',
        priority: 0,
        roomHash,
        state: 'integrity_verified',
        size: 3,
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    };
    await storeRec(peerA, roomHex);
    // The reader supplies the canonical room_id_hash bytes so the repack stamps the served record's
    // room — losslessly decoded from the stored hex (not the old lossy TextDecoder).
    expect((await getHeldObject(peerA, capCid))?.roomIdHash).toEqual(roomHashToBytes(roomHex));
    // A legacy / non-hex roomHash yields NO room hash (rather than a corrupt one).
    await storeRec(peerB, 'not-hex!');
    expect((await getHeldObject(peerB, capCid))?.roomIdHash).toBeUndefined();
  });

  it('SECURITY: a NON-PUBLIC room_capability is never pushed/shared (#5, not just contributions)', async () => {
    const lcap = await import('@licio/lcap');
    await putCapabilityRecord(peerA, lcap, 'in_room'); // the ONLY record A holds — an in-room cap
    const request = await buildClientExchangeRequest(peerA, 'courier');
    const decoded = lcap.decodeWithSchema(lcap.exchangeRequestV2Schema, request);
    expect(decoded.push_pack).toBeUndefined(); // the in-room capability is excluded (no leak)
    // A PUBLIC capability, by contrast, IS shareable.
    await putCapabilityRecord(peerB, lcap, 'public');
    const req2 = await buildClientExchangeRequest(peerB, 'courier');
    expect(lcap.decodeWithSchema(lcap.exchangeRequestV2Schema, req2).push_pack).toBeDefined();
  });

  it('a ROOM-SCOPED exchange does NOT ingest the peer’s ambient push (#10)', async () => {
    const lcap = await import('@licio/lcap');
    // A pushes a public, dep-free capability it holds; its request carries a push_pack.
    const pushedCid = await putCapabilityRecord(peerA, lcap, 'public');
    const request = await buildClientExchangeRequest(peerA, 'courier');
    expect(lcap.decodeWithSchema(lcap.exchangeRequestV2Schema, request).push_pack).toBeDefined();
    // B responds under a ROOM scope — it must NOT ingest A's ambient push for an unrelated room.
    await respondToClientExchange(peerB, request, { roomHashAllowlist: ['room-Y'] });
    expect(await getHeldObject(peerB, pushedCid)).toBeUndefined(); // not polluted by the push
    // Without a room scope, the SAME push IS ingested (ambient courier gossip).
    await respondToClientExchange(peerB, request);
    expect(await getHeldObject(peerB, pushedCid)).toBeDefined();
  });

  it('collectShareableRecordRows isolates by the room index + filters by predicate (#4)', async () => {
    const lcap = await import('@licio/lcap');
    // Records in two rooms; the room-scoped walk returns ONLY the target room's rows (via the index,
    // not a capped raw scan), so an in-scope record is found regardless of store position.
    await putPublicRecord(peerA, lcap, 'public', { roomHash: 'room-target' });
    await putPublicRecord(peerA, lcap, 'public', { roomHash: 'room-other' });
    await putPublicRecord(peerA, lcap, 'public', { roomHash: 'room-other' });
    const targeted = await collectShareableRecordRows(peerA, ['room-target'], 256, () => true);
    expect(targeted.map((r: RecordRow) => r.roomHash)).toEqual(['room-target']);
    // The cap counts SHAREABLE rows: a predicate rejecting all but one still yields that one.
    let kept = 0;
    const filtered = await collectShareableRecordRows(peerA, undefined, 256, () => {
      kept += 1;
      return kept === 2; // only the 2nd scanned row is "shareable"
    });
    expect(filtered).toHaveLength(1);
  });

  it('respondToClientExchange returns null for bytes that are not an exchange request', async () => {
    expect(await respondToClientExchange(peerB, new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('SECURITY: never serves an OVER-CAP record (repackHeldObjects would expand its deps O(n)) (#4)', async () => {
    const lcap = await import('@licio/lcap');
    // B holds a PUBLIC contribution whose signed body declares over-cap record fan-out (a legacy /
    // pre-fix record).  Serving it would make repackHeldObjects expand its full parent array into the
    // pack table — O(n) work / an oversized response for an invalid record.  It must be skipped.
    const overParents = await Promise.all(
      Array.from({ length: lcap.SERVER_CAPS.maxFanOut + 20 }, (_, i) =>
        cidFor('record', new Uint8Array([i & 0xff, (i >> 8) & 0xff, 4])),
      ),
    );
    const overCapRecordCid = await putPublicRecord(peerB, lcap, 'public', {
      recordDeps: overParents,
    });
    // A wants exactly that record.
    await quarantineMissing(peerA, 'parent', [overCapRecordCid]);
    const request = await buildClientExchangeRequest(peerA, 'courier');

    const response = await respondToClientExchange(peerB, request);
    expect(response).not.toBeNull();
    if (!response) return;
    const decoded = lcap.decodeWithSchema(lcap.exchangeResponseV2Schema, response);
    expect(decoded.response_pack).toBeUndefined(); // the over-cap record was NOT served (#4)
  });

  it('ingestPackIntoStore refuses non-pack bytes (fail-closed, commits nothing)', async () => {
    expect(await ingestPackIntoStore(peerA, new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });
});

describe('requestHasUnfilledWants — post-round anchor decision (#1/#BK)', () => {
  it('treats a want as FILLED once its CID is held, even though the quarantine row lingers', async () => {
    // Quarantine rows are NOT promoted on ingest, so after a peer push delivers a wanted block the
    // row still lists it — the anchor decision must key off what is HELD, not the stale row.
    const aBytes = new Uint8Array([10, 11]);
    const bBytes = new Uint8Array([12, 13]);
    const a = await cidFor('block', aBytes);
    const b = await cidFor('block', bBytes);
    await quarantineMissing(peerA, 'parent', [a, b]); // advertise BOTH as wants
    const request = await buildClientExchangeRequest(peerA, 'courier');

    expect(await requestHasUnfilledWants(peerA, request)).toBe(true); // neither held → real gaps

    // Hold one (as a push/response would deliver it) — the other is still an unfilled gap.
    await putBlock(peerA, { blockCid: a, state: 'integrity_verified', size: aBytes.length }, [
      aBytes,
    ]);
    expect(await requestHasUnfilledWants(peerA, request)).toBe(true);

    // Hold both → NO gap remains even though the stale quarantine row still lists them.
    await putBlock(peerA, { blockCid: b, state: 'integrity_verified', size: bBytes.length }, [
      bBytes,
    ]);
    expect(await requestHasUnfilledWants(peerA, request)).toBe(false);
  });

  it('returns false for a request advertising no wants', async () => {
    const request = await buildClientExchangeRequest(peerA, 'courier'); // empty quarantine → no wants
    expect(await requestHasUnfilledWants(peerA, request)).toBe(false);
  });

  it('fails OPEN (true) for an undecodable request — back off to the authoritative anchor', async () => {
    expect(await requestHasUnfilledWants(peerA, new Uint8Array([0, 1, 2, 3]))).toBe(true);
  });
});
