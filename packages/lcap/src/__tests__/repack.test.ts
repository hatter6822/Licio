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
});
