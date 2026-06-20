// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §29 LCAP HTTP API (WS-R.12.4).  Two surfaces so far:
//
//   - content READS (GET by CID): serve held, content-addressed objects so a peer
//     that learns a `want` (from an ingestion response) can fetch the missing
//     object.  Reads are GETs, so the global CSRF middleware passes them through.
//   - pack IMPORT (POST /packs): the §29 bundle-import path.  A `.licio-bundle` is
//     read under the WS-R.4.2 caps; every CID-verified frame is durably stored (so
//     the READ routes can serve its proofs/blocks), its identity frames (certs/
//     capabilities/revocations) are registered, and its contribution records are
//     committed through the same validate()→graph-guard→commit pipeline.
//     Ingestion is device-certificate-authenticated CONTENT (the records carry
//     their own COSE proofs), so the endpoint is CSRF-exempt (registered in the
//     CSRF middleware, like the public takedowns intake) and bounded by a global
//     fixed-window rate limit + the §27 caps + the graph guard.
//
// §22.1.1 status mapping: reads → 200 held / 404 not-held / 400 malformed CID;
// pack import → 200 processed (per-object outcomes inside) / 413 oversized /
// 422 malformed / 429 rate-limited (+Retry-After, from the limiter).  Content is
// self-authenticating, so serving or accepting it implies no transport trust.

import {
  type DetachedProofV2,
  decodeAndRouteRecord,
  decodeProof,
  type ObjectStatusV2,
  parseCid,
  readPack,
} from '@licio/lcap';
import { Hono } from 'hono';
import { rateLimit } from '../lib/rate-limit.js';
import type { CommitRecordInput, LcapIngestServer } from './server-ingest.js';
import { getLcapIngestServer } from './service.js';

type ContentKind = 'record' | 'proof' | 'block';

const CONTENT_TYPE: Record<ContentKind, string> = {
  record: 'application/cbor',
  proof: 'application/cbor',
  block: 'application/octet-stream',
};

// A pack frame's content-addressed kind (the §16.11 `cid_kind` + the store key).
const FRAME_CID_KIND = {
  record_body: 'record',
  proof: 'proof',
  block: 'block',
  chunk: 'chunk',
} as const satisfies Record<string, ObjectStatusV2['cid_kind']>;

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function serveObject(server: LcapIngestServer, kind: ContentKind, cid: string): Response {
  // A malformed CID is a non-retriable 400 (§22.1.1) — fail before any lookup.
  try {
    parseCid(cid);
  } catch {
    return json(400, { error: 'bad_cid' });
  }
  const obj = server.getObject(cid);
  if (!obj || obj.kind !== kind) {
    return json(404, { error: 'not_found' });
  }
  // A fresh copy so the response body never aliases the in-memory store buffer.
  return new Response(new Uint8Array(obj.bytes), {
    status: 200,
    headers: { 'content-type': CONTENT_TYPE[kind] },
  });
}

// §22.1.1: oversized inputs are 413; any other read failure is a non-retriable 422.
function packErrorStatus(status: string): 413 | 422 {
  return status.startsWith('oversized') || status === 'too_many_entries' ? 413 : 422;
}

/**
 * Import a `.licio-bundle`: read it under the WS-R.4.2 caps, DURABLY STORE every
 * CID-verified frame (so its records/proofs/blocks become fetchable via the GET
 * routes), register its identity frames, then commit its contributions through the
 * server's validate→guard→commit pipeline.  Returns one §16.11 status per object
 * (non-contributions `stored_unverified`/`rejected_bad_cid` here; contributions
 * from the commit) + the de-duplicated wants.
 */
async function ingestPack(server: LcapIngestServer, body: Uint8Array): Promise<Response> {
  const read = await readPack(body);
  if (!read.ok) {
    return json(packErrorStatus(read.status), { error: read.status });
  }
  const { frames } = read.pack;

  // Group detached proofs by the record_cid they attest (for the contribution commit).
  const proofsByRecord = new Map<string, DetachedProofV2[]>();
  for (const frame of frames.values()) {
    if (frame.frameKind !== 'proof') continue;
    try {
      const proof = decodeProof(frame.payload);
      const list = proofsByRecord.get(proof.record_cid) ?? [];
      list.push(proof);
      proofsByRecord.set(proof.record_cid, list);
    } catch {
      // a malformed proof frame is ignored; the record it would attest will quarantine
    }
  }

  // Store every frame (CID re-verified by putObject) + register identity frames;
  // collect contributions for the ordered batch commit.  Non-contribution objects
  // get their §16.11 status here; contributions get theirs from commitBatch.
  const statuses: ObjectStatusV2[] = [];
  const contributions: CommitRecordInput[] = [];
  for (const [cid, frame] of frames) {
    const cidKind = FRAME_CID_KIND[frame.frameKind];
    const stored = await server.putObject(cid, cidKind, frame.payload);
    if (!stored) {
      statuses.push({ cid, cid_kind: cidKind, status: 'rejected_bad_cid' });
      continue;
    }
    if (frame.frameKind !== 'record_body') {
      statuses.push({ cid, cid_kind: cidKind, status: 'stored_unverified' });
      continue;
    }
    let record: ReturnType<typeof decodeAndRouteRecord>;
    try {
      record = decodeAndRouteRecord(frame.payload);
    } catch {
      statuses.push({ cid, cid_kind: 'record', status: 'rejected_bad_schema' });
      continue;
    }
    const proofs = proofsByRecord.get(cid) ?? [];
    const authorityProof = proofs[0];
    switch (record.kind) {
      case 'device_certificate':
        if (authorityProof) {
          await server.registerCertificate({
            certificate: record,
            body: frame.payload,
            proof: authorityProof,
          });
        }
        statuses.push({ cid, cid_kind: 'record', status: 'stored_unverified' });
        break;
      case 'room_capability':
        if (authorityProof) {
          await server.registerCapability({
            capability: record,
            body: frame.payload,
            proof: authorityProof,
          });
        }
        statuses.push({ cid, cid_kind: 'record', status: 'stored_unverified' });
        break;
      case 'revocation':
        server.registerRevocation(record);
        statuses.push({ cid, cid_kind: 'record', status: 'stored_unverified' });
        break;
      case 'contribution_event':
        contributions.push({
          recordCid: cid,
          roomId: record.home_room_id,
          authorDeviceKeyId: record.author_device_key_id,
          deviceSeq: record.device_seq,
          body: frame.payload,
          proofs,
        });
        break; // commitBatch reports the contribution's status
      default:
        statuses.push({ cid, cid_kind: 'record', status: 'stored_unverified' });
        break;
    }
  }

  const result = await server.commitBatch(contributions);
  return json(200, { statuses: [...statuses, ...result.statuses], wants: result.wants });
}

/** The §29 LCAP routes.  Mounted at `/api/lcap/v2` (see `app.ts`). */
export function createLcapRoutes(server: LcapIngestServer = getLcapIngestServer()): Hono {
  const app = new Hono();
  app.get('/records/:cid', (c) => serveObject(server, 'record', c.req.param('cid')));
  app.get('/proofs/:cid', (c) => serveObject(server, 'proof', c.req.param('cid')));
  app.get('/blocks/:cid', (c) => serveObject(server, 'block', c.req.param('cid')));
  app.post('/packs', rateLimit({ limit: 60, windowMs: 60_000 }), async (c) =>
    ingestPack(server, new Uint8Array(await c.req.arrayBuffer())),
  );
  return app;
}
