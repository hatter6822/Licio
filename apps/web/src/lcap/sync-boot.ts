// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.4 — boot the C0-first sync hooks (OFFLINE_SPEC §23.3).  Attaches the
// online/focus/visibility trigger orchestrator (the light `sync-triggers` module),
// gated on the §23.3 conditions (offline / Stealth mode / data-saver / low battery
// suppress an AUTOMATIC sync; an explicit user action or app-open syncs regardless),
// fires an initial 'open' sync, and registers best-effort background sync (the SECONDARY
// path — the SW `sync` handler posts a message back to the app, which runs the same
// pass).  The actual sync PASS lives in a DYNAMICALLY-imported chunk (`sync-pass`), so
// the @licio/lcap codec never enters the initial bundle.  No remote code; the `check:sw`
// gate is untouched.

import type { StorageMode } from './storage-modes.js';
import {
  createSyncOrchestrator,
  readSyncConditions,
  requestBackgroundSync,
  type SyncOrchestrator,
} from './sync-triggers.js';

export interface LcapSyncBootOptions {
  /** The current operational storage mode (Stealth suppresses auto-sync); default `standard`. */
  readonly getStorageMode?: () => StorageMode;
  /** Debounce window coalescing a burst of triggers into one pass (default 1000ms). */
  readonly debounceMs?: number;
}

let active: SyncOrchestrator | undefined;

/** The SW posts `{ type: 'lcap-sync' }` when a background sync fires → run the same pass. */
function onServiceWorkerMessage(event: { data?: unknown }): void {
  const data = event.data;
  if (
    data !== null &&
    typeof data === 'object' &&
    (data as { type?: unknown }).type === 'lcap-sync'
  ) {
    active?.trigger('user-action');
  }
}

/** Start the C0-first sync hooks (idempotent; returns a stopper). */
export function startLcapSync(options: LcapSyncBootOptions = {}): () => void {
  if (active) return stopLcapSync;
  const getStorageMode = options.getStorageMode ?? ((): StorageMode => 'standard');
  const orchestrator = createSyncOrchestrator({
    conditions: () => readSyncConditions(getStorageMode()),
    runSync: async () => {
      // The lazy chunk: the @licio/lcap codec loads only when a sync actually fires.
      const { runC0Sync } = await import('./sync-pass.js');
      await runC0Sync();
    },
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
  });
  orchestrator.start();
  active = orchestrator;
  // Sync on app open (explicit — bypasses the auto-sync gate) + the secondary background path.
  orchestrator.trigger('open');
  void requestBackgroundSync();
  globalThis.navigator?.serviceWorker?.addEventListener?.('message', onServiceWorkerMessage);
  return stopLcapSync;
}

/** Detach the hooks (idempotent). */
export function stopLcapSync(): void {
  active?.stop();
  globalThis.navigator?.serviceWorker?.removeEventListener?.('message', onServiceWorkerMessage);
  active = undefined;
}
