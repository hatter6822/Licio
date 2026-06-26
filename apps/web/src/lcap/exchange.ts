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

import {
  type CommitCounts,
  commitImportedBundle,
  heldCidsFor,
  importBundleObjects,
  readBundleForImport,
} from './bundle-import.js';
import { LCAP_STORE } from './db.js';
import {
  collectShareableRecordRows,
  forEachByCursor,
  getHeldObject,
  normalizeRoomKey,
  proofCidsForRecord,
  type RecordRow,
  readBlockDescriptor,
} from './store.js';

export type { CommitCounts };

/** Cap on how many local records the share-closure enumerates (bounded device CPU + wire). */
const MAX_SHARE_RECORDS = 256;

/**
 * The §22.5 sharing scope — WHAT this device may serve/push over the public P2P plane.  Narrows
 * (never widens) public content: an optional room allowlist (opaque hashes) + a priority cap.
 */
export interface ExchangeScope {
  /** Opaque room hashes to share; empty/absent ⇒ all public rooms. */
  readonly roomHashAllowlist?: readonly string[];
  /** Highest priority class shared (P0 most essential; 0..4; absent ⇒ 4 = all lanes). */
  readonly maxPriorityClass?: number;
}

/**
 * The CIDs this device may SHARE over the public plane — ONE trust-sensitive place computes it for
 * BOTH the responder and the push.  For each held record that is PUBLIC, in an allowed room, AND
 * within the priority cap, include the record + its proofs + its HELD BLOCK deps (the public
 * record's own body/attachment bytes).  A record dep (a parent / a capability) is NEVER pulled in
 * here — it is shared only on its OWN shareable merit (via enumeration), so an in-room parent or a
 * non-public block can never ride a public record (closes the §22.6 non-public-dependency leak).
 * Returned in record order so the push fills its budget deterministically.
 */
async function collectShareableCids(
  db: IDBDatabase,
  lcap: typeof import('@licio/lcap'),
  scope: ExchangeScope | undefined,
): Promise<string[]> {
  const maxPriority = scope?.maxPriorityClass ?? 4;
  // A record is shareable iff it decodes, is PUBLIC, and is within the priority cap.  The room
  // filter is applied by the index walk in collectShareableRecordRows (so the cap counts in-scope
  // SHAREABLE rows, never just the first N raw rows of the store).
  const isShareable = (row: RecordRow): boolean => {
    let decoded: ReturnType<typeof lcap.decodeAndRouteRecord>;
    try {
      decoded = lcap.decodeAndRouteRecord(row.body);
    } catch {
      return false; // undecodable — never share
    }
    // ANY record kind that carries a visibility_scope (contribution_event AND room_capability) is
    // excluded when it is non-public — never push/serve a restricted record (or its proofs) over
    // the public plane, not just contributions.
    if ('visibility_scope' in decoded && decoded.visibility_scope !== 'public') return false;
    const priority = decoded.kind === 'contribution_event' ? decoded.priority : 0;
    return priority <= maxPriority;
  };
  const rows = await collectShareableRecordRows(
    db,
    scope?.roomHashAllowlist,
    MAX_SHARE_RECORDS,
    isShareable,
  );
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (cid: string): void => {
    if (!seen.has(cid)) {
      seen.add(cid);
      out.push(cid);
    }
  };
  for (const row of rows) {
    add(row.recordCid);
    for (const proofCid of await proofCidsForRecord(db, row.recordCid)) add(proofCid);
    // Re-derive the shareable BLOCK deps from the record's SIGNED body — NOT `row.deps`, which is
    // unauthenticated pack-table metadata a crafted public record could use to list an unrelated
    // held in-room / media block CID and exfiltrate it onto the public plane (#O).  Only the body's
    // OWN block CIDs (body / attachment / source-snapshot) are eligible, and the readBlockDescriptor
    // gate keeps it to HELD blocks; a record dep (parent / capability) is never pulled in here.
    let decoded: ReturnType<typeof lcap.decodeAndRouteRecord>;
    try {
      decoded = lcap.decodeAndRouteRecord(row.body);
    } catch {
      continue; // undecodable — share nothing further for it
    }
    if (decoded.kind === 'contribution_event') {
      const bodyBlockDeps: ReadonlyArray<string | undefined> = [
        decoded.body_block_cid,
        decoded.attachment_manifest_cid,
        ...(decoded.source_snapshot_cids ?? []),
        decoded.target_source_snapshot_cid,
      ];
      for (const dep of bodyBlockDeps) {
        if (dep !== undefined && (await readBlockDescriptor(db, dep))) add(dep);
      }
    }
  }
  return out;
}

