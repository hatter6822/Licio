// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §29 LCAP HTTP API (WS-R.12.4) — the full surface:
//
//   - content READS (§29.4-6, GET by CID): serve held, content-addressed objects so
//     a peer that learns a `want` can fetch the missing object (RFC 7233 ranges).
//   - room reads (§29.7, GET /rooms/:id/{checkpoint,proofs/*}): the unsigned tree
//     head + RFC 9162 inclusion/consistency proofs over the §19.1 room log.
//   - bundle EXPORT (§29.8, POST /bundles/export): a room's content closure (records +
//     each record's proofs + referenced blocks) repacked from held bytes, GATED by a
//     device-signed `may_export_bundle` capability for the room (the export gate).
//   - pack IMPORT (§29.3, POST /packs): a `.licio-bundle` read under the WS-R.4.2
//     caps; every CID-verified frame durably stored, identity frames registered,
//     contributions committed through validate()→graph-guard→commit.
//   - bundle IMPORT (§29.8, POST /bundles/import): the web-UI alias of /packs.
//   - pulse (§29.1, POST /pulse) + exchange (§29.2, POST /exchange): the frontier
//     exchange + the main bidirectional path (push-pack ingest + frontiers +
//     `wanted_from_client` + a served content pack).
//
// Content is device-certificate-authenticated (records carry their own COSE proofs;
// validate() is the real authentication), so GETs + the native POSTs (/packs, /pulse,
// /exchange, and /bundles/export — gated by a device-signed export request) are
// CSRF-EXEMPT (a native sync client holds no session cookie) and bounded by per-endpoint
// rate limits + the §27 caps + the §27.2 graph guard.  The web-UI /bundles/import is NOT
// exempt — a session-bearing browser flow keeps the CSRF token.  §22.1.1 request-level status mapping: 200 processed (per-object
// outcomes inside) / 404 not-held / 400 malformed / 413 oversized / 422 schema-
// invalid / 429 rate-limited.  Serving/accepting content implies no transport trust.

import {
  applyPulse,
  BUNDLE_MIME,
  buildExchangeResponse,
  type DetachedProofV2,
  decode,
  decodeAndRouteRecord,
  decodeProof,
  decodeWithSchema,
  type ExportRequestEnvelopeV2,
  encodeWithSchema,
  exchangeRequestV2Schema,
  exchangeResponseV2Schema,
  exportRequestEnvelopeV2Schema,
  exportRequestV2Schema,
  type GraphGuardNode,
  genericBundleFilename,
  ldcToPlain,
  type ObjectStatusV2,
  parseCid,
  pulseResponseV2Schema,
  readPack,
  SERVER_CAPS,
  type SyncPulseV2,
  syncPulseV2Schema,
  type WantRequestV2,
} from '@licio/lcap';
import { Hono } from 'hono';
import { rateLimit } from '../lib/rate-limit.js';
import { repackHeldObjects } from './repack.js';
import type { CommitRecordInput, LcapIngestServer } from './server-ingest.js';
import { getLcapIngestServer } from './service.js';
import { frameBlobs, getSignalMailbox } from './signaling.js';

type ContentKind = 'record' | 'proof' | 'block' | 'chunk';

