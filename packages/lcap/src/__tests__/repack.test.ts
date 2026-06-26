// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The PURE §16.4 content-push repack (`repackHeldObjects`) — the shared assembly the server AND
// the client P2P responder reuse.  Drives it over an in-memory held-object reader (block frames,
// which need no record decode) to assert: served-in-request-order, skip-unheld, dedup, the
// budget-truncation boundary, the empty result, and a readPack round-trip (every served frame
// CID-verifies).

import { describe, expect, it } from 'vitest';
import { cidFor } from '../cid/index.js';
import { readPack } from '../pack/index.js';
import { encodeContributionEvent } from '../records/index.js';
import { type HeldObject, repackHeldObjects } from '../sync/repack.js';

async function block(bytes: Uint8Array): Promise<{ cid: string; held: HeldObject }> {
  const cid = await cidFor('block', bytes);
  return { cid, held: { kind: 'block', bytes } };
}

function readerOf(...entries: Array<{ cid: string; held: HeldObject }>) {
  const map = new Map(entries.map((e) => [e.cid, e.held]));
  return async (cid: string): Promise<HeldObject | undefined> => map.get(cid);
}

describe('repackHeldObjects (pure §16.4 content push)', () => {
  it('serves held wants in request order, skips unheld + dedups, and round-trips via readPack', async () => {
    const a = await block(new Uint8Array([1, 2, 3]));
    const b = await block(new Uint8Array([4, 5, 6, 7]));
    const getObject = readerOf(a, b);

    const result = await repackHeldObjects(
      getObject,
      [a.cid, 'cid-not-held', b.cid, a.cid /* dup */],
      1_000_000,
    );
    expect(result.served).toEqual([a.cid, b.cid]); // request order, unheld skipped, dup ignored
    expect(result.truncated).toBe(false);
    expect(result.pack).toBeInstanceOf(Uint8Array);

    const read = await readPack(result.pack as Uint8Array);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect([...read.pack.frames.keys()].sort()).toEqual([a.cid, b.cid].sort());
    for (const [cid, frame] of read.pack.frames) {
      expect(frame.cidVerified).toBe(true); // every served frame integrity-verifies on read
      expect(frame.frameKind).toBe('block');
      const want = cid === a.cid ? a.held.bytes : b.held.bytes;
      expect(frame.payload).toEqual(want);
    }
  });

  it('respects the byte budget (truncated) — even for a single oversized first want', async () => {
    const big = await block(new Uint8Array(4096).fill(9));
    const small = await block(new Uint8Array([1]));
    // A budget below the first object's size truncates immediately with nothing served.
    const none = await repackHeldObjects(readerOf(big, small), [big.cid, small.cid], 16);
    expect(none.served).toEqual([]);
    expect(none.truncated).toBe(true);
    expect(none.pack).toBeUndefined();

    // A budget that fits exactly one stops after it and marks the rest truncated.
    const oneFit = await repackHeldObjects(readerOf(small, big), [small.cid, big.cid], 512);
    expect(oneFit.served).toEqual([small.cid]);
    expect(oneFit.truncated).toBe(true);
  });

  it('returns an empty, pack-less result when no want is held', async () => {
    const result = await repackHeldObjects(readerOf(), ['x', 'y'], 1_000_000);
    expect(result).toEqual({ served: [], truncated: false });
    expect(result.pack).toBeUndefined();
  });

  it('threads a record’s ROOM + dep CIDs onto the repacked PackObject (#5)', async () => {
    // A record repacked from bytes alone must still carry its room (from the signed body) + its dep
    // CIDs — else the receiver lands it with roomHash:'' (invisible to room sync/export) + no
    // missing-dependency detection.
    const capabilityCid = await cidFor('record', new Uint8Array([0]));
    const bodyBlockCid = await cidFor('block', new Uint8Array([9, 9, 9]));
    const body = encodeContributionEvent({
      record_version: 2,
      kind: 'contribution_event',
      event_type: 'post',
      home_room_id: 'room-target',
      visibility_scope: 'public',
      author_account_id: 'acct',
      author_device_id: 'dev',
      author_device_key_id: 'key',
      device_seq: 1,
      capability_cid: capabilityCid,
      policy_epoch_claim: 0,
      revocation_epoch_claim: 0,
      client_nonce: new Uint8Array([1, 2, 3]),
      priority: 2,
      body_block_cid: bodyBlockCid,
    });
    const recordCid = await cidFor('record', body);
    const result = await repackHeldObjects(
      readerOf({ cid: recordCid, held: { kind: 'record', bytes: body } }),
      [recordCid],
      1_000_000,
    );
    const read = await readPack(result.pack as Uint8Array);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const entry = read.pack.entries.find((e) => e.cid === recordCid);
    expect(entry).toBeDefined();
    // The room round-trips (the receiver decodes room_id_hash → roomHash 'room-target', not '').
    expect(new TextDecoder().decode(entry?.room_id_hash)).toBe('room-target');
    // The body's dep CIDs are present so a missing prerequisite quarantines on the receiver.
    expect(entry?.deps).toContain(capabilityCid);
    expect(entry?.deps).toContain(bodyBlockCid);
  });
});
