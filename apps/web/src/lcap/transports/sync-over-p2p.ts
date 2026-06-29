// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The runtime consumer that turns the (previously caller-less) live WebRTC carrier into a
// real LCAP sync round (OFFLINE_SPEC §16, §22.6, WS-R.15.6).  Until now `connectLcapWebrtc`
// + the `@licio/lcap-p2p` `WebrtcTransport` + the registry's `offlineExchange` all existed
// but had NO runtime caller, so a live data channel was never actually driven by an
// exchange.  `syncRoomOverP2p` closes that gap:
//
//   1. derive the PUBLIC signaling key deterministically from the public `room_id_hash`
//      (`derivePublicSignalKeyBytes`) — see `signal-key.ts` for why this is safe for
//      public content (signaling secrecy is not LCAP's trust root; content-addressing +
//      COSE signatures are);
//   2. establish a live `WebrtcTransport` to the peer over the server-blind rendezvous
//      (`connectLcapWebrtc`, which loads `@licio/lcap-p2p` by DYNAMIC import only, so the
//      protocol/crypto core stays out of the initial bundle — `check:lcap-p2p-split`);
//   3. assemble the transport set (the live WebRTC peer transport AHEAD of the always-
//      correct HTTPS anchor) and run ONE §16 exchange through `offlineExchange`, which
//      uses the seam's `selectTransports` (server-mediated transports forced LAST) so the
//      anchor-last policy is NEVER bypassed, and the public-only carriage gate is applied.
//
// If the WebRTC channel cannot be established (off-by-default, mode force-off, peer
// unreachable, timeout) the establishment rejects; the consumer falls back to exchanging
// over the HTTPS anchor alone, so correctness never depends on the optional peer carrier.

import type { TransportId } from '@licio/lcap';
import type { WebrtcDecision, WebrtcPrivacyOptions } from '@licio/lcap-p2p';
import {
  buildClientExchangeRequest,
  type CommitCounts,
  type ExchangeScope,
  ingestClientExchangeResponse,
  requestHasUnfilledWants,
} from '../exchange.js';
import { type ConnectLcapWebrtcParams, connectLcapWebrtcChannel } from './connect-webrtc.js';
import type { HttpsTransportConfig } from './https.js';
import { buildServerTransports, offlineExchange } from './registry.js';
import { derivePublicSignalKeyBytes } from './signal-key.js';
import { runWebrtcBidirectionalExchange } from './webrtc-sync.js';