const CONTENT_TYPE: Record<ContentKind, string> = {
  record: 'application/cbor',
  proof: 'application/cbor',
  block: 'application/octet-stream',
  chunk: 'application/octet-stream',
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

/**
 * Reject an upload by its declared `Content-Length` BEFORE the body is buffered into
 * memory (the LCAP POST handlers call `arrayBuffer()`, which materializes the whole
 * request).  A present, oversized length is refused with 413 up front; an absent or
 * chunked length still falls back to the post-buffer §27.1 caps inside the handler.
 */
function declaredLengthExceeds(
  c: { req: { header: (k: string) => string | undefined } },
  max: number,
): boolean {
  const raw = c.req.header('content-length');
  if (raw === undefined) return false;
  const len = Number(raw);
  return Number.isFinite(len) && len > max;
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

  // §27.2 malicious-graph guard (WS-R.14.1b), over the pack table's DECLARED
  // dependency DAG, BEFORE any storage/expansion: a hostile graph (cycle / fan-out /
  // depth / duplicate deps) aborts the whole import — the graph is untrusted, so no
  // frame is stored.  Run under the server's §27.1 caps; each object gets the guard's
  // §16.11 rejection code (a 200 carrying per-object rejections, §22.1.1).
  const guardNodes: GraphGuardNode[] = read.pack.entries.map((entry) => ({
    cid: entry.cid,
    requires: entry.deps ?? [],
    ...(entry.flags?.private_metadata === true ? { hasPrivateMetadata: true } : {}),
  }));
  const guard = server.checkImportGraph(guardNodes);
  if (!guard.ok) {
    return {
      ok: true,
      statuses: read.pack.entries.map((entry) => ({
        cid: entry.cid,
        cid_kind: entry.cid_kind,
        status: guard.code,
      })),
      wants: [],
    };
  }

  // Group detached proofs by the record_cid they attest (for the contribution commit)
  // and index each record→proof edge for the §29.8 room-export closure.
  const proofsByRecord = new Map<string, DetachedProofV2[]>();
  for (const [cid, frame] of frames) {
    // Only a CID-VERIFIED proof frame may authorize a record/identity object: a frame
    // whose payload does not hash to its declared proof CID is `rejected_bad_cid` (not
    // stored/fetchable), so its signature must not be allowed to authorize anything here.
    if (frame.frameKind !== 'proof' || !frame.cidVerified) continue;
    try {
      const proof = decodeProof(frame.payload);
      const list = proofsByRecord.get(proof.record_cid) ?? [];
      list.push(proof);
      proofsByRecord.set(proof.record_cid, list);
      await server.indexRecordEdge(proof.record_cid, cid, 'proof');
    } catch {
      // a malformed proof frame is ignored; the record it would attest will quarantine
    }
  }

  // The pack table by CID — the declared deps drive the record→block export closure.
  const entryByCid = new Map(read.pack.entries.map((entry) => [entry.cid, entry] as const));

  // Store every frame (CID re-verified by putObject) + register identity frames;
  // collect contributions for the ordered batch commit.  Non-contribution objects
  // get their §16.11 status here; contributions get theirs from commitBatch.
  const statuses: ObjectStatusV2[] = [];
  const contributions: CommitRecordInput[] = [];
  // The §29.8 identity-closure edges to index AFTER the frame loop (so every cert frame in
  // this pack is registered before we resolve a contribution's signer-cert CID).
  const identityEdges: { recordCid: string; capabilityCid: string; deviceKeyId: string }[] = [];
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
    // Bound the per-record proof fan-in (§27.1): a pack cannot force thousands of key
    // lookups / signature checks for one record before it quarantines or rejects.
    const proofs = (proofsByRecord.get(cid) ?? []).slice(0, SERVER_CAPS.maxProofsPerRecord);
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
        // Index ONLY a revocation whose authority proof verifies for its scope; an
        // unsigned/wrong-authority revocation is stored (bytes fetchable) but never indexed.
        if (authorityProof) {
          await server.registerRevocation(record, frame.payload, authorityProof);
        }
        statuses.push({ cid, cid_kind: 'record', status: storedStatus });
        break;
      case 'contribution_event': {
        // Record prerequisites come from the SIGNED BODY (authoritative), not just the
        // attacker-controlled pack table: a malicious pack could omit table `deps` while
        // the body names a parent/previous/target/replaced record, letting a reply / edit
        // / moderation action append without the referenced record being accepted.  Union
        // the body-declared record CIDs with the table's record deps into `requires`; the
        // table's block deps still index the §29.8 export closure.
        const requires = new Set<string>();
        if (record.prev_device_record_cid) requires.add(record.prev_device_record_cid);
        if (record.replaces_record_cid) requires.add(record.replaces_record_cid);
        if (record.target_record_cid) requires.add(record.target_record_cid);
        if (record.thread_root_cid) requires.add(record.thread_root_cid);
        for (const parent of record.parent_record_cids ?? []) requires.add(parent);
        for (const dep of entryByCid.get(cid)?.deps ?? []) {
          let depKind: string;
          try {
            depKind = parseCid(dep).kind;
          } catch {
            continue; // a malformed dep CID is ignored (the record will quarantine anyway)
          }
          if (depKind === 'block') await server.indexRecordEdge(cid, dep, 'block');
          else if (depKind === 'record') requires.add(dep);
        }
        contributions.push({
          recordCid: cid,
          roomId: record.home_room_id,
          authorDeviceKeyId: record.author_device_key_id,
          deviceSeq: record.device_seq,
          capabilityCid: record.capability_cid,
          body: frame.payload,
          proofs,
          ...(requires.size > 0 ? { requires: [...requires] } : {}),
        });
        identityEdges.push({
          recordCid: cid,
          capabilityCid: record.capability_cid,
          deviceKeyId: record.author_device_key_id,
        });
        break; // commitBatch reports the contribution's status
      }
      default:
        statuses.push({ cid, cid_kind: 'record', status: storedStatus });
        break;
    }
  }

  // Index each contribution's IDENTITY closure (its cited capability + the signer's device
  // certificate) for the §29.8 export — done AFTER the full frame loop so every cert frame in
  // this pack has been registered and its CID is resolvable (pack frame order is not fixed).
  for (const edge of identityEdges) {
    await server.indexRecordEdge(edge.recordCid, edge.capabilityCid, 'identity');
    const certCid = server.deviceCertCid(edge.deviceKeyId);
    if (certCid !== undefined) await server.indexRecordEdge(edge.recordCid, certCid, 'identity');
  }

  const result = await server.commitBatch(contributions);
  return { ok: true, statuses: [...statuses, ...result.statuses], wants: result.wants };
}

