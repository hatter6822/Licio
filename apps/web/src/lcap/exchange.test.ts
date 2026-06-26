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
  respondToClientExchange,
} from './exchange.js';
import type { RecordRow } from './store.js';
import {
  collectShareableRecordRows,
  getHeldObject,
  putBlock,
  readBlockBytes,
  roomHashToBytes,
} from './store.js';

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
): Promise<void> {
  const tx = db.transaction(LCAP_STORE.quarantine, 'readwrite');
  tx.objectStore(LCAP_STORE.quarantine).put({
    cid: parentCid,
    reason: 'missing_dependency',
    firstSeen: 1,
    missingDeps: missing,
    byteSize: 0,
    ...(roomHash !== undefined ? { roomHash } : {}),
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
  opts: { deps?: string[]; priority?: 0 | 1 | 2 | 3 | 4; roomHash?: string } = {},
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
  roomHash = '',
): Promise<string> {
  const body = lcap.encodeWithSchema(lcap.capabilityRecordV2Schema, {
    record_version: 2,
    kind: 'room_capability',
    capability_id: `cap-${visibility}-${roomHash || 'room-1'}`,
    subject_account_id: 'acct',
    subject_device_id: 'dev',
    subject_device_key_id: 'key',
    room_id: roomHash || 'room-1',
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
      roomHashAllowlist: [roomB],
    });
    expect(counts?.records).toBe(1); // only roomB's record committed
    expect(await getHeldObject(peerA, capB)).toBeDefined();
    expect(await getHeldObject(peerA, capA)).toBeUndefined(); // roomA dropped past the scope
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
    const lcap = await import('@licio/lcap');
    const roomHex = 'a1a1a1a1a1a1a1a1';
    const capCid = await putCapabilityRecord(peerA, lcap, 'public', roomHex);
    const held = await getHeldObject(peerA, capCid);
    // The reader supplies the canonical room_id_hash bytes so the repack stamps the served record's
    // room — losslessly decoded from the stored hex (not the old lossy TextDecoder).
    expect(held?.roomIdHash).toEqual(roomHashToBytes(roomHex));
    // A legacy / non-hex roomHash yields NO room hash (rather than a corrupt one).
    const legacyCid = await putCapabilityRecord(peerB, lcap, 'public', 'not-hex!');
    expect((await getHeldObject(peerB, legacyCid))?.roomIdHash).toBeUndefined();
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

  it('ingestPackIntoStore refuses non-pack bytes (fail-closed, commits nothing)', async () => {
    expect(await ingestPackIntoStore(peerA, new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });
});
