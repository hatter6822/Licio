// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Live LCAP WebRTC carrier assembly (WS-R.15.6a) — the apps/web glue that turns the
// code-split `connectWebrtc` establishment + the server-blind signaling client into a
// ready `LcapTransport`.  `@licio/lcap-p2p` (WebRTC + the signaling envelope) is loaded
// by DYNAMIC import only, so the P2P core stays out of the initial bundle
// (`check:lcap-p2p-split`).  The result is appended to the registry's transport set
// AHEAD of the server anchor; the seam still falls back to HTTPS if the channel fails.

import type { LcapTransport } from '@licio/lcap';
import type {
  DataChannelLike,
  RtcPeerConnectionFactory,
  WebrtcDecision,
  WebrtcPrivacyOptions,
} from '@licio/lcap-p2p';
import { createSignalClient } from './p2p-signaling.js';

export interface ConnectLcapWebrtcParams {
  /** The 32-byte shared signaling secret both members hold out of band (WS-S supplies it). */
  readonly signalKeyBytes: Uint8Array;
  /** The opaque room rendezvous hash (never a real room id). */
  readonly roomIdHash: Uint8Array;
  readonly selfPeerKey: string;
  readonly remotePeerKey: string;
  readonly initiator: boolean;
  /** A precomputed §26.4 decision, OR the privacy options to derive one from. */
  readonly decision?: WebrtcDecision;
  readonly privacy?: WebrtcPrivacyOptions;
  /** API origin for the signaling rendezvous (default same-origin). */
  readonly apiBase?: string;
  /** Injectable fetch (tests). */
  readonly fetchFn?: typeof fetch;
  /** Injectable RTCPeerConnection constructor (tests/E2E). */
  readonly rtcFactory?: RtcPeerConnectionFactory;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Establish a live WebRTC `LcapTransport` to a peer via the server-blind signaling
 * rendezvous.  Rejects (so the registry falls back to the anchor) if WebRTC is
 * disallowed by the §26.4 decision or the channel never opens.
 */
export async function connectLcapWebrtcChannel(
  params: ConnectLcapWebrtcParams,
): Promise<DataChannelLike> {
  const p2p = await import('@licio/lcap-p2p');
  const decision =
    params.decision ?? p2p.decideWebrtc(params.privacy ?? { mode: 'standard', userEnabled: true });
  const signalKey = await p2p.importSignalKey(params.signalKeyBytes);
  const { postSignal, pollSignal } = createSignalClient({
    ...(params.apiBase !== undefined ? { apiBase: params.apiBase } : {}),
    ...(params.fetchFn !== undefined ? { fetchFn: params.fetchFn } : {}),
  });
  return p2p.connectWebrtc({
    decision,
    signalKey,
    roomIdHash: params.roomIdHash,
    selfPeerKey: params.selfPeerKey,
    remotePeerKey: params.remotePeerKey,
    initiator: params.initiator,
    postSignal,
    pollSignal,
    ...(params.rtcFactory !== undefined ? { rtcFactory: params.rtcFactory } : {}),
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
    ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  });
}

/** Establish a live WebRTC `LcapTransport` (the requester-only wrapper over the raw channel —
 *  used by the anchor-fallback path; the bidirectional driver uses the raw channel directly). */
export async function connectLcapWebrtc(params: ConnectLcapWebrtcParams): Promise<LcapTransport> {
  const p2p = await import('@licio/lcap-p2p');
  const channel = await connectLcapWebrtcChannel(params);
  return new p2p.WebrtcTransport(channel);
}