/**
 * §29.3 `POST /packs` (+ the §29.8 `POST /bundles/import` web alias): ingest a pack
 * through the shared validator and report the per-object outcomes inline.  The two
 * routes differ only in CSRF posture — `/packs` is exempt (native sync clients hold
 * no session), `/bundles/import` is a session-bearing web flow that keeps the global
 * CSRF token — never in validation, which is identical (the card's requirement).
 */
async function ingestPack(server: LcapIngestServer, body: Uint8Array): Promise<Response> {
  const result = await ingestPackFrames(server, body);
  if (!result.ok) {
    return json(result.httpStatus, { error: result.error });
  }
  return json(200, { statuses: result.statuses, wants: result.wants });
}

// A pulse is a tiny frontier message; anything larger is over the request budget.
const MAX_PULSE_REQUEST_BYTES = 256 * 1024;
// The §29.1 C0 case is for severe bandwidth, so the inline critical pack stays tiny.
const MAX_CRITICAL_PACK_BYTES = 64 * 1024;

/**
 * §29.1 `POST /pulse`: validate the client's pulse fail-closed, then return the
 * server's pulse (frontiers) as a `PulseResponseV2` — plus, for the C0
 * one-round-trip case, an inline `critical_pack` of the client's `critical_want`
 * objects the server holds (capped tiny; the rest stays fetchable via the GET
 * routes).  §22.1.1 mapping: oversized body → 413; an undecodable body → 400
 * (malformed framing); a decodable body that fails the pulse schema → 422 (a
 * semantic violation); processed → 200.  The client runs the local frontier diff
 * (`applyPulse`) against the returned frontiers to learn what else it is behind on.
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
  const parsed = syncPulseV2Schema.safeParse(decoded);
  if (!parsed.success) {
    return json(422, { error: 'invalid_pulse' });
  }

  // The C0 fast path: bundle the client's critical_want objects we hold, tiny budget —
  // never larger than what the peer explicitly advertised (e.g. minimal mode's small
  // max_response_bytes), so the server cannot return a critical_pack over the receiver's
  // budget.
  let criticalPack: Uint8Array | undefined;
  const criticalWant = parsed.data.critical_want ?? [];
  if (criticalWant.length > 0) {
    const criticalBudget = Math.min(
      MAX_CRITICAL_PACK_BYTES,
      parsed.data.budgets.max_response_bytes,
    );
    const repacked = await repackHeldObjects(server, criticalWant, criticalBudget);
    if (repacked.pack !== undefined) criticalPack = repacked.pack;
  }

  const response = await server.pulseResponse(criticalPack);
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
 * `accepted_push`); return the server's pulse (frontiers), the `wanted_from_client`
 * the server's own frontier diff derives (what the server is behind on, given the
 * client's advertised frontier), AND a `response_pack` of the client's `want` CIDs
 * the server holds — repacked within the client's response budget (the rest stays
 * fetchable via the GET routes; truncation marks the exchange `partial`).  §22.1.1:
 * oversized → 413; undecodable → 400; schema-invalid → 422; processed → 200
 * (per-object outcomes — `quarantined_*`/`rejected_*`/`conflict_*` — inside the body).
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

  // 3) Serve the client's explicit wants the server holds, repacked within the
  // client's response budget.  A held want dropped for budget → `partial` (the peer
  // re-exchanges or fetches the remainder via the GET routes); otherwise `ok`.
  let responsePack: Uint8Array | undefined;
  let status: 'ok' | 'partial' = 'ok';
  if (request.want !== undefined && request.want.length > 0) {
    const repacked = await repackHeldObjects(
      server,
      request.want.map((w) => w.cid),
      request.pulse.budgets.max_response_bytes,
    );
    if (repacked.pack !== undefined) responsePack = repacked.pack;
    if (repacked.truncated) status = 'partial';
  }

  const response = buildExchangeResponse({
    pulse: await server.serverPulse(),
    status,
    ...(acceptedPush !== undefined ? { acceptedPush } : {}),
    ...(wantedFromClient.length > 0 ? { wantedFromClient } : {}),
    ...(responsePack !== undefined ? { responsePack } : {}),
  });
  return new Response(encodeWithSchema(exchangeResponseV2Schema, response), {
    status: 200,
    headers: { 'content-type': 'application/cbor' },
  });
}

/** Lowercase hex for a byte array (the deterministic §29.7 proof/root encoding). */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * §29.7 `GET /rooms/:roomId/checkpoint`: the room's current (unsigned) Merkle tree
 * head — size + root over the canonical acceptance order.  An unknown/empty room is
 * a well-defined size-0 head (the RFC 9162 empty-tree hash), so this is always 200.
 */
