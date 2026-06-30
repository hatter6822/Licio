// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The transport seam (OFFLINE_SPEC §22.6, WS-R.15.4b) — the single byte-channel
// abstraction every concrete LCAP transport (HTTPS, WebTransport, WebRTC, courier,
// IPFS bridge, QR) implements, so the §16 exchange protocol, the scheduler order, and
// `validate` are reused unchanged across all of them.  This module is PURE: it owns
// the interface + the selection/fallback policy + a transport-agnostic exchange-round
// driver.  The I/O implementations live with their runtime (apps/web, @licio/lcap-p2p,
// apps/courier).
//
// Two doctrines are encoded here structurally:
//   - HTTPS is the always-correct LAST RESORT: `selectTransports` ALWAYS ends the
//     order with a server-mediated transport when one is available, so correctness
//     never depends on an optional transport (§22.6).
//   - a public-only transport STRUCTURALLY refuses non-public packs: `transportMayCarry`
//     gates an `in_room`/`private`/ciphertext pack off any `carriesPrivate: false`
//     transport (§21.4, §26.4) — the default for every peer/public channel.

import type { PackHeaderV2 } from '../schemas/pack.js';

/** The transports a v0.2 node may speak (the §22 transport family). */
export type TransportId = 'https' | 'webtransport' | 'webrtc' | 'courier' | 'ipfs_bridge' | 'qr';

export interface TransportCapabilities {
  readonly id: TransportId;
  /** Both send + receive within one session (QR/IPFS are one-directional per call). */
  readonly bidirectional: boolean;
  /** Talks to the Licio server (the correctness anchor) vs. a peer/public network. */
  readonly serverMediated: boolean;
  /** May carry `in_room`/`private`/ciphertext packs at all (default false; §21.4/§26.4). */
  readonly carriesPrivate: boolean;
  /** A soft per-exchange byte ceiling the scheduler/budget honor. */
  readonly maxExchangeBytes: number;
  readonly latencyClass: 'low' | 'medium' | 'high';
}

/** A transport failure the fallback chain treats as "try the next transport". */
export class TransportUnavailableError extends Error {
  override readonly name = 'TransportUnavailableError';
  readonly transport: TransportId;
  constructor(transport: TransportId, message?: string) {
    super(message ?? `transport ${transport} is unavailable`);
    this.transport = transport;
  }
}

/**
 * The byte-channel an exchange rides.  An exchange sends one request message and
 * receives one response message (both are encoded §16 exchange bodies); a transport
 * never interprets the bytes — it only moves them.
 */
export interface LcapTransport {
  readonly capabilities: TransportCapabilities;
  /** Open/connect/handshake; rejects with {@link TransportUnavailableError} if it cannot. */
  open(signal?: AbortSignal): Promise<void>;
  /** Send one encoded message. */
  send(message: Uint8Array): Promise<void>;
  /** Receive the next encoded message, or `null` when the peer has closed. */
  receive(signal?: AbortSignal): Promise<Uint8Array | null>;
  /** Close the channel (idempotent). */
  close(): Promise<void>;
}

/**
 * Whether `caps` may carry a pack with `label`.  ONLY an explicitly `'public'` label rides a
 * public-only transport; EVERY other value — a non-public label
 * (`contains_in_room_metadata`/`contains_private_encrypted`/`manual_user_selected`) AND an
 * OMITTED/`undefined` label — requires a `carriesPrivate` transport.  Failing closed on an absent
 * label (PUB-SEAM-1) means a caller that forgets to label a non-public pack cannot accidentally leak
 * it onto a peer/public channel; the price is only that an unlabeled PUBLIC pack rides the
 * (`carriesPrivate: true`) server anchor instead of a peer transport.
 */
export function transportMayCarry(
  caps: TransportCapabilities,
  label: PackHeaderV2['privacy_label'] | undefined,
): boolean {
  return label === 'public' ? true : caps.carriesPrivate;
}

/**
 * The default preference order.  Lower-latency optional transports lead; a
 * server-mediated transport (HTTPS) is the correctness anchor and is forced LAST so
 * the chain always has a correct terminal step (§22.6).
 */
