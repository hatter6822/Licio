// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — `useUpdateGate`: the React hook the private-room surface consults
// to decide whether to LOCK (PRIVATE_SPEC §20.6).  It subscribes to the gate
// state and, on first mount, kicks off the verify-before-unlock check.  Rendering
// is fail-closed: until a `trusted` verdict arrives the surface treats the room
// as LOCKED (`status` is `'checking'` or `'locked'`), so a slow/failed check
// never momentarily exposes room content.

import { useEffect, useSyncExternalStore } from 'react';
import {
  type AssertTrustedDeps,
  assertPrivateBundleTrusted,
  type PrivateBundleGateState,
  privateBundleGateState,
  subscribePrivateBundleGate,
} from './gate.js';

export interface UpdateGate extends PrivateBundleGateState {
  /** Convenience: `true` unless the verdict is `trusted` (fail-closed default). */
  readonly locked: boolean;
}

/**
 * Subscribe to the private-bundle gate.  Pass `{ enabled: false }` to observe
 * without triggering a check (e.g. for a user with no private rooms); pass
 * `deps` to inject a config/fetch for tests.
 */
export function useUpdateGate(
  options: { readonly enabled?: boolean; readonly deps?: AssertTrustedDeps } = {},
): UpdateGate {
  const enabled = options.enabled ?? true;
  const state = useSyncExternalStore(
    subscribePrivateBundleGate,
    privateBundleGateState,
    privateBundleGateState,
  );
  useEffect(() => {
    if (!enabled) return;
    // Idempotent: `assertPrivateBundleTrusted` memoizes the in-flight check.
    void assertPrivateBundleTrusted(options.deps);
  }, [enabled, options.deps]);
  return { ...state, locked: state.status !== 'trusted' };
}
