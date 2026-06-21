// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.4 content-push repacking (`repackHeldObjects`): build a pack of HELD
// objects for a peer's explicit wants, with lane/priority re-derived from content,
// the privacy label upgraded for non-public records, budget-bounded truncation, and
// held-only / decodable-only selection.  Verified by reading the assembled pack back.

import { cidFor, detachedProofV2Schema, encodeWithSchema, readPack } from '@licio/lcap';
import { beforeAll, describe, expect, it } from 'vitest';
import { repackHeldObjects } from '../lcap/repack.js';
import { LcapIngestServer } from '../lcap/server-ingest.js';
import { buildLcapFixtures, type LcapFixtures, NET } from './lcap-fixtures.js';

const enc = new TextEncoder();

let fx: LcapFixtures;
let proofBytes: Uint8Array;
let proofCid: string;
let blockBytes: Uint8Array;
let blockCid: string;

/** A server holding the fixture record (an in-room contribution), its proof, and a block. */
async function heldServer(): Promise<LcapIngestServer> {
  const srv = new LcapIngestServer(NET);
  await srv.putObject(fx.recordCid, 'record', fx.body);
  await srv.putObject(proofCid, 'proof', proofBytes);
  await srv.putObject(blockCid, 'block', blockBytes);
  return srv;
}

beforeAll(async () => {
  fx = await buildLcapFixtures();
  proofBytes = encodeWithSchema(detachedProofV2Schema, fx.proof);
  proofCid = await cidFor('proof', proofBytes);
  blockBytes = enc.encode('a-held-block-payload');
  blockCid = await cidFor('block', blockBytes);
});

describe('repackHeldObjects (§16.7 hints; content-derived lane/priority)', () => {
  it('packs the held wants and reads back exactly those CIDs', async () => {
    const srv = await heldServer();
    const result = await repackHeldObjects(srv, [fx.recordCid, proofCid, blockCid], 1_000_000);
    expect(result.truncated).toBe(false);
    expect([...result.served].sort()).toEqual([fx.recordCid, proofCid, blockCid].sort());

    const read = await readPack(result.pack as Uint8Array);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect([...read.pack.frames.keys()].sort()).toEqual([fx.recordCid, proofCid, blockCid].sort());
    // Every repacked frame is CID-verified by the reader.
    for (const frame of read.pack.frames.values()) expect(frame.cidVerified).toBe(true);
  });

  it("upgrades the pack privacy label to 'contains_in_room_metadata' for an in-room record", async () => {
    const srv = await heldServer();
    const result = await repackHeldObjects(srv, [fx.recordCid], 1_000_000);
    const read = await readPack(result.pack as Uint8Array);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The fixture contribution is visibility_scope 'in_room'.
    expect(read.pack.header.privacy_label).toBe('contains_in_room_metadata');
  });

  it('skips wants the server does not hold (no pack when none held)', async () => {
    const srv = await heldServer();
    const absent = await cidFor('record', enc.encode('never-stored'));
    const result = await repackHeldObjects(srv, [absent], 1_000_000);
    expect(result.pack).toBeUndefined();
    expect(result.served).toEqual([]);
  });

  it('skips a held object whose bytes do not decode (a non-record stored as a record)', async () => {
    const srv = new LcapIngestServer(NET);
    const junk = enc.encode('not-a-valid-record-cbor');
    const junkCid = await cidFor('record', junk);
    await srv.putObject(junkCid, 'record', junk);
    const result = await repackHeldObjects(srv, [junkCid], 1_000_000);
    expect(result.pack).toBeUndefined();
    expect(result.served).toEqual([]);
  });

  it('respects the byte budget even for the first held object (no first-object bypass)', async () => {
    const srv = await heldServer();
    // A 1-byte budget is below even the first object.  The first want must NOT be served
    // in excess of the advertised budget: nothing is served and the exchange is marked
    // partial (the peer fetches it via the resumable GET range routes).
    const tiny = await repackHeldObjects(srv, [fx.recordCid, proofCid, blockCid], 1);
    expect(tiny.served).toEqual([]);
    expect(tiny.truncated).toBe(true);
    expect(tiny.pack).toBeUndefined();

    // A budget that fits exactly the first object (its payload + the 256B frame overhead)
    // serves one object and truncates the remainder.
    const oneFit = await repackHeldObjects(
      srv,
      [fx.recordCid, proofCid, blockCid],
      fx.body.length + 256,
    );
    expect(oneFit.served).toEqual([fx.recordCid]);
    expect(oneFit.truncated).toBe(true);
  });
});