export const DEFAULT_TRANSPORT_PREFERENCE: readonly TransportId[] = [
  'webtransport',
  'webrtc',
  'courier',
  'ipfs_bridge',
  'https',
];

/**
 * Order the available transports by `preference`, then move every server-mediated
 * transport to the END (the always-correct last resort) while preserving their
 * relative order.  Unknown ids keep their given order, ahead of the server anchor.
 */
export function selectTransports(
  available: readonly LcapTransport[],
  preference: readonly TransportId[] = DEFAULT_TRANSPORT_PREFERENCE,
): readonly LcapTransport[] {
  const rank = new Map(preference.map((id, index) => [id, index] as const));
  const ordered = [...available].sort((a, b) => {
    const ra = rank.get(a.capabilities.id) ?? preference.length;
    const rb = rank.get(b.capabilities.id) ?? preference.length;
    return ra - rb;
  });
  // Stable-partition: optional transports first, server-mediated anchors last.
  const optional = ordered.filter((t) => !t.capabilities.serverMediated);
  const anchors = ordered.filter((t) => t.capabilities.serverMediated);
  return [...optional, ...anchors];
}

/**
 * Run one exchange round over `transport`: open → send the request → receive the
 * response → close (always).  Returns the response bytes, or `null` if the peer
 * closed without responding.
 */
export async function runExchangeRound(
  transport: LcapTransport,
  requestMessage: Uint8Array,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  // A throwing `open()` releases its OWN resources (nothing is held yet), so it stays outside the
  // try — only a SUCCESSFULLY-opened transport must be closed.
  await transport.open(signal);
  try {
    // The caller may have aborted between open() and here; bail before sending so a just-opened
    // transport is not used for a cancelled exchange (the `finally` still closes it) (PUB-SEAM-2).
    if (signal?.aborted) throw new TransportUnavailableError(transport.capabilities.id, 'aborted');
    await transport.send(requestMessage);
    return await transport.receive(signal);
  } finally {
    // A `close()` rejection must NEVER convert an already-received response into a fall-through (a
    // double-ingest / re-upload upstream): swallow it (PUB-SEAM-3).
    try {
      await transport.close();
    } catch {
      /* close is best-effort cleanup; the response above is already captured */
    }
  }
}

/**
 * Try each transport in `selectTransports` order until one returns a response; a
 * {@link TransportUnavailableError} (or any failure) falls through to the next.  The
 * result records which transport succeeded.  Because the order always ends with the
 * server anchor (when present), a reachable server guarantees a correct outcome.
 *
 * The caller passes the request's `privacyLabel`: a transport that cannot carry it
 * (`carriesPrivate: false` — every peer/public carrier) is SKIPPED, so `in_room`/private bytes are
 * never tried on a public-only peer transport before falling back to the server anchor (§21.4/§26.4).
 * ALWAYS pass the label — an OMITTED label is treated as NON-PUBLIC and fails closed (PUB-SEAM-1), so
 * only an explicit `'public'` rides a peer transport.
 */
export async function fallbackExchange(
  transports: readonly LcapTransport[],
  requestMessage: Uint8Array,
  preference: readonly TransportId[] = DEFAULT_TRANSPORT_PREFERENCE,
  signal?: AbortSignal,
  privacyLabel?: PackHeaderV2['privacy_label'],
): Promise<{ transport: TransportId; response: Uint8Array } | null> {
  for (const transport of selectTransports(transports, preference)) {
    if (signal?.aborted) break; // the caller cancelled — stop trying transports (PUB-SEAM-2)
    // The carriage gate, BEFORE any bytes are sent on this transport.  Fails CLOSED on an omitted
    // label (a non-public pack can never ride a public-only transport, even unlabeled).
    if (!transportMayCarry(transport.capabilities, privacyLabel)) continue;
    try {
      const response = await runExchangeRound(transport, requestMessage, signal);
      if (response !== null) return { transport: transport.capabilities.id, response };
    } catch {
      // Try the next transport; correctness is preserved by the server anchor at the end.
    }
  }
  return null;
}
