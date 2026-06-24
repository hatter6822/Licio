// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — service-worker update PINNING for the private-mode bundle
// (PRIVATE_SPEC §20.6, §27.5).  A new service worker reaching `waiting` must NOT
// silently take over for private-room users: before the app activates it
// (`SKIP_WAITING` → `controllerchange` → reload), the PENDING build's private-mode
// bundle — the one the waiting worker would serve, fetched fresh, NOT the running
// chunk — is verified against the transparency log (`assertPendingBundleTrusted`).
// An UNVERIFIED update is gated:
//
//   * private rooms LOCK (keys stay sealed) with the exact §20.6 copy, and
//   * the waiting worker is NOT activated by the private surface (the user keeps
//     the verified controller; they may still use public Licio).
//
// This module owns the decision; it never relaxes CSP / Trusted Types / the
// no-dynamic-remote-code posture (it issues no `importScripts`, `eval`, or
// `new Function`, and runs no remote code — `check:sw` stays green).  The actual
// `postMessage({type:'SKIP_WAITING'})` stays with `sw-register.ts::applyUpdate`;
// this gate decides WHETHER that call is allowed for a private-room user.

import type { TrustedBundleVerdict } from '@licio/shared';
import {
  type AssertTrustedDeps,
  assertPendingBundleTrusted,
  resetPrivateBundleGate,
} from './gate.js';

/** The decision for a pending SW activation. */
export type UpdateActivationGate =
  | { readonly allowActivate: true }
  | { readonly allowActivate: false; readonly verdict: TrustedBundleVerdict };

/**
 * Decide whether a waiting service worker may activate for a user with private
 * rooms.  Re-verifies the (incoming) private-mode bundle against the
 * transparency log; allows activation only on a trusted verdict.  On an
 * untrusted verdict the gate state is already LOCKED (set by
 * `assertPrivateBundleTrusted`) and activation is refused.
 *
 * For a user WITHOUT private rooms, the caller may skip this gate entirely — the
 * lock only governs the private surface, never public Licio.
 */
export async function gateServiceWorkerActivation(
  deps: AssertTrustedDeps = {},
): Promise<UpdateActivationGate> {
  // Re-verify the PENDING (waiting-worker) bundle — the build a `SKIP_WAITING` would actually
  // activate — NOT the already-running chunk.  Hashing the running build would let a trusted
  // current bundle wave through an unverified update (and falsely lock a valid one once the
  // signed manifest has advanced).
  resetPrivateBundleGate();
  const verdict = await assertPendingBundleTrusted(deps);
  if (verdict.trusted) return { allowActivate: true };
  return { allowActivate: false, verdict };
}

/**
 * Post the GATED `SKIP_WAITING` the worker expects (sw-push.js): a private-room
 * user's activation carries `privateBundleGated: true` + `privateBundleVerified:
 * true`, so the worker refuses to skip-waiting unless verification passed.  A
 * public-only client passes `verified: true` with `privateBundleGated: false`.
 * The worker fails closed on a missing `privateBundleVerified` flag.
 */
export function activateVerifiedWorker(
  waiting: ServiceWorker | null | undefined,
  options: { readonly privateBundleGated: boolean; readonly verified: boolean },
): void {
  waiting?.postMessage({
    type: 'SKIP_WAITING',
    privateBundleGated: options.privateBundleGated,
    privateBundleVerified: options.verified,
  });
}

/**
 * Wire the SW-update event to the private-bundle gate.  When `sw-register.ts`
 * dispatches `SW_UPDATE_EVENT` (a waiting worker is ready), this verifies the
 * incoming bundle and only calls `onActivate(registration)` (which performs the
 * real `applyUpdate`) when the verdict is trusted.  On a lock, `onLocked` runs
 * (the UI renders the §20.6 message) and the worker is NOT activated.
 *
 * Returns a disposer that removes the listener.  No-ops in a non-browser env.
 */
export function installSwUpdatePinning(opts: {
  readonly eventName: string;
  readonly onActivate: (registration: ServiceWorkerRegistration) => void;
  readonly onLocked: (verdict: TrustedBundleVerdict) => void;
  readonly deps?: AssertTrustedDeps;
  /** Only gate updates when the user actually has private rooms (default true). */
  readonly hasPrivateRooms?: () => boolean;
}): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event): void => {
    const registration = (event as CustomEvent<ServiceWorkerRegistration>).detail;
    const gated = opts.hasPrivateRooms ? opts.hasPrivateRooms() : true;
    if (!gated) {
      // No private rooms ⇒ the update channel does not gate the public surface;
      // activation proceeds with the public-only flag the worker accepts.
      activateVerifiedWorker(registration.waiting, { privateBundleGated: false, verified: true });
      opts.onActivate(registration);
      return;
    }
    void gateServiceWorkerActivation(opts.deps).then((decision) => {
      if (decision.allowActivate) {
        // Only now — after a trusted verdict — does the worker get the verified
        // flag it requires to skip-waiting for a private-room user.
        activateVerifiedWorker(registration.waiting, {
          privateBundleGated: true,
          verified: true,
        });
        opts.onActivate(registration);
      } else {
        opts.onLocked(decision.verdict);
      }
    });
  };
  window.addEventListener(opts.eventName, handler);
  return () => window.removeEventListener(opts.eventName, handler);
}
