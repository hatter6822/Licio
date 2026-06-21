// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.2 — LCAP storage modes + persistent-storage request + honest
// storage-pressure handling (OFFLINE_SPEC §21.3).  Each mode sets a budget and a
// prefetch policy; under storage pressure the client degrades to C0/T1 (control +
// text) and PAUSES media prefetch, and the pressure is reported honestly rather than
// hidden.  Stealth disables automatic local discovery/export hints (§21.4).  The
// per-transaction cap + the quota-retry that consume these live in the durability
// layer (store.ts, WS-R.11.3b); this module owns the mode POLICY.

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Pressure (usage/quota) at/above which the client degrades to C0/T1. */
export const PRESSURE_DEGRADE_THRESHOLD = 0.85;

export type StorageMode = 'minimal' | 'standard' | 'courier' | 'relay' | 'stealth';

/** Which content tiers a mode prefetches (§21.1 priorities → tiers). */
export interface PrefetchPolicy {
  readonly text: boolean; // P1 text + control
  readonly evidence: boolean; // P2 evidence/context
  readonly thumbnails: boolean; // P2 thumbnails
  readonly media: boolean; // P3 media
  readonly publicReplication: boolean; // courier opt-in public replication
}

export interface StorageModeConfig {
  readonly mode: StorageMode;
  readonly minBytes: number;
  readonly maxBytes: number;
  readonly prefetch: PrefetchPolicy;
  /** Stealth disables automatic local discovery hints (§21.4). */
  readonly localDiscoveryHints: boolean;
  /** Stealth disables automatic export hints (§21.4). */
  readonly exportHints: boolean;
}

/** Degraded prefetch (C0/T1 only): control + text, no evidence/thumbnails/media. */
const TEXT_ONLY: PrefetchPolicy = {
  text: true,
  evidence: false,
  thumbnails: false,
  media: false,
  publicReplication: false,
};

/** The §21.3 storage modes (suggested defaults). */
export const STORAGE_MODES: Record<StorageMode, StorageModeConfig> = {
  minimal: {
    mode: 'minimal',
    minBytes: 25 * MB,
    maxBytes: 50 * MB,
    prefetch: TEXT_ONLY, // text/control only, no media prefetch
    localDiscoveryHints: true,
    exportHints: true,
  },
  standard: {
    mode: 'standard',
    minBytes: 100 * MB,
    maxBytes: 250 * MB,
    prefetch: {
      text: true,
      evidence: true,
      thumbnails: true,
      media: false,
      publicReplication: false,
    },
    localDiscoveryHints: true,
    exportHints: true,
  },
  courier: {
    mode: 'courier',
    minBytes: 500 * MB,
    maxBytes: 2 * GB,
    prefetch: {
      text: true,
      evidence: true,
      thumbnails: true,
      media: true,
      publicReplication: true, // explicit opt-in public replication
    },
    localDiscoveryHints: true,
    exportHints: true,
  },
  relay: {
    mode: 'relay',
    minBytes: 0,
    maxBytes: 10 * GB, // operator-configured; see `relayMode()` to override
    prefetch: {
      text: true,
      evidence: true,
      thumbnails: true,
      media: true,
      publicReplication: true,
    },
    localDiscoveryHints: true,
    exportHints: true,
  },
  stealth: {
    mode: 'stealth',
    minBytes: 0,
    maxBytes: 25 * MB, // smallest practical cache
    prefetch: TEXT_ONLY,
    localDiscoveryHints: false, // no automatic local discovery hints (§21.4)
    exportHints: false, // no automatic export hints (§21.4)
  },
};

/** A Relay mode with an operator-configured byte budget. */
export function relayMode(maxBytes: number): StorageModeConfig {
  return { ...STORAGE_MODES.relay, maxBytes };
}

/** Pressure ratio (usage/quota), clamped to [0, 1]; 0 when the quota is unknown. */
export function storagePressure(usage: number, quota: number): number {
  if (quota <= 0) return 0;
  return Math.min(1, Math.max(0, usage / quota));
}

/**
 * The EFFECTIVE prefetch policy for a mode at the given pressure.  At/above the
 * degrade threshold the client drops to C0/T1 (control + text) and pauses media,
 * evidence, and thumbnail prefetch — regardless of the configured mode.
 */
export function effectivePrefetch(
  config: StorageModeConfig,
  pressureRatio: number,
): PrefetchPolicy {
  return pressureRatio >= PRESSURE_DEGRADE_THRESHOLD ? TEXT_ONLY : config.prefetch;
}

/** Whether the usage exceeds the mode's budget cap. */
export function isOverBudget(config: StorageModeConfig, usage: number): boolean {
  return usage > config.maxBytes;
}

// --- Browser storage-manager glue (thin, defensive). -----------------------------

function storageManager(): StorageManager | undefined {
  return globalThis.navigator?.storage;
}

/** Request persistent storage where supported; `false` otherwise (never throws). */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = storageManager();
  if (!storage?.persist) return false;
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}

/** Whether storage is already persisted (best-effort; `false` if unsupported). */
export async function isStoragePersisted(): Promise<boolean> {
  const storage = storageManager();
  if (!storage?.persisted) return false;
  try {
    return await storage.persisted();
  } catch {
    return false;
  }
}

/** Estimated usage + quota, or `undefined` when the API is unavailable. */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | undefined> {
  const storage = storageManager();
  if (!storage?.estimate) return undefined;
  try {
    const estimate = await storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return undefined;
  }
}

/** An honest snapshot of storage state for a mode (pressure shown, not hidden). */
export interface StorageStatus {
  readonly mode: StorageMode;
  readonly usage: number;
  readonly quota: number;
  readonly pressureRatio: number;
  readonly overBudget: boolean;
  readonly persisted: boolean;
  /** The effective prefetch policy after any pressure degradation. */
  readonly prefetch: PrefetchPolicy;
  /** Whether media prefetch is currently paused (mode policy or pressure). */
  readonly mediaPaused: boolean;
}

/** Assemble an honest storage status for `mode` from the live storage estimate. */
export async function storageStatus(mode: StorageMode): Promise<StorageStatus> {
  const config = STORAGE_MODES[mode];
  const estimate = await estimateStorage();
  const usage = estimate?.usage ?? 0;
  const quota = estimate?.quota ?? 0;
  const pressureRatio = storagePressure(usage, quota);
  const prefetch = effectivePrefetch(config, pressureRatio);
  return {
    mode,
    usage,
    quota,
    pressureRatio,
    overBudget: isOverBudget(config, usage),
    persisted: await isStoragePersisted(),
    prefetch,
    mediaPaused: !prefetch.media,
  };
}
