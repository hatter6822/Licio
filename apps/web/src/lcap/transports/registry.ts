// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The client transport registry (OFFLINE_SPEC §22.6, WS-R.15.5/15.6) — assembles the
// available LcapTransports and runs ONE §16 exchange over them via the seam's
// `fallbackExchange`, which always ends with the server anchor so correctness never
// depends on an optional transport.  The optional peer transport (WebRTC) lives in the
// code-split `@licio/lcap-p2p` package and is loaded with a DYNAMIC import — so the
// protocol-heavy P2P code never enters the initial bundle (the WS-R.15.8 budget gate
// asserts apps/web carries NO static `@licio/lcap-p2p` import).

import type { LcapTransport, PackHeaderV2, TransportId } from '@licio/lcap';
import { DEFAULT_TRANSPORT_PREFERENCE, fallbackExchange } from '@licio/lcap';
import { HttpsTransport, type HttpsTransportConfig } from './https.js';
import {
  isWebTransportSupported,
  type WebTransportLike,
  WebTransportTransport,
} from './webtransport.js';

export interface TransportRegistryConfig extends HttpsTransportConfig {
  /** A live WebTransport session, when one has been established (the low-latency path). */
  readonly webTransportSession?: WebTransportLike;
}

/**
 * Build the server-mediated transport set: the HTTPS anchor always, plus WebTransport
 * when the platform supports it AND a session is provided.  Peer transports (WebRTC,
 * courier) are appended by the caller from their own (possibly lazily-loaded) sources.
 */
export function buildServerTransports(config: TransportRegistryConfig = {}): LcapTransport[] {
  const transports: LcapTransport[] = [new HttpsTransport(config)];
  if (config.webTransportSession && isWebTransportSupported()) {
    transports.push(new WebTransportTransport(config.webTransportSession));
  }
  return transports;
}

/**
 * Lazily load the WebRTC transport from the code-split `@licio/lcap-p2p` chunk over an
 * established data channel.  The dynamic import keeps the P2P protocol code out of the
 * initial bundle; `channel` is typed structurally to avoid a static type-import edge.
 */
export async function loadWebrtcTransport(channel: {
  readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: Uint8Array): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}): Promise<LcapTransport> {
  const { WebrtcTransport } = await import('@licio/lcap-p2p');
  return new WebrtcTransport(channel);
}

/**
 * Run one exchange over the available transports, in seam order (optional carriers
 * first, the server anchor last).  Returns which transport carried it + the response,
 * or `null` if every transport failed (offline with no reachable peer or server).
 *
 * When `privacyLabel` is supplied, the seam's carriage gate SKIPS any public-only
 * transport (every peer carrier, e.g. WebRTC) for a non-`public` pack — so `in_room`/
 * private bytes are never tried on a peer channel before the server anchor (§21.4/§26.4).
 * Omit it for a public request (any transport may carry it).
 */
export async function offlineExchange(
  transports: readonly LcapTransport[],
  requestMessage: Uint8Array,
  signal?: AbortSignal,
  privacyLabel?: PackHeaderV2['privacy_label'],
): Promise<{ transport: TransportId; response: Uint8Array } | null> {
  return fallbackExchange(
    transports,
    requestMessage,
    DEFAULT_TRANSPORT_PREFERENCE,
    signal,
    privacyLabel,
  );
}
