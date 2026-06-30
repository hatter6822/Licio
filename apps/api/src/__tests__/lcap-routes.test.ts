// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.4 (first slice) — the §29 LCAP content-read endpoints.  Serves held,
// content-addressed objects by CID with the §22.1.1 read status mapping
// (200 held / 404 not-held / 400 malformed CID), and verifies the mount through
// the full app (global security/CSRF middleware lets GETs through).

import { cidFor, encodeContributionEvent } from '@licio/lcap';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createLcapRoutes } from '../lcap/routes.js';
import { LcapIngestServer } from '../lcap/server-ingest.js';
import { setLcapIngestServer } from '../lcap/service.js';
import { buildLcapFixtures, type LcapFixtures } from './lcap-fixtures.js';

const enc = new TextEncoder();

let fx: LcapFixtures;
let server: LcapIngestServer;
// The PUBLIC record served by the §29 GET routes (PUB-API-CORE-1: a real, decodable PUBLIC record —
// dummy bytes are undecodable and correctly withheld by the public-serve gate).
let recordBody: Uint8Array;
let recordCid: string;
let absentCid: string;
// A PUBLIC-servable block (referenced by the public record) + a withheld in_room record/block.
let publicBlockCid: string;
let inRoomBlockCid: string;

beforeAll(async () => {
  fx = await buildLcapFixtures();
  server = new LcapIngestServer('net');
  recordBody = fx.publicBody;
  recordCid = fx.publicRecordCid;
  await server.putObject(recordCid, 'record', recordBody);

  // A block public-servable iff its owner is (1) ACCEPTED (PUB-API-BLOCK-OWNER-1), (2) PUBLIC, and
  // (3) NAMES the block in its SIGNED body (PUB-API-BLOCK-OWNER-2 — not just the unauthenticated
  // pack-table edge).  Build a PUBLIC contribution whose `body_block_cid` IS the block, accept it.
  const publicBlockBytes = enc.encode('public-media-block');
  publicBlockCid = await cidFor('block', publicBlockBytes);
  const ownerBody = encodeContributionEvent({
    ...fx.publicContribution,
    body_block_cid: publicBlockCid,
    device_seq: 5,
    client_nonce: new Uint8Array([2, 2, 2, 2]),
  });
  const ownerCid = await cidFor('record', ownerBody);
  await server.putObject(ownerCid, 'record', ownerBody);
  await server.putObject(publicBlockCid, 'block', publicBlockBytes);
  await server.indexRecordEdge(ownerCid, publicBlockCid, 'block');
  await server.appendAcceptance('room', ownerCid);

  // The in_room record + a block referenced ONLY by it → withheld over the public surface.
  await server.putObject(fx.recordCid, 'record', fx.body);
  const inRoomBlockBytes = enc.encode('in-room-media-block');
  inRoomBlockCid = await cidFor('block', inRoomBlockBytes);
  await server.putObject(inRoomBlockCid, 'block', inRoomBlockBytes);
  await server.indexRecordEdge(fx.recordCid, inRoomBlockCid, 'block');

  absentCid = await cidFor('record', enc.encode('never-stored'));
});

