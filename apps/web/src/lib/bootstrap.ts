// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App runtime bootstrap. Wires the client-state stores, the offline lifecycle
// (foreground sync + iOS eviction detection + persistent-storage request), and
// the signal processor, then performs best-effort, FAIL-CLOSED hydration of
// feature flags, session, and the signal collection policy. Pure side-effect
// orchestration kept out of main.tsx so the wiring is reviewable in one place.
import { DEFAULT_USER_SETTINGS } from '@licio/shared';
import { startLcapSync } from '../lcap/sync-boot.js';
import { expireOldDrafts } from '../offline/drafts.js';
import {
  initEvictionDetection,
  type ProbeResult,
  requestPersistentStorage,
} from '../offline/eviction.js';
import { initForegroundSync, processPendingQueue } from '../offline/sync.js';
import {
  connectionBucket,
  deviceClassBucket,
  getActiveRoutePattern,
  initWebVitals,
  type WebVital,
} from '../perf/vitals.js';
import { ensurePushSubscription } from '../push/subscription.js';
import { resolveCollectionPolicy } from '../signals/privacy.js';
import { getSignalProcessor } from '../signals/runtime.js';
import { initAuthSync, selectCollectionUserId, useAuthStore } from '../stores/auth.js';
import { useFeatureFlagStore } from '../stores/feature-flags.js';
import { initUIStore, useUIStore } from '../stores/ui.js';
import { fetchAuthStatus, fetchFeatureFlags, fetchSettings } from './api.js';
import { warmLinkSafety } from './link-safety.js';
import { fetchPrivacySettings } from './privacy-api.js';
import { flushTelemetry, initTelemetry, track } from './telemetry.js';

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
      void seedDurableFeedMode();
    } else if (useAuthStore.getState().status === 'authenticated') {
      useAuthStore.getState().expireSession();
    }
  } catch {
    // Offline: keep the optimistic state; the next protected call re-checks.
  }
}

/**
 * Seed the feed mode from the DURABLE personalization settings on sign-in
 * (WS-H.6.1c-2: the mode persists across sessions and devices — the server
 * copy is the cross-device truth at boot; local changes during the session
 * sync back through the switcher/prompt mutations).
 */
async function seedDurableFeedMode(): Promise<void> {
  try {
    const settings = await fetchPrivacySettings();
    const mode = settings.personalization_settings.feed_mode;
    if (mode) useUIStore.getState().setFeedMode(mode);
  } catch {
    // Offline / not yet verified: the locally persisted mode stands.
  }
}

/**
 * Apply the signal-collection policy from the user's privacy settings. Collection
 * is gated on a live authenticated session via `selectCollectionUserId`, honoring
 * the `signals/privacy.ts` invariant: signed-out or session-expired readers
 * generate no attention data at all.
 *
 * The effective user id is read AFTER the settings await, not before: a logout or
 * 401-driven session expiry can land while the request is in flight, and a
 * pre-await snapshot would let this (now-stale) invocation re-enable collection
 * for a dead session — racing, and overwriting, the auth subscription's disable.
 * Reading the live auth state immediately before the write keeps the last writer
 * correct regardless of interleaving.
 */
export async function applySignalPolicy(): Promise<void> {
  let settings = DEFAULT_USER_SETTINGS;
  try {
    settings = await fetchSettings();
  } catch {
    // Use the safe defaults (personalization on, standard privacy) when offline.
  }
  const userId = selectCollectionUserId(useAuthStore.getState());
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
  // WS-R.11.4: the LCAP C0-first sync hooks (§23.3) — sync on app open + regained
  // connectivity / focus, suppressed offline / in Stealth / under data-saver / on low
  // battery.  The sync PASS is a DYNAMICALLY-imported chunk, so the @licio/lcap codec
  // never enters the initial bundle.
  const teardownLcapSync = startLcapSync();
  // WS-G.3.7c: drafts older than 30 days are cleaned up on app start.
  void expireOldDrafts().catch(() => undefined);
  // Core Web Vitals RUM → privacy-safe telemetry. Each vital reports ONCE per
  // pageload at its FINAL value, flushed when the page is first hidden — so the
  // WS-P.1.1d p75 aggregation counts one sample per pageview instead of every
  // incremental CLS/INP update. The coarse device/connection buckets and the
  // route PATTERN ride along (closed enums / pattern only — never a URL, a
  // fingerprint, or an identifier). Lab measurement remains the authoritative gate.
  const latestVitals = new Map<WebVital['name'], WebVital & { route: string }>();
  const teardownObservers = initWebVitals((vital) => {
    // Attribute the vital to the route where it was OBSERVED: reading the
    // route at flush time would stamp the initial page's LCP with whatever
    // route the user navigated to last, corrupting the per-route p75 buckets.
    latestVitals.set(vital.name, { ...vital, route: getActiveRoutePattern() });
  });
  let vitalsFlushed = false;
  const flushVitals = (): void => {
    if (vitalsFlushed || typeof document === 'undefined') return;
    if (document.visibilityState !== 'hidden') return;
    vitalsFlushed = true;
    for (const vital of latestVitals.values()) {
      track({
        name: 'web_vital',
        metric: vital.name,
        value: vital.value,
        rating: vital.rating,
        bucket: vital.route,
        device_class: deviceClassBucket(),
        connection: connectionBucket(),
      });
    }
    flushTelemetry();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', flushVitals);
  }
  const teardownVitals = (): void => {
    teardownObservers();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', flushVitals);
    }
  };
  void requestPersistentStorage();
  void reportStorageEstimate();
  // Renew-on-load: re-register an existing push subscription (no prompt). The SW
  // 'pushsubscriptionchange' handler covers re-creation when the app is closed.
  void ensurePushSubscription();

  void hydrateFeatureFlags();
  // WS-G.4.2c: warm the drainer blocklist BEFORE the first UGC link click —
  // the click-path verdict never awaits the network (transient-activation
  // safety), so the list must already be cached to participate.
  void warmLinkSafety();
  void confirmSession().then(applySignalPolicy);
  // Re-apply the collection policy whenever the EFFECTIVE session identity changes
  // (login, logout, AND session expiry): collection requires a live authenticated
  // session (the WS-E ingestion boundary authenticates every upload), so the policy
  // must track auth state live — not only at startup. We key on the gated identity
  // (selectCollectionUserId), not the raw `user?.id`, because expireSession()
  // retains the user object and only flips the status; keying on the id would miss
  // the expiry and keep collecting straight into 401s.
  let lastPolicyUserId = selectCollectionUserId(useAuthStore.getState());
  const teardownPolicySync = useAuthStore.subscribe((state) => {
    const userId = selectCollectionUserId(state);
    if (userId === lastPolicyUserId) return;
    lastPolicyUserId = userId;
    void applySignalPolicy();
  });

  return () => {
    teardownTelemetry();
    teardownAuthSync();
    teardownProcessor();
    teardownSync();
    teardownEviction();
    teardownVitals();
    teardownPolicySync();
    teardownLcapSync();
  };
}
