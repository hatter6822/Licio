// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.10 — the CLIENT-side §16 exchange engine: the responder + the requester-ingestion half
// that makes the P2P transports (the courier AND the WebRTC carrier) MOVE content, not just run
// the handshake.  Both carriers share this one module so the trust-sensitive plumbing lives in a
// single, tested place:
//
//   • buildClientExchangeRequest — a request advertising what we're missing (`want`s drawn from
//     the local quarantine) so a peer can serve our gaps.
//   • respondToClientExchange — serve a peer's explicit `want`s from the local `lcap_v2` store
//     (the PURE `@licio/lcap` repack over `getHeldObject`) AND ingest the peer's optional
//     `push_pack`, returning a §16 response.
//   • ingestClientExchangeResponse — CID-verify + commit a served `response_pack` into the local
//     store, reusing the WS-R.4.3 bundle-import pipeline so there is NO new trust surface (every
//     frame re-verified by CID, committed at INTEGRITY-ONLY trust, missing deps quarantined).
//
// SECURITY: the radio/peer confers NO trust — every served/pushed frame is re-verified by CID in
// `readPack`/`importPack` and re-projected by `validate()` downstream (§18.4); content is
// PUBLIC-only (the carriage gate + the conservative pack privacy label); nothing renders before
// trust projection (§8.3).  The heavy `@licio/lcap` codec is loaded by DYNAMIC import (like
// `bundle-import`), so this module stays off the initial bundle.

import type { HeldObject } from '@licio/lcap';
import {
  type CommitCounts,
  commitImportedBundle,
  heldCidsFor,
  importBundleObjects,
  readBundleForImport,
} from './bundle-import.js';
import { LCAP_STORE } from './db.js';
import { collectByCursor, getHeldObject, proofCidsForRecord, type RecordRow } from './store.js';

export type { CommitCounts };

/** Cap on how many local records a content PUSH enumerates (bounded device CPU + wire). */
const MAX_PUSH_RECORDS = 64;

/**
 * A held-object reader that serves PUBLIC content only — the public P2P plane (courier + WebRTC)
 * NEVER carries a non-public contribution.  Control/proof/block objects are public trust material;
 * only a `contribution_event` carries a restricted visibility scope.  Defense in depth even though
 * `lcap_v2` is the public store; the receiver re-verifies every CID regardless.
 */
function publicHeldReader(
  db: IDBDatabase,
  lcap: typeof import('@licio/lcap'),
): (cid: string) => Promise<HeldObject | undefined> {
  return async (cid: string): Promise<HeldObject | undefined> => {
    const held = await getHeldObject(db, cid);
    if (held?.kind === 'record') {
      try {
        const record = lcap.decodeAndRouteRecord(held.bytes);
        if (record.kind === 'contribution_event' && record.visibility_scope !== 'public') {
          return undefined; // non-public — refuse to serve over the public plane
        }
      } catch {
        return undefined; // undecodable — never serve
      }
    }
    return held;
  };
}

/**
 * Build a PUBLIC content PUSH pack from local content (gossip-out): up to {@link MAX_PUSH_RECORDS}
 * public records + their proofs + referenced blocks, budget-bounded, public-only.  Lets a peer
 * proactively SEED content others don't yet know to want (epidemic distribution), not only fetch
 * its own gaps.  Returns `undefined` when nothing public is held.
 */
async function buildPushPack(
  db: IDBDatabase,
  lcap: typeof import('@licio/lcap'),
  budget: number,
): Promise<Uint8Array | undefined> {
  const records = await collectByCursor<RecordRow>(db, LCAP_STORE.records, MAX_PUSH_RECORDS);
  const cids: string[] = [];
  for (const row of records) {
    try {
      const decoded = lcap.decodeAndRouteRecord(row.body);
      if (decoded.kind === 'contribution_event' && decoded.visibility_scope !== 'public') continue;
    } catch {
      continue; // undecodable — never push
    }
    cids.push(row.recordCid, ...(await proofCidsForRecord(db, row.recordCid)), ...(row.deps ?? []));
  }
  if (cids.length === 0) return undefined;
  // The public-only reader drops any non-public dep, so the push can never leak restricted content.
  const repacked = await lcap.repackHeldObjects(publicHeldReader(db, lcap), cids, budget);
  return repacked.pack;
}

