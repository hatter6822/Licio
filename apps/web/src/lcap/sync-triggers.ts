// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.4 — C0-first sync triggers (OFFLINE_SPEC §23.3).  Background sync is
// unreliable, so the app drives sync from `online` / `focus` / `visibilitychange`
// events, app open, and the secondary background-sync nudge, debounced so a burst of
// events coalesces into a single, tiny, C0-first pass.  ALL of those are AUTOMATIC and
// respect the §23.3 conditions — offline, Stealth mode, data-saver, and low battery
// suppress them (so a Stealth-mode device never auto-contacts the server, not even on
// app open).  Only an EXPLICIT user action (a deliberate "sync now") syncs regardless.
// No remote code: this is app-side orchestration; the worker's `sync` handler stays
// as-is (the `check:sw` gate is untouched).

import type { StorageMode } from './storage-modes.js';

export type SyncTrigger = 'online' | 'focus' | 'visibility' | 'open' | 'background' | 'user-action';

export interface SyncConditions {
  readonly online: boolean;
  readonly privacyMode: StorageMode;
  readonly dataSaver: boolean;
  readonly batteryLow: boolean;
}

/** Whether an AUTOMATIC sync should run (§23.3: respect connectivity/mode/data/battery). */
export function shouldAutoSync(c: SyncConditions): boolean {
  return c.online && c.privacyMode !== 'stealth' && !c.dataSaver && !c.batteryLow;
}

// §23.3 low-battery suppression.  The Battery Status API is Chromium-only (Firefox
// removed it, Safari never shipped it), so where it is absent the signal stays `false`
// — honestly "unknown", never a false positive.  A non-charging device at/under 20%
// suppresses AUTOMATIC syncs to conserve power.  Cached so `readSyncConditions` stays
// synchronous; updated by `initBatteryTracking` (called from `startLcapSync`).
const LOW_BATTERY_THRESHOLD = 0.2;
let cachedBatteryLow = false;

interface BatteryLike {
  readonly level: number;
  readonly charging: boolean;
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
}

/**
 * Begin best-effort battery tracking (returns a teardown).  A runtime with no Battery
 * Status API is a no-op (the signal stays `false`).  The teardown detaches the listeners
 * and resets the cache so a re-init starts clean.
 */
export function initBatteryTracking(): () => void {
  const nav = globalThis.navigator as { getBattery?: () => Promise<BatteryLike> } | undefined;
  if (typeof nav?.getBattery !== 'function') return () => undefined;
  let battery: BatteryLike | undefined;
  let cancelled = false;
  const update = (): void => {
    if (battery) cachedBatteryLow = !battery.charging && battery.level <= LOW_BATTERY_THRESHOLD;
  };
  void nav
    .getBattery()
    .then((b) => {
      if (cancelled) return;
      battery = b;
      update();
      b.addEventListener?.('levelchange', update);
      b.addEventListener?.('chargingchange', update);
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    cachedBatteryLow = false;
    battery?.removeEventListener?.('levelchange', update);
    battery?.removeEventListener?.('chargingchange', update);
  };
}

/** Read the live sync conditions from the browser (defensive; safe defaults). */
export function readSyncConditions(privacyMode: StorageMode): SyncConditions {
  const nav = globalThis.navigator as
    | { onLine?: boolean; connection?: { saveData?: boolean } }
    | undefined;
  return {
    online: nav?.onLine ?? true,
    privacyMode,
    dataSaver: nav?.connection?.saveData ?? false,
    batteryLow: cachedBatteryLow,
  };
}

export interface SyncOrchestrator {
  /** Attach the event listeners. */
  start(): void;
  /** Detach the event listeners (and cancel any pending debounced sync). */
  stop(): void;
  /** Request a sync now; only `user-action` bypasses the §23.3 gate (a deliberate sync). */
  trigger(reason: SyncTrigger): void;
}

export interface SyncOrchestratorOptions {
  /** Run a C0-first sync pass (control + trust material first; tiny + fast). */
  readonly runSync: (trigger: SyncTrigger) => Promise<void> | void;
  /** The live conditions an automatic sync is gated on. */
  readonly conditions: () => SyncConditions;
  /** Debounce window so a burst of events coalesces into one pass (default 1s). */
  readonly debounceMs?: number;
}

/**
 * Create the sync orchestrator.  `online`/`focus`/`visibility`/`open`/`background`
 * triggers are AUTOMATIC (gated by §23.3, debounced); only `trigger('user-action')` is
 * an explicit request that bypasses the gate.  A failed `runSync` is swallowed — the
 * outbox keeps the unsent work for the next trigger.
 */
export function createSyncOrchestrator(options: SyncOrchestratorOptions): SyncOrchestrator {
  const debounceMs = options.debounceMs ?? 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: SyncTrigger | undefined;

  const fire = (trigger: SyncTrigger, force: boolean): void => {
    if (!force && !shouldAutoSync(options.conditions())) return;
    pending = trigger;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const reason = pending ?? trigger;
      pending = undefined;
      timer = undefined;
      // A failed sync leaves the outbox intact; the next trigger retries it.
      void Promise.resolve(options.runSync(reason)).catch(() => undefined);
    }, debounceMs);
  };

  const onOnline = (): void => fire('online', false);
  const onFocus = (): void => fire('focus', false);
  const onVisible = (): void => {
    if (globalThis.document?.visibilityState === 'visible') fire('visibility', false);
  };

  return {
    start(): void {
      globalThis.addEventListener?.('online', onOnline);
      globalThis.addEventListener?.('focus', onFocus);
      globalThis.document?.addEventListener?.('visibilitychange', onVisible);
    },
    stop(): void {
      globalThis.removeEventListener?.('online', onOnline);
      globalThis.removeEventListener?.('focus', onFocus);
      globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    trigger(reason: SyncTrigger): void {
      fire(reason, reason === 'user-action');
    },
  };
}

/**
 * Best-effort background-sync registration (a SECONDARY path to the app-side
 * triggers, which are primary because background sync is unreliable).  Returns
 * whether registration succeeded; never throws.
 */
export async function requestBackgroundSync(tag = 'lcap-c0-sync'): Promise<boolean> {
  const container = globalThis.navigator?.serviceWorker;
  if (!container) return false;
  try {
    const registration = (await container.ready) as {
      sync?: { register: (tag: string) => Promise<void> };
    };
    if (!registration.sync) return false;
    await registration.sync.register(tag);
    return true;
  } catch {
    return false;
  }
}