export interface SyncRoomOverP2pParams {
  /** The local `lcap_v2` store — BOTH the responder's content source and the requester's
   *  ingestion sink (a fully bidirectional §16 exchange: serve the peer's wants + ingest ours). */
  readonly db: IDBDatabase;
  /** The PUBLIC room rendezvous hash (an opaque one-way hash; never a real room id). */
  readonly roomIdHash: Uint8Array;
  /** This device's opaque peer key (a device-key hash; never an IP, §19.1). */
  readonly selfPeerKey: string;
  /** The remote device's opaque peer key. */
  readonly remotePeerKey: string;
  /** The initiator creates the offer + data channel; the responder answers. */
  readonly initiator: boolean;
  /** The §22.5 sharing scope — what we may serve/push (public-only; room/priority filtered).  A
   *  room sync passes `{ roomHashAllowlist: [thisRoom] }` so it never gossips unrelated rooms. */
  readonly scope?: ExchangeScope;
  /** §26.4 ICE/privacy options (off by default; the user must opt into WebRTC). */
  readonly privacy?: WebrtcPrivacyOptions;
  /** A precomputed §26.4 decision (overrides `privacy`). */
  readonly decision?: WebrtcDecision;
  /** HTTPS anchor configuration (exchange URL + injectable fetch). */
  readonly httpsConfig?: HttpsTransportConfig;
  /** Injectable fetch for the signaling rendezvous (tests). */
  readonly fetchFn?: typeof fetch;
  /** Injectable `RTCPeerConnection` constructor (tests/E2E). */
  readonly rtcFactory?: ConnectLcapWebrtcParams['rtcFactory'];
  /** API origin for the signaling rendezvous (default same-origin). */
  readonly apiBase?: string;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export interface SyncRoomOverP2pResult {
  /** Which transport actually carried the exchange (`'webrtc'` when the peer was reachable). */
  readonly transport: TransportId;
  /** The commit counts when the exchange served us content, or `null` (nothing ingested). */
  readonly ingested: CommitCounts | null;
}

/**
 * Drive ONE fully BIDIRECTIONAL §16 exchange for a PUBLIC room: prefer the live WebRTC peer
 * (both peers serve + ingest over the one channel), and back-stop at the always-correct HTTPS
 * anchor when WebRTC is unreachable OR returned nothing for us.  Returns the carrying transport +
 * the ingest counts, or `null` if every path failed.  Content actually MOVES — a served pack is
 * CID-verified + committed into the local store (no transport trust).
 */
export async function syncRoomOverP2p(
  params: SyncRoomOverP2pParams,
): Promise<SyncRoomOverP2pResult | null> {
  // The public P2P plane builds a PUBLIC request (and the responder serves public-only), so the
  // exchange is structurally public — the §22.6 carriage gate is inherent, not a per-call flag.
  const request = await buildClientExchangeRequest(params.db, 'relay', params.scope);

  // 1) Prefer the live WebRTC peer — a real bidirectional exchange over one duplex channel.
  let channel: Awaited<ReturnType<typeof connectLcapWebrtcChannel>> | null = null;
  // What the WebRTC round COMMITTED this call (null if WebRTC didn't run / served nothing).  Captured
  // OUTSIDE the try so the anchor-fallback can REPORT this real progress rather than a false failure
  // when the anchor leg cannot complete (the back-stop's contract: `null` = EVERY path failed) (#3).
  let webrtcIngested: CommitCounts | null = null;
  try {
    // Public content: derive the shared signaling key from the public room hash so any public
    // peer can join the rendezvous (signaling secrecy is not the trust root here).
    const signalKeyBytes = await derivePublicSignalKeyBytes(params.roomIdHash);
    // Cancel / unmount may have fired WHILE buildClientExchangeRequest + the signal-key derivation
    // awaited; `connectWebrtc` only ATTACHES an abort listener, so an already-fired abort would not
    // be observed before the initiator POSTs its sealed offer — bail before any signaling (#V).
    if (params.signal?.aborted) return null;
    channel = await connectLcapWebrtcChannel({
      signalKeyBytes,
      roomIdHash: params.roomIdHash,
      selfPeerKey: params.selfPeerKey,
      remotePeerKey: params.remotePeerKey,
      initiator: params.initiator,
      ...(params.decision !== undefined ? { decision: params.decision } : {}),
      ...(params.privacy !== undefined ? { privacy: params.privacy } : {}),
      ...(params.apiBase !== undefined ? { apiBase: params.apiBase } : {}),
      ...(params.fetchFn !== undefined ? { fetchFn: params.fetchFn } : {}),
      ...(params.rtcFactory !== undefined ? { rtcFactory: params.rtcFactory } : {}),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
    const out = await runWebrtcBidirectionalExchange({
      db: params.db,
      channel,
      request,
      ...(params.scope !== undefined ? { scope: params.scope } : {}),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
    webrtcIngested = out.ingested; // real progress this round — preserved for the anchor-fail fallback
    // Suppress the authoritative anchor only when the round did SOMETHING (served us a response, or
    // we served the peer) AND no advertised want remains unfilled.  Re-check after ANY round — a
    // FULL, PARTIAL, push-only, or served-only ingest — keying off what is now HELD (quarantine rows
    // are not promoted on ingest, so the row alone is stale; the peer's push fills wants without
    // surfacing in `out.ingested`).  A PARTIAL WebRTC ingest that leaves some advertised CIDs absent
    // therefore still backs off to the anchor, which can fill the rest, instead of stranding them
    // until a later sync (#BK/#1/#2).
    if (
      (out.ingested !== null || out.served) &&
      !(await requestHasUnfilledWants(params.db, request))
    ) {
      return { transport: 'webrtc', ingested: out.ingested };
    }
  } catch {
    // WebRTC unavailable (off, force-off, unreachable, timeout) — fall back to the anchor.
  } finally {
    // ALWAYS close an established channel — even if the exchange threw — so the live
    // RTCPeerConnection / signaling loop never leaks before the HTTPS fall-back.
    if (channel) {
      try {
        channel.close();
      } catch {
        // already closed
      }
    }
  }

  // If the user CANCELLED while the WebRTC leg was failing, do NOT fall through to the anchor: the
  // HTTPS transport does not thread the AbortSignal into fetch, so a cancelled sync could otherwise
  // still upload the request + push_pack to the server.
  if (params.signal?.aborted) return null;

  // 2) Anchor back-stop: a requester-only exchange against the always-correct server, then INGEST
  //    the served response.  (`offlineExchange` over the server transports preserves anchor-last.)
  const anchor = await offlineExchange(
    buildServerTransports(params.httpsConfig ?? {}),
    request,
    params.signal,
    'public',
  );
  // The anchor leg cannot complete (server offline) — but a PARTIAL WebRTC round may have already
  // committed content this call.  Report that real progress rather than a false failure: `null` is
  // reserved for "EVERY path failed", which is untrue when WebRTC ingested something (#3).
  if (!anchor) {
    return webrtcIngested !== null ? { transport: 'webrtc', ingested: webrtcIngested } : null;
  }
  // The HTTPS transport does not thread the AbortSignal into fetch, so the anchor request can still
  // COMPLETE after a Cancel/unmount fired mid-flight — re-check before COMMITTING its response, so a
  // cancelled sync never mutates the local store after the UI owner is gone (#JJ).
  if (params.signal?.aborted) return null;
  // Room-scoped on the fallback too: the server serves explicit wants by CID with no room scope, so
  // a scoped sync must filter the anchor's response to the allowlisted rooms before commit (#M).  The
  // abort predicate is threaded to the LEAF so a Cancel/unmount DURING readBundleForImport /
  // importBundleObjects suppresses the store write, not just the pre-import check (#BJ).
  const ingested = await ingestClientExchangeResponse(
    params.db,
    anchor.response,
    params.scope,
    () => !(params.signal?.aborted ?? false),
  );
  // The anchor served no usable pack, but WebRTC did make progress this round — report the WebRTC
  // result so the caller sees the real partial success, not an anchor round that moved nothing (#3).
  if (ingested === null && webrtcIngested !== null) {
    return { transport: 'webrtc', ingested: webrtcIngested };
  }
  return { transport: anchor.transport, ingested };
}
