// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.4 — C0-first sync triggers (OFFLINE_SPEC §23.3).  Background sync is
// unreliable, so the app drives sync from `online` / `focus` / `visibilitychange`
// events and explicit user actions, debounced so a burst of events coalesces into a
// single, tiny, C0-first pass.  AUTOMATIC syncs respect the conditions — offline,
// Stealth mode, data-saver, and low battery suppress them; an EXPLICIT user action
// (or app open) syncs regardless (it is not automatic).  Best-effort background-sync
// registration is a secondary path.  No remote code: this is app-side orchestration;
// the worker's `sync` handler stays as-is (the `check:sw` gate is untouched).

import type { StorageMode } from './storage-modes.js';

export type SyncTrigger = 'online' | 'focus' | 'visibility' | 'user-action' | 'open';

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

/** Read the live sync conditions from the browser (defensive; safe defaults). */
export function readSyncConditions(privacyMode: StorageMode): SyncConditions {
  const nav = globalThis.navigator as
    | { onLine?: boolean; connection?: { saveData?: boolean } }
    | undefined;
  return {
    online: nav?.onLine ?? true,
    privacyMode,
    dataSaver: nav?.connection?.saveData ?? false,
    batteryLow: false,
  };
}

export interface SyncOrchestrator {
  /** Attach the event listeners. */
  start(): void;
  /** Detach the event listeners (and cancel any pending debounced sync). */
  stop(): void;
  /** Request a sync now; `user-action`/`open` bypass the auto-sync gate (explicit). */
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
 * Create the sync orchestrator.  `online`/`focus`/`visibility` events trigger an
 * AUTOMATIC (gated, debounced) sync; `trigger('user-action' | 'open')` is an explicit
 * request that bypasses the gate.  A failed `runSync` is swallowed — the outbox keeps
 * the unsent work for the next trigger.
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
      fire(reason, reason === 'user-action' || reason === 'open');
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
