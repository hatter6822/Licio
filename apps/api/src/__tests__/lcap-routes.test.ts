// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.4 (first slice) — the §29 LCAP content-read endpoints.  Serves held,
// content-addressed objects by CID with the §22.1.1 read status mapping
// (200 held / 404 not-held / 400 malformed CID), and verifies the mount through
// the full app (global security/CSRF middleware lets GETs through).

import { cidFor } from '@licio/lcap';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createLcapRoutes } from '../lcap/routes.js';
import { LcapIngestServer } from '../lcap/server-ingest.js';
import { setLcapIngestServer } from '../lcap/service.js';

const enc = new TextEncoder();

let server: LcapIngestServer;
let recordBody: Uint8Array;
let recordCid: string;
let absentCid: string;

beforeAll(async () => {
  server = new LcapIngestServer('net');
  recordBody = enc.encode('hello-record');
  recordCid = await cidFor('record', recordBody);
  await server.putObject(recordCid, 'record', recordBody);
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
    const res = await createLcapRoutes(server).request(`/records/${recordCid}`, {
      headers: { Range: 'bytes=100-200' },
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

describe('mounted at /api/lcap/v2 (GET passes the global CSRF + security middleware)', () => {
  it('serves a held record through the full app', async () => {
    const mounted = new LcapIngestServer('net');
    const body = enc.encode('mounted-record');
    const cid = await cidFor('record', body);
    await mounted.putObject(cid, 'record', body);
    setLcapIngestServer(mounted);

    const app = createApp();
    const res = await app.request(`/api/lcap/v2/records/${cid}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
    // The global security headers still apply to the binary read.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