/**
 * Build a PUBLIC content PUSH pack from the shareable closure (scope-filtered: public-only,
 * room-allowlisted, priority-capped), budget-bounded.  Lets a peer proactively SEED content others
 * don't yet know to want, never leaking restricted content.  `undefined` when nothing is shareable.
 */
async function buildPushPack(
  db: IDBDatabase,
  lcap: typeof import('@licio/lcap'),
  budget: number,
  scope: ExchangeScope | undefined,
): Promise<Uint8Array | undefined> {
  const cids = await collectShareableCids(db, lcap, scope);
  if (cids.length === 0) return undefined;
  const repacked = await lcap.repackHeldObjects((cid) => getHeldObject(db, cid), cids, budget);
  return repacked.pack;
}

/** Cap on how many `want`s we advertise per request (bounded wire + bounded peer work). */
const MAX_WANTS = 256;

interface QuarantineRow {
  readonly cid: string;
  readonly missingDeps?: readonly string[];
  readonly roomHash?: string;
  /** Whether the quarantined record is PUBLIC — `false` keeps its wants off the public plane (#NN). */
  readonly public?: boolean;
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
  scope?: ExchangeScope,
): Promise<CommitCounts | null> {
  const read = await readBundleForImport(packBytes);
  if (!read.ok) return null; // malformed / truncated / private-labelled → refuse, commit nothing
  const alreadyHave = await heldCidsFor(db, read.pack);
  const imported = await importBundleObjects(read.pack, { alreadyHave });
  // A room-scoped sync commits ONLY the allowlisted rooms' records — a peer cannot push unrelated
  // public rooms' content into `lcap_v2` past the scope (#M).  An unscoped sync commits all public.
  const roomAllowlist =
    (scope?.roomHashAllowlist?.length ?? 0) > 0
      ? new Set((scope as ExchangeScope).roomHashAllowlist?.map(normalizeRoomKey))
      : undefined;
  // This is the PUBLIC plane ingress (courier / WebRTC / anchor) — commit ONLY public records, so a
  // peer cannot push in_room/private records (or a misleading public-header pack) into lcap_v2 (#P).
  return commitImportedBundle(db, read.pack, imported, Date.now(), {
    publicOnly: true,
    ...(roomAllowlist !== undefined ? { roomAllowlist } : {}),
  });
}

/** The CIDs we are MISSING (quarantined prerequisites), as §16 `want`s — so a peer can serve our
 *  gaps.  `cid_kind` is a wire hint only; the responder serves by CID regardless of kind. */
