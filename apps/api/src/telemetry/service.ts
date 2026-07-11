// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-P.1.1d telemetry service container (the house pattern): in-memory stores
// by default (dev/tests), the gated Drizzle adapters swapped in at boot, and a
// module singleton for the ingest route.  `ingest` is the REAL consumer behind
// POST /v1/telemetry: `web_vital` events land in the sample store for the
// rolling-p75 aggregation; every other (already schema-validated) event name
// counts into the in-process observability counters — nothing is silently
// discarded any more.
import type { TelemetryConnection, TelemetryDeviceClass, TelemetryEvent } from '@licio/shared';
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

/** Map a validated `web_vital` telemetry event to a sample row, or null. */
export function toWebVitalSample(event: TelemetryEvent): WebVitalSample | null {
  if (event.name !== 'web_vital') return null;
  if (event.metric === undefined || !VITAL_METRICS.has(event.metric)) return null;
  if (event.value === undefined || !Number.isFinite(event.value) || event.value < 0) return null;
  return {
    metric: event.metric as WebVitalMetric,
    deviceClass: (event.device_class ?? 'unknown') as TelemetryDeviceClass,
    connection: (event.connection ?? 'unknown') as TelemetryConnection,
    // `bucket` carries the route PATTERN by contract; absent ⇒ 'unknown'.
    route: event.bucket ?? 'unknown',
    value: event.value,
    at: event.at,
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
      for (const event of events) {
        metrics.increment(`telemetry.event.${event.name}`);
        const sample = toWebVitalSample(event);
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

/** Test helper: drop the singleton so the next getter builds a fresh one. */
export function resetTelemetryServicesForTests(): void {
  singleton = null;
}
