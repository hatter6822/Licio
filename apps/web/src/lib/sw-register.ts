// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Service-worker registration + update lifecycle (WS-C.2.1c). On a new worker
// reaching `installed` (with an existing controller), an `installed`/waiting
// worker exists: we dispatch an event so the UI can offer a non-blocking
// "Update available" toast (WS-B.1.3c). Activating posts SKIP_WAITING; the SW
// takes control and `controllerchange` reloads the page EXACTLY once (guarded
// against a reload loop, WS-C.2.1c edge case). Registration failure is non-fatal
// — the app degrades to online-only.

import { track } from './telemetry.js';

/** Window event carrying the registration whose `waiting` worker can activate. */
export const SW_UPDATE_EVENT = 'licio:sw-update';

let reloaded = false;

/** Activate a waiting worker (called when the user accepts the update). */
export function applyUpdate(waiting: ServiceWorker | null | undefined): void {
  waiting?.postMessage({ type: 'SKIP_WAITING' });
}

function emitUpdateAvailable(registration: ServiceWorkerRegistration): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ServiceWorkerRegistration>(SW_UPDATE_EVENT, { detail: registration }),
  );
}

function watchForUpdate(registration: ServiceWorkerRegistration): void {
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // A new worker installed while one already controls the page ⇒ update ready.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        emitUpdateAvailable(registration);
      }
    });
  });
}

/** Register the service worker and wire the update lifecycle. */
export function registerServiceWorker(): void {
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    typeof window === 'undefined'
  ) {
    return;
  }
  const container = navigator.serviceWorker;

  container.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  const register = (): void => {
    container
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        watchForUpdate(registration);
        // SW-health beacon: scope PATH only (no origin/PII), confirms a correctly
        // scoped worker in production (WS-C.2.1d observability).
        let scopePath = '/';
        try {
          scopePath = new URL(registration.scope).pathname;
        } catch {
          // keep default
        }
        track({ name: 'sw_health', metric: 'activated', bucket: scopePath });
      })
      .catch(() => undefined); // Non-fatal: degrade to online-only.
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
