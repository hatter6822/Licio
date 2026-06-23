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

import type { LcapTransport, PackHeaderV2, TransportId } from '@licio/lcap';
import type { WebrtcDecision, WebrtcPrivacyOptions } from '@licio/lcap-p2p';
import { type ConnectLcapWebrtcParams, connectLcapWebrtc } from './connect-webrtc.js';
import type { HttpsTransportConfig } from './https.js';
import { buildServerTransports, offlineExchange } from './registry.js';
import { derivePublicSignalKeyBytes } from './signal-key.js';

export interface SyncRoomOverP2pParams {
  /** The PUBLIC room rendezvous hash (an opaque one-way hash; never a real room id). */
  readonly roomIdHash: Uint8Array;
  /** This device's opaque peer key (a device-key hash; never an IP, §19.1). */
  readonly selfPeerKey: string;
  /** The remote device's opaque peer key. */
  readonly remotePeerKey: string;
  /** The initiator creates the offer + data channel; the responder answers. */
  readonly initiator: boolean;
  /** The encoded §16 exchange request body (a PUBLIC pack) to send. */
  readonly requestMessage: Uint8Array;
  /**
   * The request pack's privacy label.  This consumer is the PUBLIC path, so it must be
   * `'public'`; the carriage gate would in any case skip the public-only WebRTC transport
   * for a non-public pack.  Defaults to `'public'`.
   */
  readonly privacyLabel?: PackHeaderV2['privacy_label'];
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
  /** The peer's §16 exchange response body. */
  readonly response: Uint8Array;
}

/**
 * Drive one live §16 exchange for a PUBLIC room, preferring the WebRTC peer transport but
 * always ending the fallback at the HTTPS anchor.  Returns the carrying transport + the
 * response, or `null` if every transport failed (offline with no reachable peer or
 * server).  The WebRTC channel, when established, is closed by `offlineExchange`'s
 * exchange round (`runExchangeRound` always closes the transport).
 */
export async function syncRoomOverP2p(
  params: SyncRoomOverP2pParams,
): Promise<SyncRoomOverP2pResult | null> {
  const privacyLabel = params.privacyLabel ?? 'public';

  // The always-correct anchor is always present; the optional WebRTC peer transport is
  // prepended when it can be established.
  const transports: LcapTransport[] = [];

  let webrtc: LcapTransport | null = null;
  try {
    // Public content: derive the shared signaling key from the public room hash so any
    // public peer can join the rendezvous (signaling secrecy is not the trust root here).
    const signalKeyBytes = await derivePublicSignalKeyBytes(params.roomIdHash);
    webrtc = await connectLcapWebrtc({
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
  } catch {
    // WebRTC unavailable (off, force-off, unreachable, timeout) — fall back to the anchor.
    webrtc = null;
  }
  if (webrtc) transports.push(webrtc);

  // The HTTPS anchor is appended LAST in the registry set; `selectTransports` (inside
  // `offlineExchange`) re-asserts that server-mediated transports terminate the order, so
  // even though we prepend WebRTC the anchor-last policy is structurally preserved.
  for (const t of buildServerTransports(params.httpsConfig ?? {})) transports.push(t);

  return offlineExchange(transports, params.requestMessage, params.signal, privacyLabel);
}
