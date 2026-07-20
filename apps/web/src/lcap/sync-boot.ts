// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.4 — boot the C0-first sync hooks (OFFLINE_SPEC §23.3).  Attaches the
// online/focus/visibility trigger orchestrator (the light `sync-triggers` module), gated
// on the §23.3 conditions (offline / Stealth mode / data-saver / low battery suppress an
// AUTOMATIC sync — including app open and the background nudge; only a deliberate user
// action syncs regardless), fires an initial gated 'open' sync, begins best-effort
// battery tracking (for the §23.3 low-battery gate), and — when the §33 mode permits —
// registers best-effort background sync (the SECONDARY path: the SW `sync` handler posts
// a message back to the app, which runs the same pass as a gated 'background' trigger).
// The current operational mode comes from the persisted `mode-state`.  The actual sync
// PASS lives in a DYNAMICALLY-imported chunk (`sync-pass`), so the @licio/lcap codec
// never enters the initial bundle.  No remote code; the `check:sw` gate is untouched.

import { backgroundSyncAllowed, syncStorageMode } from './mode-state.js';
import type { StorageMode } from './storage-modes.js';
import {
  createSyncOrchestrator,
  initBatteryTracking,
  readSyncConditions,
  requestBackgroundSync,
  type SyncOrchestrator,
} from './sync-triggers.js';

export interface LcapSyncBootOptions {
  /**
   * The current §33 storage mode the §23.3 gate reads (Stealth suppresses auto-sync).
   * Defaults to the persisted operational mode (`mode-state`) — `standard` until a mode
   * is set.  Injectable for tests.
   */
  readonly getStorageMode?: () => StorageMode;
  /** Debounce window coalescing a burst of triggers into one pass (default 1000ms). */
  readonly debounceMs?: number;
}

let active: SyncOrchestrator | undefined;
let teardownBattery: (() => void) | undefined;

/**
 * The SW posts `{ type: 'lcap-sync' }` when a background sync fires → run the same pass
 * as a `background` trigger, which (like every automatic trigger) RESPECTS the §23.3
 * conditions, so a background nudge never syncs in Stealth / offline / on a data-saver /
 * low battery.
 */
function onServiceWorkerMessage(event: { data?: unknown }): void {
  const data = event.data;
  if (
    data !== null &&
    typeof data === 'object' &&
    (data as { type?: unknown }).type === 'lcap-sync'
  ) {
    // Honour the §33 operational mode's backgroundSync posture here too: the
    // orchestrator's conditions gate on the §23.3 PRIVACY mode, not the §33
    // operational mode, so without this an lcap-sync message (e.g. from a
    // background registration made before the mode tightened, or another tab)
    // would run a background sync in Emergency/Stealth/minimal — modes whose
    // backgroundSync is false. The `open` trigger path already checks this.
    if (!backgroundSyncAllowed()) return;
    active?.trigger('background');
  }
}

/** Start the C0-first sync hooks (idempotent; returns a stopper). */
export function startLcapSync(options: LcapSyncBootOptions = {}): () => void {
  if (active) return stopLcapSync;
  const getStorageMode = options.getStorageMode ?? syncStorageMode;
  teardownBattery = initBatteryTracking();
  const orchestrator = createSyncOrchestrator({
    // Thread the live §33 background-sync posture in: in Emergency/minimal the
    // storage mode is `minimal` but `backgroundSyncAllowed()` is false, and an
    // omitted arg would default to `true` — re-enabling the automatic open/focus/
    // online/visibility syncs the selected mode is meant to suppress.
    conditions: () => readSyncConditions(getStorageMode(), backgroundSyncAllowed()),
    runSync: async () => {
      // The lazy chunk: the @licio/lcap codec loads only when a sync actually fires.
      const { runC0Sync } = await import('./sync-pass.js');
      await runC0Sync();
    },
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
  });
  orchestrator.start();
  active = orchestrator;
  // Sync on app open — a GATED automatic trigger (§23.3), so Stealth / offline / data-
  // saver / low battery suppress it.  Plus the secondary background path, registered only
  // when the current §33 mode allows background sync (Stealth/minimal/emergency do not).
  orchestrator.trigger('open');
  if (backgroundSyncAllowed()) void requestBackgroundSync();
  globalThis.navigator?.serviceWorker?.addEventListener?.('message', onServiceWorkerMessage);
  return stopLcapSync;
}

/** Detach the hooks (idempotent). */
export function stopLcapSync(): void {
  active?.stop();
  teardownBattery?.();
  teardownBattery = undefined;
  globalThis.navigator?.serviceWorker?.removeEventListener?.('message', onServiceWorkerMessage);
  active = undefined;
}