describe('createLcapRoutes — §29 content reads', () => {
  it('serves a held record by CID as 200 application/cbor with the exact bytes', async () => {
    const res = await createLcapRoutes(server).request(`/records/${recordCid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/cbor');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(recordBody);
  });

  it('returns 404 for a well-formed CID the server does not hold', async () => {
    const res = await createLcapRoutes(server).request(`/records/${absentCid}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed CID (non-retriable, §22.1.1)', async () => {
    const res = await createLcapRoutes(server).request('/records/not-a-cid');
    expect(res.status).toBe(400);
  });

  it('returns 404 when the held object is of a different kind than the path', async () => {
    // The record CID is stored as a record; the /proofs path must not serve it.
    const res = await createLcapRoutes(server).request(`/proofs/${recordCid}`);
    expect(res.status).toBe(404);
  });
});

describe('createLcapRoutes — §29 resumable range reads (RFC 7233)', () => {
  it('advertises Accept-Ranges on a full 200 read', async () => {
    const res = await createLcapRoutes(server).request(`/records/${recordCid}`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('serves a satisfiable byte range as 206 with Content-Range and the slice', async () => {
    const res = await createLcapRoutes(server).request(`/records/${recordCid}`, {
      headers: { Range: 'bytes=0-4' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-4/${recordBody.length}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(recordBody.slice(0, 5));
  });

  it('serves an open-ended suffix range to the end of the object', async () => {
    const res = await createLcapRoutes(server).request(`/records/${recordCid}`, {
      headers: { Range: 'bytes=6-' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes 6-${recordBody.length - 1}/${recordBody.length}`,
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(recordBody.slice(6));
  });

  it('returns 416 with Content-Range for a range beyond the object size', async () => {
    const beyond = recordBody.length + 10;
    const res = await createLcapRoutes(server).request(`/records/${recordCid}`, {
      headers: { Range: `bytes=${beyond}-${beyond + 100}` },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${recordBody.length}`);
  });

  it('ignores an unparseable Range header and serves the full 200', async () => {
    const res = await createLcapRoutes(server).request(`/records/${recordCid}`, {
      headers: { Range: 'rows=1-2' },
    });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(recordBody);
  });
});

describe('createLcapRoutes — §29 public-serve confidentiality gate (PUB-API-CORE-1)', () => {
  it('serves a block referenced by a PUBLIC record', async () => {
    const res = await createLcapRoutes(server).request(`/blocks/${publicBlockCid}`);
    expect(res.status).toBe(200);
  });

  it('NEVER serves a block named ONLY in an accepted public owner’s pack-table deps, not its SIGNED body (PUB-API-BLOCK-OWNER-2)', async () => {
    // The exploit: an attacker uploads a VALID public contribution that names a known PRIVATE block
    // CID ONLY in its pack-table `deps` (which `ingestPackFrames` indexes as a record→block edge),
    // NOT in the signed body.  Even with the owner accepted + public, that UNAUTHENTICATED table edge
    // must NOT authorize serving — only the author's SIGNED body attests ownership.
    const fresh = new LcapIngestServer('net');
    const ownerBody = encodeContributionEvent({
      ...fx.publicContribution, // a plain public post — its signed body references NO block
      device_seq: 9,
      client_nonce: new Uint8Array([3, 3, 3, 3]),
    });
    const ownerCid = await cidFor('record', ownerBody);
    await fresh.putObject(ownerCid, 'record', ownerBody);
    const blk = enc.encode('attacker-targeted-private-block');
    const blkCid = await cidFor('block', blk);
    await fresh.putObject(blkCid, 'block', blk);
    await fresh.indexRecordEdge(ownerCid, blkCid, 'block'); // ONLY a pack-table edge, not a body ref
    await fresh.appendAcceptance('room', ownerCid); // accepted + public — but the edge is forged
    expect(await createLcapRoutes(fresh).request(`/blocks/${blkCid}`)).toMatchObject({
      status: 404,
    });
  });

  it('serves a SIGNED-body block only once its owner is ACCEPTED (PUB-API-BLOCK-OWNER-1)', async () => {
    // The owner genuinely names the block in its SIGNED body, but is invalid/rejected (never
    // committed) — `ingestPackFrames` records the edge BEFORE commit, so acceptance is the gate.
    const fresh = new LcapIngestServer('net');
    const blk = enc.encode('owned-but-unaccepted-block');
    const blkCid = await cidFor('block', blk);
    const ownerBody = encodeContributionEvent({
      ...fx.publicContribution,
      body_block_cid: blkCid,
      device_seq: 11,
      client_nonce: new Uint8Array([4, 4, 4, 4]),
    });
    const ownerCid = await cidFor('record', ownerBody);
    await fresh.putObject(ownerCid, 'record', ownerBody);
    await fresh.putObject(blkCid, 'block', blk);
    await fresh.indexRecordEdge(ownerCid, blkCid, 'block');
    // NOT accepted ⇒ withheld.
    expect(await createLcapRoutes(fresh).request(`/blocks/${blkCid}`)).toMatchObject({
      status: 404,
    });
    // Accepted ⇒ the SAME signed-body block becomes servable.
    await fresh.appendAcceptance('room', ownerCid);
    expect(await createLcapRoutes(fresh).request(`/blocks/${blkCid}`)).toMatchObject({
      status: 200,
    });
  });

  it('NEVER serves a non-public (in_room) record by CID — returns 404, not the plaintext', async () => {
    const res = await createLcapRoutes(server).request(`/records/${fx.recordCid}`);
    expect(res.status).toBe(404); // 404 (not 403) ⇒ no existence oracle for in_room content
  });

  it('NEVER serves an in_room record’s media block by CID (the highest-value exfil target)', async () => {
    const res = await createLcapRoutes(server).request(`/blocks/${inRoomBlockCid}`);
    expect(res.status).toBe(404);
  });

  it('NEVER serves a chunk over the public surface (not in the public closure)', async () => {
    const chunkBytes = enc.encode('media-chunk-bytes');
    const chunkCid = await cidFor('chunk', chunkBytes);
    await server.putObject(chunkCid, 'chunk', chunkBytes);
    const res = await createLcapRoutes(server).request(`/chunks/${chunkCid}`);
    expect(res.status).toBe(404);
  });
});

describe('mounted at /api/lcap/v2 (GET passes the global CSRF + security middleware)', () => {
  it('serves a held PUBLIC record through the full app', async () => {
    const mounted = new LcapIngestServer('net');
    await mounted.putObject(fx.publicRecordCid, 'record', fx.publicBody);
    setLcapIngestServer(mounted);

    const app = createApp();
    const res = await app.request(`/api/lcap/v2/records/${fx.publicRecordCid}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fx.publicBody);
    // The global security headers still apply to the binary read.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
