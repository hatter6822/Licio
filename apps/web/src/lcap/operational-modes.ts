// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — the §33 operational modes.  One user-selectable mode drives the whole
// client posture: the §21.3 storage policy (the WS-R.11.2 `StorageMode`), the highest
// priority class admitted, whether media is fetched at all, the discovery/advertising/
// background-sync channels, and the export posture (generic filenames, confirm-before-
// export, the Emergency one-tap public-thread export).  Six modes:
//
//   - Minimal   — C0+T1, no media prefetch, aggressive GC.
//   - Standard  — C0+T1+selected E2, thumbnails, saved/subscribed snapshots.
//   - Courier   — opt-in public replication, larger cache (battery/storage warnings).
//   - Relay     — operator-controlled (the WS-R.15.3 relay posture).
//   - Stealth   — no auto discovery/advertising/background sync, manual-only, generic
//                 filenames, small cache, clear trust warnings (aligns with the
//                 WS-R.14.2 §26.3 stealth policy in @licio/lcap).
//   - Emergency — text/control only, ALL media off, P0/P1 only, one-tap export of a
//                 selected public emergency thread.
//
// The stealth flag values mirror @licio/lcap's `STEALTH_ON` (apps/web does not depend
// on @licio/lcap — the WS-R.11 bundle-leanness pattern); the per-mode test pins them.

import { STORAGE_MODES, type StorageMode, type StorageModeConfig } from './storage-modes.js';

export type OperationalMode =
  | 'minimal'
  | 'standard'
  | 'courier'
  | 'relay'
  | 'stealth'
  | 'emergency';

/** The §21.1 priority class (P0..P4); LOWER number = more essential (C0 = P0). */
export type LcapPriorityClass = 0 | 1 | 2 | 3 | 4;

export interface OperationalModeConfig {
  readonly mode: OperationalMode;
  /** The §21.3 storage policy this mode applies (WS-R.11.2). */
  readonly storageMode: StorageMode;
  /** The highest (numerically largest) priority class admitted; P0/P1 → `1`, all → `4`. */
  readonly maxPriority: LcapPriorityClass;
  /** Whether media is fetched at all (Emergency + Minimal + Stealth: never). */
  readonly mediaAllowed: boolean;
  /** Automatic local peer discovery (off in Stealth/Emergency). */
  readonly autoDiscovery: boolean;
  /** Advertising held content to couriers/relays (off in Stealth/Emergency). */
  readonly courierAdvertising: boolean;
  /** Background (non-user-initiated) sync (off in Stealth/Emergency). */
  readonly backgroundSync: boolean;
  /** Shrink the exchange budget to the C0+T1 minimum (the WS-R.6.2 `minimal_mode`). */
  readonly minimalBudget: boolean;
  /** Use a generic, room/topic-free export filename (Stealth/Emergency). */
  readonly genericFilenames: boolean;
  /** Require explicit confirmation before any export (Stealth/Emergency). */
  readonly confirmBeforeExport: boolean;
  /** Emergency: offer a one-tap export of a selected PUBLIC emergency thread. */
  readonly emergencyOneTapExport: boolean;
  /** A high-risk mode that must show a clear trust warning in the UI. */
  readonly showTrustWarning: boolean;
}

/** The six §33 operational modes. */
export const OPERATIONAL_MODES: Readonly<Record<OperationalMode, OperationalModeConfig>> = {
  minimal: {
    mode: 'minimal',
    storageMode: 'minimal',
    maxPriority: 1, // C0 + T1
    mediaAllowed: false,
    autoDiscovery: true,
    courierAdvertising: false,
    backgroundSync: true,
    minimalBudget: true,
    genericFilenames: false,
    confirmBeforeExport: false,
    emergencyOneTapExport: false,
    showTrustWarning: false,
  },
  standard: {
    mode: 'standard',
    storageMode: 'standard',
    maxPriority: 2, // C0 + T1 + selected E2
    mediaAllowed: false, // thumbnails only (a prefetch policy, not full media)
    autoDiscovery: true,
    courierAdvertising: false,
    backgroundSync: true,
    minimalBudget: false,
    genericFilenames: false,
    confirmBeforeExport: false,
    emergencyOneTapExport: false,
    showTrustWarning: false,
  },
  courier: {
    mode: 'courier',
    storageMode: 'courier',
    maxPriority: 4, // all lanes (opt-in public replication)
    mediaAllowed: true,
    autoDiscovery: true,
    courierAdvertising: true,
    backgroundSync: true,
    minimalBudget: false,
    genericFilenames: false,
    confirmBeforeExport: false,
    emergencyOneTapExport: false,
    showTrustWarning: true, // battery/storage + replication warnings
  },
  relay: {
    mode: 'relay',
    storageMode: 'relay',
    maxPriority: 4,
    mediaAllowed: true,
    autoDiscovery: true,
    courierAdvertising: true,
    backgroundSync: true,
    minimalBudget: false,
    genericFilenames: false,
    confirmBeforeExport: false,
    emergencyOneTapExport: false,
    showTrustWarning: true,
  },
  stealth: {
    mode: 'stealth',
    storageMode: 'stealth',
    maxPriority: 1, // C0 + T1
    mediaAllowed: false,
    autoDiscovery: false, // §26.3: no automatic reveal channels
    courierAdvertising: false,
    backgroundSync: false,
    minimalBudget: true,
    genericFilenames: true,
    confirmBeforeExport: true,
    emergencyOneTapExport: false,
    showTrustWarning: true,
  },
  emergency: {
    mode: 'emergency',
    storageMode: 'minimal', // small, text-only cache
    maxPriority: 1, // P0/P1 only
    mediaAllowed: false, // ALL media off
    autoDiscovery: false,
    courierAdvertising: false,
    backgroundSync: false,
    minimalBudget: true,
    genericFilenames: true,
    confirmBeforeExport: true,
    emergencyOneTapExport: true,
    showTrustWarning: true,
  },
};

/** Every operational-mode key (the selector + completeness pin). */
export const OPERATIONAL_MODE_KEYS = Object.keys(OPERATIONAL_MODES) as readonly OperationalMode[];

/** The config for a mode. */
export function operationalMode(mode: OperationalMode): OperationalModeConfig {
  return OPERATIONAL_MODES[mode];
}

/** The §21.3 storage config a mode applies. */
export function storageConfigForMode(mode: OperationalMode): StorageModeConfig {
  return STORAGE_MODES[OPERATIONAL_MODES[mode].storageMode];
}

/** Whether a mode admits content of priority class `priority` (P0 = most essential). */
export function admitsPriority(
  config: OperationalModeConfig,
  priority: LcapPriorityClass,
): boolean {
  return priority <= config.maxPriority;
}

/** Whether a sync/advertise channel is permitted under the mode (user action always is). */
export function modeAllowsChannel(
  config: OperationalModeConfig,
  channel: 'discovery' | 'advertise' | 'background_sync' | 'user_initiated',
): boolean {
  switch (channel) {
    case 'user_initiated':
      return true; // a mode restricts AUTOMATIC reveal, never the user's own action
    case 'discovery':
      return config.autoDiscovery;
    case 'advertise':
      return config.courierAdvertising;
    case 'background_sync':
      return config.backgroundSync;
  }
}
