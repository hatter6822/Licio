// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — ARM the service-worker update pinning in the real app boot
// (PRIVATE_SPEC §20.6, §27.5).  Without this, the production update flow posts a
// bare `SKIP_WAITING` and the worker's refusal branch never triggers (the
// `privateBundleGated` flag is absent).  `gatedApplyUpdate` is the consent-aware
// counterpart of `sw-register.ts::applyUpdate`: when the device hosts private
// rooms it verifies the incoming bundle against the transparency log FIRST and
// only posts the GATED `SKIP_WAITING` (`privateBundleGated:true` +
// `privateBundleVerified:true`, the flags the worker requires) on a trusted
// verdict; on a lock it does NOT activate (the user keeps the verified
// controller; the §20.6 lock surface is already published by the gate) and runs
// `onLocked`.  A device with NO private rooms keeps the fast public path.
//
// The private-room presence probe is self-contained (it checks for the isolated
// private-rooms IndexedDB by NAME, never importing the code-split `private-p2p`
// plane into the boot path) and FAIL-CLOSED: when `indexedDB.databases()` is
// unavailable (e.g. Firefox) it returns `true` so the update is gated rather
// than silently fast-pathed.  No remote code, no eval — `check:sw` is unaffected.

import { applyUpdate } from '../lib/sw-register.js';
import type { AssertTrustedDeps } from './gate.js';
import { activateVerifiedWorker, gateServiceWorkerActivation } from './sw-pinning.js';

/** The isolated private-rooms IndexedDB name (declared locally; not imported). */
const PRIVATE_P2P_DB_NAME = 'licio_private_p2p';

/**
 * Best-effort, fail-closed probe for whether this device hosts any private room.
 * Resolves `true` when the isolated private-rooms DB is present OR the platform
 * cannot enumerate databases (so the update is gated, never silently skipped).
 */
export async function deviceHasPrivateRooms(): Promise<boolean> {
  try {
    const idb = globalThis.indexedDB;
    if (!idb || typeof idb.databases !== 'function') return true; // fail-closed
    const dbs = await idb.databases();
    return dbs.some((d) => d.name === PRIVATE_P2P_DB_NAME);
  } catch {
    return true; // fail-closed: unable to determine ⇒ gate the update
  }
}

export interface GatedApplyUpdateOptions {
  /** Called on a lock (the §20.6 lock surface is already published by the gate). */
  readonly onLocked?: () => void;
  /** Override the private-room presence check (default: the IndexedDB probe). */
  readonly hasPrivateRooms?: () => Promise<boolean>;
  /** Inject a config/fetch for tests. */
  readonly deps?: AssertTrustedDeps;
}

/**
 * Apply a pending service-worker update with verify-before-activate PINNING.
 *
 *   * No private rooms on this device ⇒ the public fast path (bare
 *     `applyUpdate`), since the lock only governs the private surface.
 *   * Private rooms present ⇒ re-verify the incoming private-mode bundle; only a
 *     `trusted` verdict posts the GATED `SKIP_WAITING` the worker accepts.  A
 *     lock leaves the verified controller in place and runs `onLocked`.
 */
export async function gatedApplyUpdate(
  waiting: ServiceWorker | null | undefined,
  options: GatedApplyUpdateOptions = {},
): Promise<void> {
  const probe = options.hasPrivateRooms ?? deviceHasPrivateRooms;
  const gated = await probe();
  if (!gated) {
    // No private rooms ⇒ public surface: activate normally.
    applyUpdate(waiting);
    return;
  }
  const decision = await gateServiceWorkerActivation(options.deps ? { ...options.deps } : {});
  if (decision.allowActivate) {
    // Only after a trusted verdict does the worker get the verified flag it
    // requires to skip-waiting for a private-room user.
    activateVerifiedWorker(waiting, { privateBundleGated: true, verified: true });
  } else {
    options.onLocked?.();
  }
}