async function handleRoomCheckpoint(server: LcapIngestServer, roomId: string): Promise<Response> {
  const head = await server.roomTreeHead(roomId);
  return json(200, {
    tree_size: head.treeSize,
    root_hash: toHex(head.rootHash),
    tree_algorithm: head.algorithm,
  });
}

/**
 * §29.7 `GET /rooms/:roomId/proofs/inclusion?record_cid=…`: the RFC 9162 inclusion
 * path for a record in the room's log.  Missing/malformed `record_cid` → 400; a
 * record not in the room → 404; otherwise 200 with the audit path (hex).
 */
async function handleRoomInclusion(
  server: LcapIngestServer,
  roomId: string,
  recordCid: string | undefined,
): Promise<Response> {
  if (recordCid === undefined || recordCid === '') {
    return json(400, { error: 'missing_record_cid' });
  }
  try {
    parseCid(recordCid);
  } catch {
    return json(400, { error: 'bad_cid' });
  }
  const proof = await server.roomInclusionProof(roomId, recordCid);
  if (!proof) return json(404, { error: 'not_found' });
  return json(200, {
    tree_size: proof.treeSize,
    leaf_index: proof.leafIndex,
    audit_path: proof.auditPath.map(toHex),
    tree_algorithm: proof.algorithm,
  });
}

