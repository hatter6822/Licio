// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-P.1.1d store interfaces + in-memory adapters (the house pattern) for the
// Core Web Vitals RUM sink.  Two retention classes by design (§19 privacy +
// the WS-P task's 90-day trend requirement):
//
//   • RAW SAMPLES are short-lived working data: they exist only to compute the
//     rolling-24h p75 and are swept shortly after they age out of the window.
//   • AGGREGATES (p75 per (metric, device class, connection, route) bucket)
//     are the durable 90-day trend series behind regression detection.
//
// Every field is already privacy-safe by the shared telemetry schema: closed
// metric/device/connection enums, the route PATTERN (never a URL), a numeric
// value — no user identifier anywhere.
import type { TelemetryConnection, TelemetryDeviceClass } from '@licio/shared';

export type WebVitalMetric = 'LCP' | 'INP' | 'CLS';

export interface WebVitalSample {
  metric: WebVitalMetric;
  deviceClass: TelemetryDeviceClass;
  connection: TelemetryConnection;
  /** The route PATTERN (e.g. `/stories/$storyId`), never a concrete path. */
  route: string;
  value: number;
  /** Client emit time (ISO-8601). */
  at: string;
}

export interface WebVitalSampleStore {
  insert(samples: readonly WebVitalSample[]): Promise<void>;
  /** All samples at/after `sinceIso` (the rolling-24h aggregation read). */
  listSince(sinceIso: string): Promise<WebVitalSample[]>;
  /** Delete samples older than `beforeIso`; returns the rows removed. */
  sweepBefore(beforeIso: string): Promise<number>;
  clear(): Promise<void>;
}

export interface WebVitalAggregate {
  metric: WebVitalMetric;
  deviceClass: TelemetryDeviceClass;
  connection: TelemetryConnection;
  route: string;
  /** p75 over the rolling 24h window ending at `windowEnd` (nearest-rank). */
  p75: number;
  sampleCount: number;
  /** Window end (ISO-8601); the window is the preceding 24 hours. */
  windowEnd: string;
}

export interface WebVitalAggregateStore {
  insert(aggregates: readonly WebVitalAggregate[]): Promise<void>;
  /** The trend series for one metric since `sinceIso` (windowEnd ascending). */
  listSeries(metric: WebVitalMetric, sinceIso: string): Promise<WebVitalAggregate[]>;
  /** Delete aggregates whose window ended before `beforeIso` (90-day retention). */
  sweepBefore(beforeIso: string): Promise<number>;
  clear(): Promise<void>;
}

export class InMemoryWebVitalSampleStore implements WebVitalSampleStore {
  #rows: WebVitalSample[] = [];

  async insert(samples: readonly WebVitalSample[]): Promise<void> {
    this.#rows.push(...samples.map((s) => ({ ...s })));
  }

  async listSince(sinceIso: string): Promise<WebVitalSample[]> {
    return this.#rows.filter((s) => s.at >= sinceIso).map((s) => ({ ...s }));
  }

  async sweepBefore(beforeIso: string): Promise<number> {
    const before = this.#rows.length;
    this.#rows = this.#rows.filter((s) => s.at >= beforeIso);
    return before - this.#rows.length;
  }

  async clear(): Promise<void> {
    this.#rows = [];
  }
}

export class InMemoryWebVitalAggregateStore implements WebVitalAggregateStore {
  #rows: WebVitalAggregate[] = [];

  async insert(aggregates: readonly WebVitalAggregate[]): Promise<void> {
    this.#rows.push(...aggregates.map((a) => ({ ...a })));
  }

  async listSeries(metric: WebVitalMetric, sinceIso: string): Promise<WebVitalAggregate[]> {
    return this.#rows
      .filter((a) => a.metric === metric && a.windowEnd >= sinceIso)
      .sort((a, b) => a.windowEnd.localeCompare(b.windowEnd))
      .map((a) => ({ ...a }));
  }

  async sweepBefore(beforeIso: string): Promise<number> {
    const before = this.#rows.length;
    this.#rows = this.#rows.filter((a) => a.windowEnd >= beforeIso);
    return before - this.#rows.length;
  }

  async clear(): Promise<void> {
    this.#rows = [];
  }
}
