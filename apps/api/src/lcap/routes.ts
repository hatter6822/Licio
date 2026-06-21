// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §29 LCAP HTTP API (WS-R.12.4).  Four surfaces:
//
//   - content READS (GET by CID): serve held, content-addressed objects so a peer
//     that learns a `want` (from an ingestion response) can fetch the missing
//     object.  Reads are GETs, so the global CSRF middleware passes them through.
//   - pack IMPORT (POST /packs, §29.3): the bundle-import path.  A `.licio-bundle`
//     is read under the WS-R.4.2 caps; every CID-verified frame is durably stored
//     (so the READ routes can serve its proofs/blocks), its identity frames (certs/
//     capabilities/revocations) are registered, and its contribution records are
//     committed through the same validate()→graph-guard→commit pipeline.
//   - pulse (POST /pulse, §29.1): the tiny C0 frontier exchange — validate the
//     client pulse fail-closed, return the server's frontiers (per-room checkpoint
//     sizes + the global revocation epoch).
//   - exchange (POST /exchange, §29.2): the main bidirectional path — ingest an
//     optional push pack through the SHARED WS-R.4.2 validator, then return the
//     server's frontiers + the `wanted_from_client` the frontier diff derives.
//
// All four are device-certificate-authenticated CONTENT (records carry their own
// COSE proofs; validate() is the real authentication) and a native sync client
// holds NO session cookie, so the POST surfaces are CSRF-exempt (registered in the
// CSRF middleware, like the public takedowns intake) and bounded by per-endpoint
// rate limits + the §27 caps + the §27.2 graph guard.
//
// §22.1.1 request-level status mapping: reads → 200 held / 404 not-held / 400
// malformed CID; pack import / pulse / exchange → 200 processed (per-object
// outcomes inside) / 413 oversized / 400 undecodable / 422 schema-invalid / 429
// rate-limited (+Retry-After, from the limiter).  Content is self-authenticating,
// so serving or accepting it implies no transport trust.

import {
  applyPulse,
  buildExchangeResponse,
  type DetachedProofV2,
  decode,
  decodeAndRouteRecord,
  decodeProof,
  encodeWithSchema,
  exchangeRequestV2Schema,
  exchangeResponseV2Schema,
  ldcToPlain,
  type ObjectStatusV2,
  parseCid,
  pulseResponseV2Schema,
  readPack,
  type SyncPulseV2,
  syncPulseV2Schema,
  type WantRequestV2,
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

/** Parse a single RFC 7233 `bytes=` range against `size`; `null` ⇒ serve full. */
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // unparseable / multi-range → ignore, serve the full 200
  const startStr = match[1] ?? '';
  const endStr = match[2] ?? '';
  if (startStr === '' && endStr === '') return null;
  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range `bytes=-N`: the last N bytes.
    const n = Number(endStr);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
  }
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

