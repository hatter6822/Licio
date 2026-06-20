// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §29 LCAP HTTP API — content-read endpoints (WS-R.12.4, first slice).  These
// serve held, content-addressed objects by CID so a peer that learns a `want`
// (from an ingestion response) can fetch the missing object.  Reads are GETs, so
// the global CSRF middleware passes them through; the security-header, CORS, and
// logger middleware apply as to every route (mounted in `app.ts`).
//
// §22.1.1 status mapping for reads: a malformed CID is a non-retriable `400`; an
// object the server does not hold is `404`; a held object of the requested kind is
// `200` with its raw bytes.  Content is self-authenticating (the bytes hash to the
// CID), so no transport trust is implied by serving them.  The ingestion/exchange/
// pulse/pack endpoints + their full status matrix are the next WS-R.12.4 slices.

import { parseCid } from '@licio/lcap';
import { Hono } from 'hono';
import type { LcapIngestServer } from './server-ingest.js';
import { getLcapIngestServer } from './service.js';

type ContentKind = 'record' | 'proof' | 'block';

const CONTENT_TYPE: Record<ContentKind, string> = {
  record: 'application/cbor',
  proof: 'application/cbor',
  block: 'application/octet-stream',
};

function jsonError(status: 400 | 404, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function serveObject(server: LcapIngestServer, kind: ContentKind, cid: string): Response {
  // A malformed CID is a non-retriable 400 (§22.1.1) — fail before any lookup.
  try {
    parseCid(cid);
  } catch {
    return jsonError(400, 'bad_cid');
  }
  const obj = server.getObject(cid);
  if (!obj || obj.kind !== kind) {
    return jsonError(404, 'not_found');
  }
  // A fresh copy so the response body never aliases the in-memory store buffer.
  return new Response(new Uint8Array(obj.bytes), {
    status: 200,
    headers: { 'content-type': CONTENT_TYPE[kind] },
  });
}

/** The §29 content-read routes (GET by CID).  Mounted at `/api/lcap/v2`. */
export function createLcapRoutes(server: LcapIngestServer = getLcapIngestServer()): Hono {
  const app = new Hono();
  app.get('/records/:cid', (c) => serveObject(server, 'record', c.req.param('cid')));
  app.get('/proofs/:cid', (c) => serveObject(server, 'proof', c.req.param('cid')));
  app.get('/blocks/:cid', (c) => serveObject(server, 'block', c.req.param('cid')));
  return app;
}
