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
import { putBlock, readBlockBytes } from './store.js';

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
): Promise<void> {
  const tx = db.transaction(LCAP_STORE.quarantine, 'readwrite');
  tx.objectStore(LCAP_STORE.quarantine).put({
    cid: parentCid,
    reason: 'missing_dependency',
    firstSeen: 1,
    missingDeps: missing,
    byteSize: 0,
  });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Put a real, decodable contribution_event record (the given visibility) into `db`'s records. */
async function putPublicRecord(
  db: IDBDatabase,
  lcap: typeof import('@licio/lcap'),
  visibility: 'public' | 'in_room' | 'private',
): Promise<string> {
  const capabilityCid = await lcap.cidFor('record', new Uint8Array([0]));
  const body = lcap.encodeContributionEvent({
    record_version: 2,
    kind: 'contribution_event',
    event_type: 'post',
    home_room_id: 'room-1',
    visibility_scope: visibility,
    author_account_id: 'acct',
    author_device_id: 'dev',
    author_device_key_id: 'key',
    device_seq: 1,
    capability_cid: capabilityCid,
    policy_epoch_claim: 0,
    revocation_epoch_claim: 0,
    client_nonce: new Uint8Array([1, 2, 3]),
    priority: 2,
  });
  const recordCid = await lcap.cidFor('record', body);
  const tx = db.transaction(LCAP_STORE.records, 'readwrite');
  tx.objectStore(LCAP_STORE.records).put({
    recordCid,
    body,
    kind: 'contribution_event',
    lane: 'C0',
    priority: 2,
    roomHash: '',
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
    // B holds a block A is missing.
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);

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

  it('respondToClientExchange returns null for bytes that are not an exchange request', async () => {
    expect(await respondToClientExchange(peerB, new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('ingestPackIntoStore refuses non-pack bytes (fail-closed, commits nothing)', async () => {
    expect(await ingestPackIntoStore(peerA, new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });
});
