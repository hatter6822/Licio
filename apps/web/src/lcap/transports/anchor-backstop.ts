// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The application-level §16 WANTS-COMPLETION back-stop (OFFLINE_SPEC §16, §22.6).  After a PEER
// round (WebRTC or native courier) has served + INGESTED whatever it could, this fills any wants the
// request STILL advertises that the local `lcap_v2` store does not yet hold, from the always-correct
// HTTPS anchor.
//
// WHY this is its own app-layer primitive (the architectural fix):
//   • "fill my remaining wants" is an APPLICATION concern — it needs the post-ingest HELD state (the
//     `lcap_v2` DB) and the request's wants.  It is NOT the same as the transport seam's reachability
//     fallback (`fallbackExchange` returns the FIRST transport that yields ANY non-null response —
//     correct for "peer down → use the server", WRONG for "peer answered but lacked some wants").
//   • Driving the anchor off the seam's first-responder semantic (as the courier radio controller did)
//     therefore STRANDS the gaps after a PARTIAL peer response.  Lifting wants-completion here — at the
//     layer that owns the DB + ingest — lets BOTH carriers complete a partial round at the anchor with
//     ONE tested primitive, instead of each re-deriving the decision (and the courier getting it wrong).

import type { TransportId } from '@licio/lcap';
import {
  type CommitCounts,
  type ExchangeScope,
  ingestClientExchangeResponse,
  requestHasUnfilledWants,
} from '../exchange.js';
import type { HttpsTransportConfig } from './https.js';
import { buildServerTransports, offlineExchange } from './registry.js';

export interface AnchorBackstopResult {
  /** The anchor transport that carried the completion (`'https'`, or WebTransport when configured). */
  readonly transport: TransportId;
  /** The commit counts the anchor served, or `null` when it served no pack. */
  readonly ingested: CommitCounts | null;
}

/**
 * Fill the wants `request` still advertises that the local store does NOT yet hold, from the HTTPS
 * anchor.  Returns `null` when there is nothing left to fill (the peer round already covered our
 * wants — `requestHasUnfilledWants` keys off HELD content, since quarantine rows are not promoted on
 * ingest), the caller has gone non-live, or the anchor is unreachable.  `shouldCommit` is threaded to
 * the ingest LEAF (#BA), so a Stop / scope-revocation during the anchor leg never commits after the
 * fact.  The anchor request also carries our push_pack, so a back-stopped round still gossips our
 * content to the server.
 */
export async function backstopUnfilledWantsAtAnchor(
  db: IDBDatabase,
  request: Uint8Array,
  scope: ExchangeScope | undefined,
  httpsConfig: HttpsTransportConfig | undefined,
  shouldCommit?: () => boolean,
): Promise<AnchorBackstopResult | null> {
  if (shouldCommit && !shouldCommit()) return null;
  // The peer round already filled every advertised want ⇒ the anchor would serve nothing new.
  if (!(await requestHasUnfilledWants(db, request))) return null;
  // Re-check liveness AFTER the (async) want scan, immediately BEFORE opening the anchor: a Stop /
  // scope-change / forced-off (Stealth/Emergency) mode that landed DURING the scan must suppress the
  // server CONTACT itself — not only the later commit (the courier going "dark" must not reach the
  // server).  Without this, a flip during the DB reads still uploads the request + push_pack (#1r).
  if (shouldCommit && !shouldCommit()) return null;
  const anchor = await offlineExchange(
    buildServerTransports(httpsConfig ?? {}),
    request,
    undefined,
    'public',
  );
  if (!anchor) return null;
  if (shouldCommit && !shouldCommit()) return null;
  const ingested = await ingestClientExchangeResponse(db, anchor.response, scope, shouldCommit);
  return { transport: anchor.transport, ingested };
}
