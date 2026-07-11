// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Core Web Vitals RUM (WS-C.5.1, SPEC §6.10). A dependency-free collector built
// on PerformanceObserver: LCP, CLS, and an INP approximation (longest event
// duration). Beacons are PRIVACY-SAFE — only the metric name, value, and rating
// (never a URL, query string, or user identifier). Lab measurement
// (Playwright/Lighthouse) is the authoritative release gate; this feeds the p75
// monitoring dashboard shared with WS-P.
export type Rating = 'good' | 'needs-improvement' | 'poor';
export type VitalName = 'LCP' | 'INP' | 'CLS';

export interface WebVital {
  name: VitalName;
  value: number;
  rating: Rating;
}

/** [good, poor] thresholds (SPEC §6.10 targets: LCP 2.5s, INP 200ms, CLS 0.1). */
const THRESHOLDS: Record<VitalName, [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
};

/** Rate a metric value against its good/poor thresholds. */
export function rateMetric(name: VitalName, value: number): Rating {
  const [good, poor] = THRESHOLDS[name];
  if (value <= good) return 'good';
  if (value <= poor) return 'needs-improvement';
  return 'poor';
}

export type DeviceClassBucket = 'low' | 'mid' | 'high' | 'unknown';
export type ConnectionBucket = 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';

/**
 * Coarse device class from PRIVACY-SAFE hints only (WS-P.1.1d): the (already
 * spec-coarsened) `deviceMemory` bucket and the `hardwareConcurrency` bucket —
 * never a precise fingerprint.  Browsers that expose neither (Safari, Firefox)
 * read 'unknown'.
 */
export function deviceClassBucket(
  nav: { deviceMemory?: number; hardwareConcurrency?: number } = navigator as {
    deviceMemory?: number;
    hardwareConcurrency?: number;
  },
): DeviceClassBucket {
  const memory = nav.deviceMemory;
  const cores = nav.hardwareConcurrency;
  if (memory === undefined && cores === undefined) return 'unknown';
  if ((memory !== undefined && memory <= 2) || (cores !== undefined && cores <= 2)) return 'low';
  if ((memory !== undefined && memory <= 4) || (cores !== undefined && cores <= 4)) return 'mid';
  return 'high';
}

/** Coarse connection type from the Network Information API, else 'unknown'. */
export function connectionBucket(
  nav: { connection?: { effectiveType?: string } } = navigator as {
    connection?: { effectiveType?: string };
  },
): ConnectionBucket {
  const effectiveType = nav.connection?.effectiveType;
  return effectiveType === 'slow-2g' ||
    effectiveType === '2g' ||
    effectiveType === '3g' ||
    effectiveType === '4g'
    ? effectiveType
    : 'unknown';
}

let activeRoutePattern = '/';
let routePatternKnown = false;
let firstRouteListeners: Array<(pattern: string) => void> = [];

/** Record the current route PATTERN (never a concrete path) for RUM attribution. */
export function setActiveRoutePattern(pattern: string): void {
  activeRoutePattern = pattern.slice(0, 64);
  if (!routePatternKnown) {
    routePatternKnown = true;
    const listeners = firstRouteListeners;
    firstRouteListeners = [];
    for (const listener of listeners) listener(activeRoutePattern);
  }
}

/** The current route pattern (the WS-P per-route vitals bucket). */
export function getActiveRoutePattern(): string {
  return activeRoutePattern;
}

/** Run `listener` once, when the router FIRST announces a real route pattern
 *  (immediately if it already has).  Vitals observed during startRuntime —
 *  the CLS = 0 seed, an early buffered LCP — predate RootLayout's first
 *  setActiveRoutePattern and would otherwise be misattributed to the '/'
 *  placeholder.  Returns an unsubscribe. */
export function onFirstRoutePattern(listener: (pattern: string) => void): () => void {
  if (routePatternKnown) {
    listener(activeRoutePattern);
    return () => {};
  }
  firstRouteListeners.push(listener);
  return () => {
    firstRouteListeners = firstRouteListeners.filter((l) => l !== listener);
  };
}

/** Test helper: restore the pre-router placeholder state. */
export function resetRoutePatternForTests(): void {
  activeRoutePattern = '/';
  routePatternKnown = false;
  firstRouteListeners = [];
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface EventTimingEntry extends PerformanceEntry {
  /** Set (> 0) only for entries tied to a discrete user interaction. */
  interactionId?: number;
}

function observe(
  type: string,
  callback: (entries: PerformanceEntryList) => void,
  options: Record<string, unknown> = {},
): PerformanceObserver | null {
  try {
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    observer.observe({ type, buffered: true, ...options } as PerformanceObserverInit);
    return observer;
  } catch {
    return null; // Entry type unsupported in this browser.
  }
}

/**
 * Start collecting Core Web Vitals. `report` receives each metric (privacy-safe).
 * Returns a teardown that disconnects the observers. A no-op where
 * PerformanceObserver is unavailable.
 */
export function initWebVitals(report: (vital: WebVital) => void): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => undefined;
  const observers: PerformanceObserver[] = [];

  const lcp = observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last)
      report({ name: 'LCP', value: last.startTime, rating: rateMetric('LCP', last.startTime) });
  });

  let clsValue = 0;
  const cls = observe('layout-shift', (entries) => {
    for (const entry of entries as LayoutShiftEntry[]) {
      if (!entry.hadRecentInput) clsValue += entry.value;
    }
    report({ name: 'CLS', value: clsValue, rating: rateMetric('CLS', clsValue) });
  });
  if (cls) {
    // A pageview with NO layout shifts is a real CLS = 0 sample — the common
    // good case.  Seed it so quiet pageviews reach the p75 aggregate instead of
    // biasing per-route CLS toward only the pages that shifted.  Seeded only
    // when layout-shift observation actually attached: a browser that cannot
    // measure (e.g. WebKit) must not fabricate zeros.
    report({ name: 'CLS', value: 0, rating: rateMetric('CLS', 0) });
  }

  let inpValue = 0;
  const inp = observe(
    'event',
    (entries) => {
      for (const entry of entries as EventTimingEntry[]) {
        // INP measures discrete INTERACTIONS only: entries with an interactionId
        // (> 0). Continuous events (pointermove, scroll) carry none and must not
        // inflate the metric.
        if ((entry.interactionId ?? 0) > 0 && entry.duration > inpValue) {
          inpValue = entry.duration;
          report({ name: 'INP', value: inpValue, rating: rateMetric('INP', inpValue) });
        }
      }
    },
    { durationThreshold: 40 },
  );

  for (const observer of [lcp, cls, inp]) {
    if (observer) observers.push(observer);
  }
  return () => {
    for (const observer of observers) observer.disconnect();
  };
}