/**
 * §29.7 `GET /rooms/:roomId/proofs/consistency?old=…&new=…`: the RFC 9162
 * consistency proof that the `new`-size prefix extends the `old`-size prefix.
 * Missing sizes or sizes outside `0 ≤ old ≤ new ≤ tree_size` → a non-retriable 400.
 */
async function handleRoomConsistency(
  server: LcapIngestServer,
  roomId: string,
  oldStr: string | undefined,
  newStr: string | undefined,
): Promise<Response> {
  if (oldStr === undefined || newStr === undefined) {
    return json(400, { error: 'missing_sizes' });
  }
  const result = await server.roomConsistencyProof(roomId, Number(oldStr), Number(newStr));
  if (result === 'out_of_range') return json(400, { error: 'out_of_range' });
  return json(200, {
    first_size: result.firstSize,
    second_size: result.secondSize,
    proof: result.proof.map(toHex),
    tree_algorithm: result.algorithm,
  });
}

// A room export stays well under the reader's max pack size so it always re-imports.
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

/**
 * §29.8 `POST /bundles/export`: produce a `.licio-bundle` of a room's content closure —
 * its accepted records (acceptance order) each followed by its proofs then its referenced
 * blocks — repacked from held bytes.  GATED: a server export discloses the room's accepted
 * content (which may hold in_room material), so the POST body carries a device-signed,
 * freshness-windowed `export_request` envelope, and the export proceeds ONLY when the
 * requester holds a non-revoked, authority-signed `may_export_bundle` capability for the
 * room (the export gate, WS-R.12.4 / review #5).  Every object is CID-verified on re-import
 * and each record self-authenticates via its included proof, so the pack itself is UNSIGNED
 * (the platform holds no key).  Bad envelope/proof → 400; a failed gate → 403; an
 * empty/unknown room → 404; an over-budget closure → 413; otherwise 200 with the generic
 * (room/topic-free) download filename (§26.3 / WS-R.4.4).
 */