async function collectQuarantineWants(
  db: IDBDatabase,
  scope?: ExchangeScope,
): Promise<Array<{ cid: string; cid_kind: 'record'; reason: 'missing_dependency' }>> {
  const allow =
    (scope?.roomHashAllowlist?.length ?? 0) > 0
      ? new Set((scope as ExchangeScope).roomHashAllowlist?.map(normalizeRoomKey))
      : undefined;
  const wantCids = new Set<string>();
  // Cursor the WHOLE quarantine store, accumulating UNIQUE missing CIDs until MAX_WANTS — counting
  // unique WANTS, not raw rows, so many rows sharing one missing prerequisite never starve distinct
  // gaps from being advertised (#I).  A room-scoped sync advertises ONLY its rooms' gaps, so "Sync
  // this room" never leaks/fetches an unrelated room's missing CIDs (#K).
  await forEachByCursor<QuarantineRow>(db, LCAP_STORE.quarantine, (row) => {
    // buildClientExchangeRequest is ALWAYS the PUBLIC plane (courier / WebRTC) — never advertise an
    // in_room/private record's missing prerequisite CIDs over it (a manual non-public file import
    // tags such rows `public:false`); skip them so the gap never leaks/fetches on the public P2P
    // plane (#NN).  Untagged legacy rows stay advertised (they predate the tag).
    if (row.public === false) return;
    if (allow && (row.roomHash === undefined || !allow.has(normalizeRoomKey(row.roomHash)))) {
      return; // not a room we are syncing — skip its gaps
    }
    for (const dep of row.missingDeps ?? []) wantCids.add(dep);
    if (wantCids.size >= MAX_WANTS) return false; // enough unique wants — stop the scan
    return;
  });
  return [...wantCids].slice(0, MAX_WANTS).map((cid) => ({
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
    // minimalBudget ALSO shrinks the numeric fields (max_response_bytes, priority_floor, media) — not
    // just the flag — so a "minimal" public pulse cannot still solicit full-priority/media responses (#XX).
    budgets: lcap.minimalBudget(lcap.DEFAULT_BUDGET),
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
  scope?: ExchangeScope,
): Promise<Uint8Array> {
  const lcap = await import('@licio/lcap');
  const pulse = await publicPulse(lcap, transportProfile);
  const maxRequestBytes = pulse.budgets.max_request_bytes;
  let want = await collectQuarantineWants(db, scope);

  const encode = (w: typeof want, push: Uint8Array | undefined): Uint8Array =>
    lcap.encodeWithSchema(
      lcap.exchangeRequestV2Schema,
      lcap.buildExchangeRequest({
        pulse,
        interests: [],
        want: w,
        ...(push !== undefined ? { pushPack: push } : {}),
      }),
    );

  // The advertised budget bounds the WHOLE encoded request, not just the push_pack: reserve the
  // encoded overhead of the pulse + wants + CBOR wrapper, then give the gossip-out push only what
  // remains — so in minimal mode (16 KiB) or with many wants the request never exceeds the budget we
  // advertise to constrained peers (#AK).
  const baseBytes = encode(want, undefined).length;
  const pushBudget = maxRequestBytes - baseBytes;
  // PUSH our shareable content too (gossip-out) — scope-filtered (public-only, room-allowlisted,
  // priority-capped), bounded by the budget left AFTER the pulse + wants.
  let pushPack = pushBudget > 256 ? await buildPushPack(db, lcap, pushBudget, scope) : undefined;
  let encoded = encode(want, pushPack);
  // Drop the (optional) push if its wrapper still tips the request over budget — the wants are essential.
  if (encoded.length > maxRequestBytes && pushPack !== undefined) {
    pushPack = undefined;
    encoded = encode(want, undefined);
  }
  // If the wants alone still exceed (many gaps in minimal mode), trim the least-essential tail until
  // the request fits — the dropped gaps are re-advertised on a later, less-constrained pass.
  while (encoded.length > maxRequestBytes && want.length > 0) {
    want = want.slice(0, Math.max(0, want.length - 8));
    encoded = encode(want, undefined);
  }
  return encoded;
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
  scope?: ExchangeScope,
  shouldIngestPush?: () => boolean,
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

  // Ingest the peer's pushed content (gossip-in), CID-verified AND ROOM-SCOPED into the local store:
  // a room-scoped sync ("Sync this room") commits only the allowlisted rooms' records (the scope
  // filter drops a peer's UNRELATED public rooms — so ambient gossip can't pollute `lcap_v2` past
  // the allowlist), while an unscoped sync accepts all public gossip.  The push ingest is a SIDE
  // EFFECT, so it is skipped when the caller's liveness check has gone false (a Stop / revocation /
  // peers→none during this async build), so a stopped courier never commits the push (#OO).
  if (request.push_pack !== undefined && (shouldIngestPush?.() ?? true)) {
    await ingestPackIntoStore(db, request.push_pack, scope);
  }

  // Serve ONLY what the peer wants AND we may share: intersect the peer's wants with our SHAREABLE
  // closure (public-only, room-allowlisted, priority-capped) — so a peer can never receive a
  // non-public/in-room/over-priority object even if it knows the CID (§22.6).  The peer's
  // advertised response budget bounds it; a zero budget is HONORED (serve nothing), not defaulted.
  const shareable = new Set(await collectShareableCids(db, lcap, scope));
  const wantCids = (request.want ?? []).map((w) => w.cid).filter((cid) => shareable.has(cid));
  const budget = request.pulse.budgets.max_response_bytes;
  const repacked =
    wantCids.length > 0 && budget > 0
      ? await lcap.repackHeldObjects((cid) => getHeldObject(db, cid), wantCids, budget)
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
  scope?: ExchangeScope,
  /** Re-evaluated right before EITHER store write (the responder's push ingest OR the requester's
   *  response ingest): a cancelled/settled WebRTC exchange must not commit the peer's pack after the
   *  fact — the caller's post-await check can only suppress counting/replying, not undo a commit (#AH). */
  shouldCommit?: () => boolean,
): Promise<InboundExchangeOutcome> {
  // respondToClientExchange returns null for anything that is NOT a valid request, so it doubles
  // as the classifier — a non-null reply means it WAS a request (and its push was ingested).
  const reply = await respondToClientExchange(db, bytes, scope, shouldCommit);
  if (reply !== null) return { wasRequest: true, reply, ingested: null };
  // A RESPONSE we ingest is room-scoped too — a peer's response_pack cannot land unrelated rooms.
  const ingested = await ingestClientExchangeResponse(db, bytes, scope, shouldCommit);
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
  scope?: ExchangeScope,
  shouldCommit?: () => boolean,
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
  if (shouldCommit && !shouldCommit()) return null; // cancelled/settled before the store write (#AH)
  // Room-scoped: a peer cannot fill our store with unrelated rooms via a valid-but-off-scope pack.
  return ingestPackIntoStore(db, response.response_pack, scope);
}
