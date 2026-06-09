// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App runtime bootstrap. Wires the client-state stores, the offline lifecycle
// (foreground sync + iOS eviction detection + persistent-storage request), and
// the signal processor, then performs best-effort, FAIL-CLOSED hydration of
// feature flags, session, and the signal collection policy. Pure side-effect
// orchestration kept out of main.tsx so the wiring is reviewable in one place.
import { DEFAULT_USER_SETTINGS } from '@licio/shared';
import {
  initEvictionDetection,
  type ProbeResult,
  requestPersistentStorage,
} from '../offline/eviction.js';
import { initForegroundSync, processPendingQueue } from '../offline/sync.js';
import { initWebVitals } from '../perf/vitals.js';
import { ensurePushSubscription } from '../push/subscription.js';
import { resolveCollectionPolicy } from '../signals/privacy.js';
import { getSignalProcessor } from '../signals/runtime.js';
import { initAuthSync, useAuthStore } from '../stores/auth.js';
import { useFeatureFlagStore } from '../stores/feature-flags.js';
import { initUIStore } from '../stores/ui.js';
import { fetchAuthStatus, fetchFeatureFlags, fetchSettings } from './api.js';
import { initTelemetry, track } from './telemetry.js';

/** Event dispatched on detected eviction so the UI can notify the reader. */
export const EVICTION_EVENT = 'licio:storage-evicted';

/** Hydrate feature flags from the server; any failure leaves them fail-closed. */
export async function hydrateFeatureFlags(): Promise<void> {
  try {
    useFeatureFlagStore.getState().hydrate(await fetchFeatureFlags());
  } catch {
    // Network/parse failure ⇒ keep the fail-closed defaults (hydrate null).
    useFeatureFlagStore.getState().hydrate(null);
  }
  // Observability: record the resolved flag set so accidental enablement is
  // visible (no PII — just the booleans). SPEC §0.5 / Risk Mitigation.
  const { flags } = useFeatureFlagStore.getState();
  track({
    name: 'feature_flags',
    bucket: `crypto-${flags.cryptoEnabled ? 'on' : 'off'},gov-${flags.governanceEnabled ? 'on' : 'off'}`,
  });
}

/** Confirm the session; downgrade an optimistic rehydration on a 401/absence. */
export async function confirmSession(): Promise<void> {
  try {
    const status = await fetchAuthStatus();
    if (status.authenticated) {
      useAuthStore.getState().setUser(status.user);
    } else if (useAuthStore.getState().status === 'authenticated') {
      useAuthStore.getState().expireSession();
    }
  } catch {
    // Offline: keep the optimistic state; the next protected call re-checks.
  }
}

/** Apply the signal-collection policy from the user's privacy settings. */
export async function applySignalPolicy(): Promise<void> {
  const userId = useAuthStore.getState().user?.id ?? null;
  let settings = DEFAULT_USER_SETTINGS;
  try {
    settings = await fetchSettings();
  } catch {
    // Use the safe defaults (personalization on, standard privacy) when offline.
  }
  getSignalProcessor().setCollectionPolicy(resolveCollectionPolicy(settings, userId));
}

function onEvicted(result: ProbeResult): void {
  // Resync surviving queue items and surface a notice (esp. if the queue was lost).
  void processPendingQueue();
  track({
    name: 'eviction',
    count: (result.lostPending ? 1 : 0) + (result.lostLedger ? 1 : 0),
    ...(result.estimateBytes !== null ? { value: result.estimateBytes } : {}),
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ProbeResult>(EVICTION_EVENT, { detail: result }));
  }
}

/** Sample storage quota usage for the cache-stats observability channel. */
async function reportStorageEstimate(): Promise<void> {
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    if (estimate?.usage !== undefined) {
      track({ name: 'cache_stats', value: estimate.usage });
    }
  } catch {
    // Storage estimate unavailable; skip.
  }
}

/**
 * Start the app runtime. Returns a teardown that unwires every listener. Async
 * hydration runs in the background and never blocks first render.
 */
export function startRuntime(): () => void {
  initUIStore();
  const teardownTelemetry = initTelemetry();
  const teardownAuthSync = initAuthSync();
  const teardownProcessor = getSignalProcessor().start();
  const teardownSync = initForegroundSync();
  const teardownEviction = initEvictionDetection({ onEvicted });
  // Core Web Vitals RUM → privacy-safe telemetry (metric name/value/rating only,
  // never a URL or identifier). Lab measurement remains the authoritative gate.
  const teardownVitals = initWebVitals((vital) => {
    track({ name: 'web_vital', metric: vital.name, value: vital.value, rating: vital.rating });
  });
  void requestPersistentStorage();
  void reportStorageEstimate();
  // Renew-on-load: re-register an existing push subscription (no prompt). The SW
  // 'pushsubscriptionchange' handler covers re-creation when the app is closed.
  void ensurePushSubscription();

  void hydrateFeatureFlags();
  void confirmSession().then(applySignalPolicy);

  return () => {
    teardownTelemetry();
    teardownAuthSync();
    teardownProcessor();
    teardownSync();
    teardownEviction();
    teardownVitals();
  };
}
