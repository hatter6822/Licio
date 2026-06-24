// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — an always-available, content-free mirror of the configured LCAP
// transports' capabilities (OFFLINE_SPEC §22.6).  The authoritative capability records
// live in `apps/web/src/lcap/transports/*` (`HTTPS_CAPABILITIES`, …), but those modules
// statically import `@licio/lcap` (the codec) so the transport seam can carry a real
// §16 exchange.  This surface-side catalog mirrors only the SUMMARY fields the
// transport-status UI shows (id / server-mediated / carries-private / latency class),
// keeping the always-available surface off the lazy bundle-codec chunk — exactly the
// posture `mode-state`/`trust-labels` keep for the trust badges.  A drift here is a
// review item against the canonical capability records (the test pins the summary).
//
// The HTTPS anchor is ALWAYS present and can never be removed: every fallback chain
// ends with it, so a transport status UI shows it as the non-removable trust anchor.

/** The transport's coarse latency class (mirror of `@licio/lcap` `TransportCapabilities`). */
export type LcapLatencyClass = 'low' | 'medium' | 'high';

/** A content-free summary of one configured transport (mirror of the canonical record). */
export interface TransportSummary {
  /** The transport id (matches the canonical `TransportCapabilities.id`). */
  readonly id: 'https' | 'webtransport' | 'webrtc' | 'courier' | 'qr';
  /** Whether the carrier routes through the Licio server (the trust anchor). */
  readonly serverMediated: boolean;
  /** Whether the carrier may carry private-visibility content. */
  readonly carriesPrivate: boolean;
  /** The coarse latency class. */
  readonly latencyClass: LcapLatencyClass;
  /** The always-present anchor every fallback chain ends with — never removable. */
  readonly anchor: boolean;
  /** Whether this carrier is OPTIONAL (off-by-default, gated by discovery posture). */
  readonly optional: boolean;
}

/**
 * The configured transports, in the §22.6 seam order (optional carriers first, the
 * server anchor last).  Mirrors the canonical capability records; the test pins this.
 */
export const TRANSPORT_CATALOG: readonly TransportSummary[] = [
  {
    id: 'webtransport',
    serverMediated: true,
    carriesPrivate: true,
    latencyClass: 'low',
    anchor: false,
    optional: true,
  },
  {
    id: 'webrtc',
    serverMediated: false,
    carriesPrivate: false,
    latencyClass: 'low',
    anchor: false,
    optional: true,
  },
  {
    id: 'courier',
    serverMediated: false,
    carriesPrivate: false,
    latencyClass: 'high',
    anchor: false,
    optional: true,
  },
  {
    id: 'qr',
    serverMediated: false,
    carriesPrivate: false,
    latencyClass: 'high',
    anchor: false,
    optional: true,
  },
  {
    id: 'https',
    serverMediated: true,
    carriesPrivate: true,
    latencyClass: 'medium',
    anchor: true,
    optional: false,
  },
];