async function serveObject(
  server: LcapIngestServer,
  kind: ContentKind,
  cid: string,
  rangeHeader?: string,
): Promise<Response> {
  // A malformed CID is a non-retriable 400 (§22.1.1) — fail before any lookup.
  try {
    parseCid(cid);
  } catch {
    return json(400, { error: 'bad_cid' });
  }
  const obj = await server.getObject(cid);
  if (!obj || obj.kind !== kind) {
    return json(404, { error: 'not_found' });
  }
  const bytes = obj.bytes;
  const headers: Record<string, string> = {
    'content-type': CONTENT_TYPE[kind],
    'accept-ranges': 'bytes',
  };

  // Resumable fetch (§29 `…/range`): a satisfiable range → 206; otherwise 416.
  if (rangeHeader !== undefined && rangeHeader !== '') {
    const range = parseRange(rangeHeader, bytes.length);
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${bytes.length}` },
      });
    }
    if (range) {
      // `.slice` copies, so the body never aliases the in-memory store buffer.
      return new Response(bytes.slice(range.start, range.end + 1), {
        status: 206,
        headers: {
          ...headers,
          'content-range': `bytes ${range.start}-${range.end}/${bytes.length}`,
        },
      });
    }
  }
  // A fresh copy so the response body never aliases the in-memory store buffer.
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

// §22.1.1: oversized inputs are 413; any other read failure is a non-retriable 422.
function packErrorStatus(status: string): 413 | 422 {
  return status.startsWith('oversized') || status === 'too_many_entries' ? 413 : 422;
}

/** A successful pack ingestion: the per-object §16.11 statuses + de-duplicated wants. */
interface PackIngestOutcome {
  readonly statuses: ObjectStatusV2[];
  readonly wants: readonly WantRequestV2[];
}

/** The shared WS-R.4.2 validator outcome — a read failure (with its HTTP status) or the result. */
type PackIngestResult =
  | { readonly ok: false; readonly httpStatus: 413 | 422; readonly error: string }
  | ({ readonly ok: true } & PackIngestOutcome);

/**
 * The shared pack-ingestion core used by BOTH `/packs` and the exchange `push_pack`
 * (the card's "bundle import shares the WS-R.4.2 validator"): read the pack under the
 * §27 caps, DURABLY STORE every CID-verified frame (so its records/proofs/blocks
 * become fetchable via the GET routes), register its identity frames, then commit its
 * contributions through the server's validate→guard→commit pipeline.  Returns one
 * §16.11 status per object (non-contributions `stored_unverified`/`already_have`/
 * `rejected_bad_cid` here; contributions from the commit) + the de-duplicated wants.
 */
async function ingestPackFrames(
  server: LcapIngestServer,
  body: Uint8Array,
): Promise<PackIngestResult> {
  const read = await readPack(body);
  if (!read.ok) {
    return { ok: false, httpStatus: packErrorStatus(read.status), error: read.status };
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
    const had = await server.hasObject(cid);
    const stored = await server.putObject(cid, cidKind, frame.payload);
    if (!stored) {
      statuses.push({ cid, cid_kind: cidKind, status: 'rejected_bad_cid' });
      continue;
    }
    // An object we already held is `already_have`; a fresh one is `stored_unverified`.
    const storedStatus: ObjectStatusV2['status'] = had ? 'already_have' : 'stored_unverified';
    if (frame.frameKind !== 'record_body') {
      statuses.push({ cid, cid_kind: cidKind, status: storedStatus });
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
        statuses.push({ cid, cid_kind: 'record', status: storedStatus });
        break;
      case 'room_capability':
        if (authorityProof) {
          await server.registerCapability({
            capability: record,
            body: frame.payload,
            proof: authorityProof,
          });
        }
        statuses.push({ cid, cid_kind: 'record', status: storedStatus });
        break;
      case 'revocation':
        server.registerRevocation(record);
        statuses.push({ cid, cid_kind: 'record', status: storedStatus });
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
        statuses.push({ cid, cid_kind: 'record', status: storedStatus });
        break;
    }
  }

  const result = await server.commitBatch(contributions);
  return { ok: true, statuses: [...statuses, ...result.statuses], wants: result.wants };
}

/** §29.3 `POST /packs`: ingest a pack and report the per-object outcomes inline. */
async function ingestPack(server: LcapIngestServer, body: Uint8Array): Promise<Response> {
  const result = await ingestPackFrames(server, body);
  if (!result.ok) {
    return json(result.httpStatus, { error: result.error });
  }
  return json(200, { statuses: result.statuses, wants: result.wants });
}

// A pulse is a tiny frontier message; anything larger is over the request budget.
const MAX_PULSE_REQUEST_BYTES = 256 * 1024;

/**
 * §29.1 `POST /pulse`: validate the client's pulse fail-closed, then return the
 * server's pulse (frontiers) as a `PulseResponseV2`.  §22.1.1 mapping: oversized
 * body → 413; an undecodable body → 400 (malformed framing); a decodable body that
 * fails the pulse schema → 422 (a semantic violation); processed → 200.  The client
 * runs the local frontier diff (`applyPulse`) against the returned frontiers to
 * learn what it is behind on, then fetches via the GET content routes.
 */
async function handlePulse(server: LcapIngestServer, body: Uint8Array): Promise<Response> {
  if (body.length > MAX_PULSE_REQUEST_BYTES) {
    return json(413, { error: 'oversized_request' });
  }
  let decoded: unknown;
  try {
    decoded = ldcToPlain(decode(body));
  } catch {
    return json(400, { error: 'undecodable' });
  }
  // Fail closed: a malformed client pulse is rejected before we do any work.
  if (!syncPulseV2Schema.safeParse(decoded).success) {
    return json(422, { error: 'invalid_pulse' });
  }
  const response = await server.pulseResponse();
  return new Response(encodeWithSchema(pulseResponseV2Schema, response), {
    status: 200,
    headers: { 'content-type': 'application/cbor' },
  });
}

// An exchange MAY carry a push pack, so it is bounded by the larger §16.5 request budget.
const MAX_EXCHANGE_REQUEST_BYTES = 1024 * 1024;

/** The bounded set of CIDs a client pulse references (for a synchronous `have` lookup). */
function pulseReferencedCids(pulse: SyncPulseV2): string[] {
  const cids: string[] = [];
  for (const f of pulse.checkpoint_frontier) {
    if (f.latest_checkpoint_cid !== undefined) cids.push(f.latest_checkpoint_cid);
  }
  for (const f of pulse.revocation_frontier) {
    if (f.latest_revocation_checkpoint_cid !== undefined) {
      cids.push(f.latest_revocation_checkpoint_cid);
    }
  }
  for (const cid of pulse.critical_have ?? []) cids.push(cid);
  return cids;
}

/**
 * §29.2 `POST /exchange`: the main bidirectional sync path.  Ingest the (optional)
 * push pack through the SHARED WS-R.4.2 validator (idempotent by record_cid →
 * `accepted_push`), then return the server's pulse (frontiers) plus the
 * `wanted_from_client` the server's own frontier diff derives (what the server is
 * behind on, given the client's advertised frontier).  Content the client `want`s is
 * fetched via the GET routes; the optional server-push `response_pack` is the
 * WS-R.12.4 follow-up that needs import-captured object metadata.  §22.1.1: oversized
 * → 413; undecodable → 400; schema-invalid → 422; processed → 200 (per-object
 * outcomes — including `quarantined_*`/`rejected_*`/`conflict_*` — inside the body).
 */
async function handleExchange(server: LcapIngestServer, body: Uint8Array): Promise<Response> {
  if (body.length > MAX_EXCHANGE_REQUEST_BYTES) {
    return json(413, { error: 'oversized_request' });
  }
  let decoded: unknown;
  try {
    decoded = ldcToPlain(decode(body));
  } catch {
    return json(400, { error: 'undecodable' });
  }
  const parsed = exchangeRequestV2Schema.safeParse(decoded);
  if (!parsed.success) {
    return json(422, { error: 'invalid_exchange_request' });
  }
  const request = parsed.data;

  // 1) Ingest the optional push pack through the shared validator (idempotent).
  let acceptedPush: ObjectStatusV2[] | undefined;
  if (request.push_pack !== undefined) {
    const ingest = await ingestPackFrames(server, request.push_pack);
    if (!ingest.ok) {
      // A push pack that breaches the §27 caps fails the whole request (§22.1.1).
      return json(ingest.httpStatus, { error: ingest.error });
    }
    acceptedPush = ingest.statuses;
  }

  // 2) The server's frontier diff against the client's advertised frontier: what the
  // server is behind on (`wanted_from_client`).  `applyPulse` needs a synchronous
  // `have` predicate, so pre-fetch the bounded set of CIDs the client pulse references.
  const have = new Set<string>();
  for (const cid of pulseReferencedCids(request.pulse)) {
    if (await server.hasObject(cid)) have.add(cid);
  }
  const reaction = applyPulse({
    remote: request.pulse,
    localCheckpointFrontier: await server.checkpointFrontier(),
    localRevocationFrontier: server.revocationFrontier(),
    locallyHave: (cid) => have.has(cid),
  });
  const wantedFromClient: readonly WantRequestV2[] = reaction.wants;

  // 3) `ok`: the exchange itself completed; the client fetches any `want` via the GET
  // routes.  Per-object push outcomes (if any) carry their own §16.11 status.
  const response = buildExchangeResponse({
    pulse: await server.serverPulse(),
    status: 'ok',
    ...(acceptedPush !== undefined ? { acceptedPush } : {}),
    ...(wantedFromClient.length > 0 ? { wantedFromClient } : {}),
  });
  return new Response(encodeWithSchema(exchangeResponseV2Schema, response), {
    status: 200,
    headers: { 'content-type': 'application/cbor' },
  });
}

/**
 * The §29 LCAP routes.  Mounted at `/api/lcap/v2` (see `app.ts`).  The server is
 * resolved PER REQUEST (not at mount): the default singleton — which may bind a
 * Postgres client — is constructed only when a request actually arrives, so merely
 * building the app never opens a DB connection.  Tests pass an explicit override.
 */
export function createLcapRoutes(override?: LcapIngestServer): Hono {
  const server = (): LcapIngestServer => override ?? getLcapIngestServer();
  const app = new Hono();
  const read =
    (kind: ContentKind) =>
    (c: { req: { param: (k: string) => string; header: (k: string) => string | undefined } }) =>
      serveObject(server(), kind, c.req.param('cid'), c.req.header('range'));
  app.get('/records/:cid', read('record'));
  app.get('/proofs/:cid', read('proof'));
  app.get('/blocks/:cid', read('block'));
  app.post('/packs', rateLimit({ limit: 60, windowMs: 60_000 }), async (c) =>
    ingestPack(server(), new Uint8Array(await c.req.arrayBuffer())),
  );
  app.post('/pulse', rateLimit({ limit: 120, windowMs: 60_000 }), async (c) =>
    handlePulse(server(), new Uint8Array(await c.req.arrayBuffer())),
  );
  app.post('/exchange', rateLimit({ limit: 60, windowMs: 60_000 }), async (c) =>
    handleExchange(server(), new Uint8Array(await c.req.arrayBuffer())),
  );
  return app;
}