async function handleExport(server: LcapIngestServer, body: Uint8Array): Promise<Response> {
  let envelope: ExportRequestEnvelopeV2;
  try {
    envelope = decodeWithSchema(exportRequestEnvelopeV2Schema, body);
  } catch {
    return json(400, { error: 'bad_export_request' });
  }
  let proof: DetachedProofV2;
  try {
    proof = decodeProof(envelope.proof_body);
  } catch {
    return json(400, { error: 'bad_export_request' });
  }
  // Re-encode the request to the canonical body the proof covers (the `record_cid` preimage).
  const requestBody = encodeWithSchema(exportRequestV2Schema, envelope.request);
  const auth = await server.authorizeExport(envelope.request, requestBody, proof);
  if (!auth.ok) return json(403, { error: 'export_forbidden', reason: auth.status });

  const cids = await server.exportRoomClosureCids(auth.roomId);
  if (cids.length === 0) return json(404, { error: 'not_found' });
  const repacked = await repackHeldObjects(server, cids, MAX_EXPORT_BYTES);
  if (repacked.pack === undefined) return json(404, { error: 'not_found' });
  // A room whose closure exceeds the export budget must FAIL loudly, not silently hand
  // back a partial `.licio-bundle` missing later records/proofs/blocks (§29.8).
  if (repacked.truncated) return json(413, { error: 'export_too_large' });
  return new Response(new Uint8Array(repacked.pack), {
    status: 200,
    headers: {
      'content-type': BUNDLE_MIME,
      'content-disposition': `attachment; filename="${genericBundleFilename()}"`,
    },
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
  // Media chunks are stored, repacked, and advertised as `chunk` wants, so they need a
  // resumable read route too — else a chunk dropped from a budget-limited response_pack
  // could never be fetched to clear the want (§29.4-6).
  app.get('/chunks/:cid', read('chunk'));
  // §29.7 room checkpoint / inclusion / consistency reads (GETs → CSRF passes).
  app.get('/rooms/:roomId/checkpoint', (c) =>
    handleRoomCheckpoint(server(), c.req.param('roomId')),
  );
  app.get('/rooms/:roomId/proofs/inclusion', (c) =>
    handleRoomInclusion(server(), c.req.param('roomId'), c.req.query('record_cid')),
  );
  app.get('/rooms/:roomId/proofs/consistency', (c) =>
    handleRoomConsistency(server(), c.req.param('roomId'), c.req.query('old'), c.req.query('new')),
  );
  // §29.8 bundle export: a room's content closure as a pack, GATED by a device-signed
  // `may_export_bundle` capability (review #5).  A POST (it carries the signed export
  // request), CSRF-exempt + rate-limited like the other device-authenticated LCAP routes.
  app.post('/bundles/export', rateLimit({ limit: 30, windowMs: 60_000 }), async (c) => {
    if (declaredLengthExceeds(c, SERVER_CAPS.maxPackBytes))
      return json(413, { error: 'oversized_request' });
    return handleExport(server(), new Uint8Array(await c.req.arrayBuffer()));
  });
  app.post('/packs', rateLimit({ limit: 60, windowMs: 60_000 }), async (c) => {
    if (declaredLengthExceeds(c, SERVER_CAPS.maxPackBytes))
      return json(413, { error: 'oversized_request' });
    return ingestPack(server(), new Uint8Array(await c.req.arrayBuffer()));
  });
  // §29.8 bundle import: the web-UI alias of /packs (same validator; CSRF-protected
  // — it is NOT in the CSRF-exempt set, so a session-bearing browser flow keeps the
  // double-submit token).
  app.post('/bundles/import', rateLimit({ limit: 60, windowMs: 60_000 }), async (c) => {
    if (declaredLengthExceeds(c, SERVER_CAPS.maxPackBytes))
      return json(413, { error: 'oversized_request' });
    return ingestPack(server(), new Uint8Array(await c.req.arrayBuffer()));
  });
  app.post('/pulse', rateLimit({ limit: 120, windowMs: 60_000 }), async (c) => {
    if (declaredLengthExceeds(c, MAX_PULSE_REQUEST_BYTES))
      return json(413, { error: 'oversized_request' });
    return handlePulse(server(), new Uint8Array(await c.req.arrayBuffer()));
  });
  app.post('/exchange', rateLimit({ limit: 60, windowMs: 60_000 }), async (c) => {
    if (declaredLengthExceeds(c, SERVER_CAPS.maxPackBytes))
      return json(413, { error: 'oversized_request' });
    return handleExchange(server(), new Uint8Array(await c.req.arrayBuffer()));
  });
  // §29 WebRTC server-blind signaling rendezvous (WS-R.15.6a): route an OPAQUE sealed
  // blob to an opaque recipient key. The body is never decoded here (server-blindness);
  // session-bound + CSRF-protected (NOT in the CSRF-exempt set) — a browser P2P flow
  // keeps the double-submit token.
  app.post('/p2p/signal', rateLimit({ limit: 120, windowMs: 60_000 }), async (c) => {
    const result = getSignalMailbox().post(
      c.req.query('to'),
      new Uint8Array(await c.req.arrayBuffer()),
      Date.now(),
    );
    return new Response(null, { status: result.ok ? 202 : result.status });
  });
  // The drain DELETES the peer's queued blobs, so it is a state-changing POST (CSRF-
  // protected, like the post above — NOT a GET, which would bypass CSRF + the session and
  // let any unauthenticated party that learns a peer key consume another peer's queue).
  app.post('/p2p/signal/poll', rateLimit({ limit: 240, windowMs: 60_000 }), (c) => {
    const blobs = getSignalMailbox().drain(c.req.query('peer'), Date.now());
    return new Response(new Uint8Array(frameBlobs(blobs)), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  });
  return app;
}
