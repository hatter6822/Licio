// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WebRTC NAT-traversal + connection-privacy policy (OFFLINE_SPEC §22.6, §26.4, §33.5,
// WS-R.15.6b).  PURE decision logic the transport reads before connecting:
//   - STUN-first NAT discovery (client-side only); optional self-hosted TURN, OFF by
//     default;
//   - a "relay-only ICE" option that forces all traffic through TURN so the peer never
//     sees the user's IP (`iceTransportPolicy: 'relay'`), at a latency/throughput cost;
//   - a clear disclosure that a DIRECT connection exposes peer IPs to the other party
//     (via ICE candidates) — the UI must show it before connecting;
//   - FORCE-OFF in Stealth / Emergency (no direct peer connection reveals an address).
//
// No peer IP / ICE candidate is ever produced here or written anywhere — these are a
// live-connection property only (the §19.1 / `check:lcap-schema-egress` doctrine).

/** The operational posture that gates WebRTC (mirrors the §33 modes). */
export type WebrtcMode = 'standard' | 'courier' | 'relay' | 'stealth' | 'emergency';

export interface IceServerConfig {
  readonly urls: string;
  readonly username?: string;
  readonly credential?: string;
}

export interface WebrtcPrivacyOptions {
  readonly mode: WebrtcMode;
  /** The user explicitly opted into WebRTC (it is off by default). */
  readonly userEnabled: boolean;
  /** Hide my IP: force all media through TURN (no direct candidate). */
  readonly relayOnlyIce?: boolean;
  /** Self-hosted TURN servers (empty ⇒ STUN-only; relay-only requires at least one). */
  readonly turnServers?: readonly IceServerConfig[];
  /** Public STUN servers for client-side NAT discovery. */
  readonly stunServers?: readonly string[];
}

export interface WebrtcDecision {
  /** Whether a WebRTC connection may be attempted at all. */
  readonly allowed: boolean;
  /** Why it is disallowed (for an honest UI message); empty when allowed. */
  readonly blockedReason: '' | 'off_by_default' | 'forced_off_in_mode' | 'relay_without_turn';
  /** The ICE servers to configure. */
  readonly iceServers: readonly IceServerConfig[];
  /** `'relay'` hides the IP via TURN; `'all'` permits direct (IP-exposing) candidates. */
  readonly iceTransportPolicy: 'all' | 'relay';
  /** True when a direct connection will expose peer IPs (the disclosure precondition). */
  readonly exposesPeerIp: boolean;
}

const DEFAULT_STUN = ['stun:stun.l.google.com:19302'];

/** Stealth + Emergency force WebRTC entirely off (no address-revealing direct channel). */
function modeForcesOff(mode: WebrtcMode): boolean {
  return mode === 'stealth' || mode === 'emergency';
}

/**
 * Decide whether/how to open a WebRTC connection under the privacy options.  Off by
 * default; forced off in Stealth/Emergency; relay-only requires a TURN server (else it
 * cannot honor the hide-my-IP request and is refused rather than silently exposing the
 * IP).  A direct (non-relay) connection always sets `exposesPeerIp` so the UI discloses
 * it before connecting.
 */
export function decideWebrtc(options: WebrtcPrivacyOptions): WebrtcDecision {
  const stun: IceServerConfig[] = (options.stunServers ?? DEFAULT_STUN).map((urls) => ({ urls }));
  const turn = options.turnServers ?? [];
  const iceServers = [...stun, ...turn];

  if (!options.userEnabled) {
    return blocked('off_by_default', iceServers);
  }
  if (modeForcesOff(options.mode)) {
    return blocked('forced_off_in_mode', iceServers);
  }
  if (options.relayOnlyIce && turn.length === 0) {
    // The user asked to hide their IP but provided no TURN — refuse rather than leak it.
    return blocked('relay_without_turn', iceServers);
  }

  const relay = options.relayOnlyIce === true;
  return {
    allowed: true,
    blockedReason: '',
    iceServers,
    iceTransportPolicy: relay ? 'relay' : 'all',
    // Relay-only routes through TURN, so the peer sees the TURN address, not the user's.
    exposesPeerIp: !relay,
  };
}

function blocked(
  reason: Exclude<WebrtcDecision['blockedReason'], ''>,
  iceServers: readonly IceServerConfig[],
): WebrtcDecision {
  return {
    allowed: false,
    blockedReason: reason,
    iceServers,
    iceTransportPolicy: 'relay',
    exposesPeerIp: false,
  };
}