/** The §16 response budget we serve up to when the peer advertises none (kept small per the
 *  courier/battery doctrine; a held want dropped for budget stays fetchable elsewhere). */
const DEFAULT_RESPONSE_BUDGET = 1 << 20; // 1 MiB
/** Cap on how many `want`s we advertise per request (bounded wire + bounded peer work). */
const MAX_WANTS = 256;

interface QuarantineRow {
  readonly cid: string;
  readonly missingDeps?: readonly string[];
}

/**
 * Ingest a CID-verified content pack (a peer's `push_pack` or served `response_pack`) into the
 * local `lcap_v2` store via the WS-R.4.3 bundle pipeline.  Returns the commit counts, or `null`
 * when the bytes are not a readable/public pack (fail-closed: a private-labelled or malformed
 * pack is refused, nothing committed).
 */
export async function ingestPackIntoStore(
  db: IDBDatabase,
  packBytes: Uint8Array,
): Promise<CommitCounts | null> {
  const read = await readBundleForImport(packBytes);
  if (!read.ok) return null; // malformed / truncated / private-labelled → refuse, commit nothing
  const alreadyHave = await heldCidsFor(db, read.pack);
  const imported = await importBundleObjects(read.pack, { alreadyHave });
  return commitImportedBundle(db, read.pack, imported);
}

/** The CIDs we are MISSING (quarantined prerequisites), as §16 `want`s — so a peer can serve our
 *  gaps.  `cid_kind` is a wire hint only; the responder serves by CID regardless of kind. */
async function collectQuarantineWants(
  db: IDBDatabase,
): Promise<Array<{ cid: string; cid_kind: 'record'; reason: 'missing_dependency' }>> {
  const rows = await collectByCursor<QuarantineRow>(db, LCAP_STORE.quarantine, MAX_WANTS);
  const wantCids = new Set<string>();
  for (const row of rows) {
    for (const dep of row.missingDeps ?? []) {
      wantCids.add(dep);
      if (wantCids.size >= MAX_WANTS) break;
    }
    if (wantCids.size >= MAX_WANTS) break;
  }
  return [...wantCids].map((cid) => ({
    cid,
    cid_kind: 'record' as const,
    reason: 'missing_dependency' as const,
  }));
}

/** Build a minimal PUBLIC §16 pulse (we advertise no frontier — a conservative "behind on
 *  everything" so the carriage gate + privacy label stay public-only). */
async function publicPulse(
  lcap: typeof import('@licio/lcap'),
  transportProfile: 'courier' | 'relay',
): Promise<ReturnType<typeof lcap.buildPulse>> {
  const sessionNonce = new Uint8Array(16);
  globalThis.crypto.getRandomValues(sessionNonce);
  return lcap.buildPulse({
    nodeId: `lcap-${transportProfile}`,
    sessionNonce,
    transportProfile,
    privacyMode: 'public',
    budgets: { ...lcap.DEFAULT_BUDGET, minimal_mode: true },
    supportedSuites: ['ES256'],
    supportedCompression: ['none', 'gzip', 'deflate'],
    supportedPackVersions: [2],
    checkpointFrontier: [],
    revocationFrontier: [{ scope: 'global', revocation_epoch: 0 }],
  });
}

/**
 * Build a §16 exchange REQUEST that advertises our gaps (quarantine `want`s) so a peer serves
 * them.  `transportProfile` records the carrier (courier / WebRTC-relay).  Public-only.
 */
export async function buildClientExchangeRequest(
  db: IDBDatabase,
  transportProfile: 'courier' | 'relay' = 'courier',
): Promise<Uint8Array> {
  const lcap = await import('@licio/lcap');
  const pulse = await publicPulse(lcap, transportProfile);
  const want = await collectQuarantineWants(db);
  // PUSH our public content too (gossip-out) so a peer can ingest content it didn't know to want
  // (bounded by the request budget, which the push rides in).
  const pushPack = await buildPushPack(db, lcap, pulse.budgets.max_request_bytes);
  const request = lcap.buildExchangeRequest({
    pulse,
    interests: [],
    want,
    ...(pushPack !== undefined ? { pushPack } : {}),
  });
  return lcap.encodeWithSchema(lcap.exchangeRequestV2Schema, request);
}

