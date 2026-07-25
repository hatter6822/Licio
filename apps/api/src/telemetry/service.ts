// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-P.1.1d telemetry service container (the house pattern): in-memory stores
// by default (dev/tests), the gated Drizzle adapters swapped in at boot, and a
// module singleton for the ingest route.  `ingest` is the REAL consumer behind
// POST /v1/telemetry: `web_vital` events land in the sample store for the
// rolling-p75 aggregation; every other (already schema-validated) event name
// counts into the in-process observability counters — nothing is silently
// discarded any more.
import {
  ROUTE_PATTERN_SET,
  type TelemetryConnection,
  type TelemetryDeviceClass,
  type TelemetryEvent,
} from '@licio/shared';
import {
  InMemoryWebVitalAggregateStore,
  InMemoryWebVitalSampleStore,
  type WebVitalAggregateStore,
  type WebVitalMetric,
  type WebVitalSample,
  type WebVitalSampleStore,
} from './stores.js';

/** In-process per-event-name counters (no PII; observability only). */
export class TelemetryMetrics {
  readonly #counts = new Map<string, number>();
  increment(name: string, by = 1): void {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + by);
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#counts);
  }
  clear(): void {
    this.#counts.clear();
  }
}

export interface TelemetryServices {
  samples: WebVitalSampleStore;
  aggregates: WebVitalAggregateStore;
  metrics: TelemetryMetrics;
  /** Consume one validated batch; returns the number of events accepted. */
  ingest(events: readonly TelemetryEvent[]): Promise<number>;
  log: (event: string, meta: Record<string, unknown>) => void;
  /** Regression-alert channel (wired to logger.warn at boot; paging is WS-O). */
  alert: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export interface TelemetryServicesOptions {
  log?: (event: string, meta: Record<string, unknown>) => void;
  alert?: (event: string, meta: Record<string, unknown>) => void;
  now?: () => number;
}

const VITAL_METRICS: ReadonlySet<string> = new Set(['LCP', 'INP', 'CLS']);

/** Per-metric plausibility CAPS (the beacon is unauthenticated): a forged or
 *  broken client sending `Number.MAX_VALUE`-scale values would otherwise own
 *  the rolling p75 and the regression alert until retention caught up.  Caps
 *  sit far past any honest reading (worst real LCP/INP are tens of seconds;
 *  CLS 'poor' starts at 0.25) so clamping preserves the "very bad" signal
 *  while bounding the poison. */
export const VITAL_VALUE_CAPS: Record<WebVitalMetric, number> = {
  LCP: 120_000,
  INP: 60_000,
  CLS: 100,
};

/** `bucket` carries a route PATTERN by contract, but the schema only bounds
 *  it to a short string and the endpoint is unauthenticated — so the contract
 *  is enforced HERE before anything persists into the 90-day per-route
 *  series: only a member of the canonical route-pattern catalog (the
 *  `ROUTE_PATTERNS` SSOT in @licio/shared, drift-tested against the generated
 *  route tree in apps/web) survives.  A concrete path, a handle, a slug, or
 *  any forged string buckets as 'unknown'. */
export function normalizeRouteBucket(bucket: string | undefined): string {
  return bucket !== undefined && ROUTE_PATTERN_SET.has(bucket) ? bucket : 'unknown';
}

/** Client clocks drift and the beacon endpoint is unauthenticated, so the
 *  client-stamped `at` is CLAMPED into a tight window around server receipt:
 *  a forged/skewed timestamp can neither future-date a sample past every
 *  retention sweep (poisoning the rolling p75 indefinitely) nor pre-age it
 *  out of the window.  The past allowance covers a hide-flushed beacon that
 *  sat in a background tab for a while. */
export const SAMPLE_MAX_PAST_SKEW_MS = 15 * 60 * 1000;
export const SAMPLE_MAX_FUTURE_SKEW_MS = 60 * 1000;

/** Map a validated `web_vital` telemetry event to a sample row, or null. */
export function toWebVitalSample(
  event: TelemetryEvent,
  nowMs: number = Date.now(),
): WebVitalSample | null {
  if (event.name !== 'web_vital') return null;
  if (event.metric === undefined || !VITAL_METRICS.has(event.metric)) return null;
  if (event.value === undefined || !Number.isFinite(event.value) || event.value < 0) return null;
  const clientAt = Date.parse(event.at);
  const clampedAt = Number.isFinite(clientAt)
    ? Math.min(
        Math.max(clientAt, nowMs - SAMPLE_MAX_PAST_SKEW_MS),
        nowMs + SAMPLE_MAX_FUTURE_SKEW_MS,
      )
    : nowMs;
  const metric = event.metric as WebVitalMetric;
  return {
    metric,
    deviceClass: (event.device_class ?? 'unknown') as TelemetryDeviceClass,
    connection: (event.connection ?? 'unknown') as TelemetryConnection,
    route: normalizeRouteBucket(event.bucket),
    // Clamped to the per-metric plausibility cap (see VITAL_VALUE_CAPS).
    value: Math.min(event.value, VITAL_VALUE_CAPS[metric]),
    at: new Date(clampedAt).toISOString(),
  };
}

/** A fresh, fully in-memory telemetry bundle (tests/dev; prod swaps adapters). */
export function createInMemoryTelemetryServices(
  options: TelemetryServicesOptions = {},
): TelemetryServices {
  const metrics = new TelemetryMetrics();
  const services: TelemetryServices = {
    samples: new InMemoryWebVitalSampleStore(),
    aggregates: new InMemoryWebVitalAggregateStore(),
    metrics,
    async ingest(events: readonly TelemetryEvent[]): Promise<number> {
      const vitals: WebVitalSample[] = [];
      const receivedAt = services.now();
      for (const event of events) {
        metrics.increment(`telemetry.event.${event.name}`);
        const sample = toWebVitalSample(event, receivedAt);
        if (sample) vitals.push(sample);
      }
      if (vitals.length > 0) await services.samples.insert(vitals);
      return events.length;
    },
    log: options.log ?? (() => {}),
    alert: options.alert ?? (() => {}),
    now: options.now ?? Date.now,
  };
  return services;
}

let singleton: TelemetryServices | null = null;

/** The process-wide telemetry services (in-memory until boot swaps adapters). */
export function getTelemetryServices(): TelemetryServices {
  if (!singleton) singleton = createInMemoryTelemetryServices();
  return singleton;
}

/** Install the boot-wired (or a test) container. */
export function setTelemetryServices(next: TelemetryServices): void {
  singleton = next;
}
