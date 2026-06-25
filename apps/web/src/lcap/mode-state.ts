// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.4 / WS-R.17.2 — the client's current §33 operational mode, persisted.  The
// C0-first sync reads it so an AUTOMATIC sync (incl. app-open / background-sync) is
// suppressed in Stealth (§23.3): the operational mode maps to its `StorageMode`, and
// `shouldAutoSync` treats `stealth` as suppress.  Default `standard`.
//
// This is the persisted source-of-truth a future mode SELECTOR writes and every §33
// posture consumer reads.  Deliberately NOT a user-facing toggle yet: a Stealth control
// must land WITH the full §33 posture integration (media / export / discovery / storage),
// or it would imply a protection the rest of the client does not yet deliver — that
// surface is the tracked WS-R.17.2 follow-up (`docs/lcap/README.md`).  It is a plain
// persisted module, not a Zustand store, so the documented client store-count (auth, ui,
// feature-flags) is unchanged; the sync reads it non-reactively.

import { z } from 'zod';
import { loadPersisted, type PersistConfig, savePersisted } from '../stores/persist.js';
import {
  OPERATIONAL_MODE_KEYS,
  OPERATIONAL_MODES,
  type OperationalMode,
} from './operational-modes.js';
import type { StorageMode } from './storage-modes.js';

const operationalModeSchema = z.enum(
  OPERATIONAL_MODE_KEYS as [OperationalMode, ...OperationalMode[]],
);

const PERSIST: PersistConfig<{ mode: OperationalMode }> = {
  key: 'lcap-mode',
  schema: z.object({ mode: operationalModeSchema }),
  version: 1,
};

/** The current operational mode (persisted; `standard` by default / on any invalid slice). */
export function getOperationalMode(): OperationalMode {
  return loadPersisted(PERSIST)?.mode ?? 'standard';
}

/** Listeners notified synchronously whenever the operational mode changes (e.g. the courier
 *  runtime stops live radios when the user switches into Stealth/Emergency). */
const modeListeners = new Set<(mode: OperationalMode) => void>();

/** Subscribe to operational-mode changes; returns an unsubscribe.  Lets a live §33 consumer
 *  (e.g. a running courier) react to a mode switch instead of reading the mode only at start. */
export function subscribeOperationalMode(listener: (mode: OperationalMode) => void): () => void {
  modeListeners.add(listener);
  return () => {
    modeListeners.delete(listener);
  };
}

/** Persist the current operational mode (the write seam the §33 selector calls) and notify
 *  subscribers so a running consumer can reconcile immediately. */
export function setOperationalMode(mode: OperationalMode): void {
  savePersisted(PERSIST, { mode });
  for (const listener of modeListeners) listener(mode);
}

/**
 * The `StorageMode` the §23.3 sync gate reads from the current operational mode.  Stealth
 * maps to `stealth`, which `shouldAutoSync` suppresses; every other mode currently permits
 * an automatic sync (the per-mode media/priority/export differences are read by the other
 * §33 consumers, not the sync gate).
 */
export function syncStorageMode(): StorageMode {
  return OPERATIONAL_MODES[getOperationalMode()].storageMode;
}

/** Whether the current mode permits best-effort background-sync registration (§33). */
export function backgroundSyncAllowed(): boolean {
  return OPERATIONAL_MODES[getOperationalMode()].backgroundSync;
}