/**
 * RESPOND to a peer's inbound §16 exchange request: ingest its optional `push_pack`, serve its
 * explicit `want`s from the local store (the pure repack over `getHeldObject`), and return an
 * encoded §16 response.  Returns `null` when the bytes are not a valid exchange request
 * (fail-closed — never mistaken for our own response upstream).
 */
export async function respondToClientExchange(
  db: IDBDatabase,
  requestBytes: Uint8Array,
): Promise<Uint8Array | null> {
  const lcap = await import('@licio/lcap');
  const request = ((): import('@licio/lcap').ExchangeRequestV2 | null => {
    try {
      return lcap.decodeWithSchema(lcap.exchangeRequestV2Schema, requestBytes);
    } catch {
      return null; // not a request (a response, or garbage) — the caller handles classification
    }
  })();
  if (request === null) return null;

  // Ingest the peer's pushed content (gossip-in), CID-verified into the local store.
  if (request.push_pack !== undefined) {
    await ingestPackIntoStore(db, request.push_pack);
  }

  // Serve the peer's explicit wants from what we hold, within its advertised response budget —
  // PUBLIC-ONLY (the courier + WebRTC are public-plane carriers, §22.6): the responder never
  // serves a non-public contribution (the shared public-only reader drops it).
  const wantCids = (request.want ?? []).map((w) => w.cid);
  const budget = request.pulse.budgets.max_response_bytes || DEFAULT_RESPONSE_BUDGET;
  const repacked =
    wantCids.length > 0
      ? await lcap.repackHeldObjects(publicHeldReader(db, lcap), wantCids, budget)
      : { served: [], truncated: false, pack: undefined };

  const pulse = await publicPulse(lcap, 'courier');
  const response = lcap.buildExchangeResponse({
    pulse,
    status: repacked.truncated ? 'partial' : 'ok',
    ...(repacked.pack !== undefined ? { responsePack: repacked.pack } : {}),
  });
  return lcap.encodeWithSchema(lcap.exchangeResponseV2Schema, response);
}

/** The outcome of handling one inbound exchange message over a duplex channel. */
export interface InboundExchangeOutcome {
  /** True when the message was a peer REQUEST (we built a `reply` to send back). */
  readonly wasRequest: boolean;
  /** The §16 response to ferry back, when the message was a request; else `null`. */
  readonly reply: Uint8Array | null;
  /** The commit counts when the message was a RESPONSE we ingested; else `null`. */
  readonly ingested: CommitCounts | null;
}

/**
 * Handle ONE inbound §16 message on a DUPLEX channel (the WebRTC carrier): classify it as a peer
 * REQUEST (respond — serve their wants + ingest their push) or our RESPONSE (ingest the served
 * pack).  Returns what to send back (a reply when it was a request) so the caller drives a fully
 * bidirectional exchange over one channel without mistaking a peer's request for our response.
 */
export async function handleInboundExchangeMessage(
  db: IDBDatabase,
  bytes: Uint8Array,
): Promise<InboundExchangeOutcome> {
  // respondToClientExchange returns null for anything that is NOT a valid request, so it doubles
  // as the classifier — a non-null reply means it WAS a request (and its push was ingested).
  const reply = await respondToClientExchange(db, bytes);
  if (reply !== null) return { wasRequest: true, reply, ingested: null };
  const ingested = await ingestClientExchangeResponse(db, bytes);
  return { wasRequest: false, reply: null, ingested };
}

/**
 * Ingest a §16 exchange RESPONSE's served `response_pack` into the local store (the requester
 * side — fills our quarantine gaps).  Returns the commit counts, or `null` when the response
 * carries no pack / is not a valid response.
 */
export async function ingestClientExchangeResponse(
  db: IDBDatabase,
  responseBytes: Uint8Array,
): Promise<CommitCounts | null> {
  const lcap = await import('@licio/lcap');
  const response = ((): import('@licio/lcap').ExchangeResponseV2 | null => {
    try {
      return lcap.decodeWithSchema(lcap.exchangeResponseV2Schema, responseBytes);
    } catch {
      return null;
    }
  })();
  if (response === null || response.response_pack === undefined) return null;
  return ingestPackIntoStore(db, response.response_pack);
}
