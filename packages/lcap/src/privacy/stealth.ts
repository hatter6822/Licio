// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stealth mode (OFFLINE_SPEC §26.3, WS-R.14.2) — the PURE policy a high-risk user
// enables to minimize what their device reveals.  In stealth: automatic local
// discovery, courier advertising, and background relay sync are OFF; exports use a
// generic (room/topic-free) filename and require explicit confirmation; only C0
// (control) material moves unless the user initiates an exchange; and the cache is
// kept minimal.  This is the decision policy; the client surface (WS-R.17) reads it
// to gate discovery/advertising/sync and to name export files.  I/O-free.

/** The §26.3 stealth decision policy — every automatic-reveal channel is a flag. */
export interface StealthPolicy {
  /** Automatic local peer discovery (BLE/mDNS/etc.). */
  readonly localDiscovery: boolean;
  /** Advertising held content to couriers/relays. */
  readonly courierAdvertising: boolean;
  /** Background (non-user-initiated) relay sync. */
  readonly backgroundRelaySync: boolean;
  /** Use a generic, room/topic-free export filename (WS-R.4.4). */
  readonly genericFilenames: boolean;
  /** Move only C0 control material unless the user initiates an exchange. */
  readonly c0OnlyUnlessUserInitiated: boolean;
  /** Require explicit confirmation before any export. */
  readonly confirmBeforeExport: boolean;
  /** Keep the local cache minimal (evict aggressively). */
  readonly minimalCache: boolean;
}

/** Stealth ENABLED — every automatic-reveal channel disabled, exports locked down. */
export const STEALTH_ON: StealthPolicy = Object.freeze({
  localDiscovery: false,
  courierAdvertising: false,
  backgroundRelaySync: false,
  genericFilenames: true,
  c0OnlyUnlessUserInitiated: true,
  confirmBeforeExport: true,
  minimalCache: true,
});

/** Stealth DISABLED — the ordinary posture (discovery/advertising/background sync on). */
export const STEALTH_OFF: StealthPolicy = Object.freeze({
  localDiscovery: true,
  courierAdvertising: true,
  backgroundRelaySync: true,
  genericFilenames: false,
  c0OnlyUnlessUserInitiated: false,
  confirmBeforeExport: false,
  minimalCache: false,
});

/** The stealth policy for an on/off toggle. */
export function stealthPolicy(enabled: boolean): StealthPolicy {
  return enabled ? STEALTH_ON : STEALTH_OFF;
}

/** A sync/advertise channel a stealth policy may gate. */
export type SyncChannel =
  | 'local_discovery'
  | 'courier_advertise'
  | 'background_sync'
  | 'user_initiated';

/**
 * Whether a channel is permitted under `policy`.  A user-initiated exchange is ALWAYS
 * permitted (stealth restricts AUTOMATIC reveal, never the user's own action); the
 * three automatic channels follow their flags.
 */
export function stealthAllows(policy: StealthPolicy, channel: SyncChannel): boolean {
  switch (channel) {
    case 'user_initiated':
      return true;
    case 'local_discovery':
      return policy.localDiscovery;
    case 'courier_advertise':
      return policy.courierAdvertising;
    case 'background_sync':
      return policy.backgroundRelaySync;
  }
}

/**
 * A generic, room/topic-free export filename (§26.3, WS-R.4.4): it leaks neither the
 * room nor the topic.  `atMs` is folded in only as a coarse day stamp so repeated
 * exports do not collide, never a precise timestamp.
 */
export function genericExportFilename(atMs: number): string {
  const day = Math.floor(atMs / 86_400_000); // whole-day granularity only
  return `licio-bundle-${day}.licio-bundle`;
}
