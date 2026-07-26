// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-P.1.1d Web Vitals sink: the nearest-rank p75 math, per-bucket window
// aggregation, target-regression detection (with the noise floor and the
// worst-bucket payload), the ingest consumer (vitals stored, everything
// counted, nothing silently discarded), the scheduler tick (aggregate → alert
// → retention sweeps), and a GATED live-Postgres contract leg for the Drizzle
// adapters.
import type { TelemetryEvent } from '@licio/shared';
import { describe, expect, it, vi } from 'vitest';
import type { JobLeaseStore } from '../identity/job-lease.js';
import {
  aggregateWindow,
  computeVitalAlerts,
  p75,
  WEB_VITAL_TARGETS,
} from '../telemetry/aggregate.js';
import {
  runTelemetryTick,
  SAMPLE_RETENTION_MS,
  startTelemetryScheduler,
  VITALS_WINDOW_MS,
} from '../telemetry/scheduler.js';
import {
  createInMemoryTelemetryServices,
  normalizeRouteBucket,
  SAMPLE_MAX_FUTURE_SKEW_MS,
  SAMPLE_MAX_PAST_SKEW_MS,
  toWebVitalSample,
  VITAL_VALUE_CAPS,
} from '../telemetry/service.js';
import type { WebVitalSample } from '../telemetry/stores.js';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const sample = (over: Partial<WebVitalSample> = {}): WebVitalSample => ({
  metric: 'LCP',
  deviceClass: 'mid',
  connection: '4g',
  route: '/',
  value: 1200,
  at: iso(NOW - 60_000),
  ...over,
});

const vitalEvent = (over: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  name: 'web_vital',
  metric: 'LCP',
  value: 1200,
  rating: 'good',
  bucket: '/stories/$storyId',
  device_class: 'mid',
  connection: '4g',
  at: iso(NOW),
  ...over,
});

describe('p75 (nearest-rank)', () => {
  it('computes the value at rank ⌈0.75·n⌉', () => {
    expect(p75([1, 2, 3, 4])).toBe(3); // ceil(3) = rank 3
    expect(p75([4, 3, 2, 1])).toBe(3); // order-independent
    expect(p75([10])).toBe(10);
    expect(p75([1, 2, 3, 4, 5, 6, 7, 8])).toBe(6); // ceil(6) = rank 6
    expect(p75([])).toBe(0);
  });
});

describe('aggregateWindow', () => {
  it('groups by (metric, device class, connection, route) and stamps the window end', () => {
    const rows = aggregateWindow(
      [
        sample({ value: 1000 }),
        sample({ value: 2000 }),
        sample({ value: 3000, deviceClass: 'low' }),
        sample({ metric: 'CLS', value: 0.05 }),
      ],
      iso(NOW),
    );
    expect(rows).toHaveLength(3);
    const midLcp = rows.find((r) => r.metric === 'LCP' && r.deviceClass === 'mid');
    expect(midLcp?.sampleCount).toBe(2);
    expect(midLcp?.p75).toBe(2000);
    expect(midLcp?.windowEnd).toBe(iso(NOW));
  });
});

describe('computeVitalAlerts', () => {
  it('fires when a metric p75 exceeds its target, naming the worst bucket', () => {
    const slow = Array.from({ length: 12 }, (_, i) =>
      sample({ value: 4000 + i, route: '/stories/$storyId' }),
    );
    const aggregates = aggregateWindow(slow, iso(NOW));
    const alerts = computeVitalAlerts(slow, aggregates);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.metric).toBe('LCP');
    expect(alerts[0]?.target).toBe(WEB_VITAL_TARGETS.LCP);
    expect(alerts[0]?.p75).toBeGreaterThan(WEB_VITAL_TARGETS.LCP);
    expect(alerts[0]?.worst?.route).toBe('/stories/$storyId');
  });

  it('stays quiet below the target and below the noise floor', () => {
    const fast = Array.from({ length: 20 }, () => sample({ value: 800 }));
    expect(computeVitalAlerts(fast, aggregateWindow(fast, iso(NOW)))).toHaveLength(0);
    // Nine slow samples are BELOW the minimum sample floor — no page.
    const few = Array.from({ length: 9 }, () => sample({ value: 9000 }));
    expect(computeVitalAlerts(few, aggregateWindow(few, iso(NOW)))).toHaveLength(0);
  });
});

describe('toWebVitalSample + ingest', () => {
  it('maps a web_vital event with defaults for absent buckets', () => {
    const full = toWebVitalSample(vitalEvent(), NOW);
    expect(full).toEqual({
      metric: 'LCP',
      deviceClass: 'mid',
      connection: '4g',
      route: '/stories/$storyId',
      value: 1200,
      at: iso(NOW),
    });
    const bare = toWebVitalSample(
      vitalEvent({ bucket: undefined, device_class: undefined, connection: undefined }),
      NOW,
    );
    expect(bare?.deviceClass).toBe('unknown');
    expect(bare?.connection).toBe('unknown');
    expect(bare?.route).toBe('unknown');
  });

  it('clamps a forged/skewed client timestamp into the receipt window', () => {
    // The beacon endpoint is unauthenticated: a future-dated sample would
    // satisfy every rolling listSince() read and dodge retention until its
    // future date passed — clamp it to receipt time (+small skew).
    const future = toWebVitalSample(vitalEvent({ at: iso(NOW + 86_400_000) }), NOW);
    expect(Date.parse(future?.at ?? '')).toBeLessThanOrEqual(NOW + SAMPLE_MAX_FUTURE_SKEW_MS);
    const ancient = toWebVitalSample(vitalEvent({ at: iso(NOW - 86_400_000) }), NOW);
    expect(Date.parse(ancient?.at ?? '')).toBeGreaterThanOrEqual(NOW - SAMPLE_MAX_PAST_SKEW_MS);
    // An honestly-delayed hide-flushed beacon keeps its own timestamp.
    const delayed = toWebVitalSample(vitalEvent({ at: iso(NOW - 120_000) }), NOW);
    expect(delayed?.at).toBe(iso(NOW - 120_000));
  });

  it('clamps implausible values to the per-metric cap (unauthenticated beacon)', () => {
    // A forged Number.MAX_VALUE-scale batch must not own the rolling p75.
    const forged = toWebVitalSample(vitalEvent({ value: Number.MAX_VALUE }), NOW);
    expect(forged?.value).toBe(VITAL_VALUE_CAPS.LCP);
    const cls = toWebVitalSample(vitalEvent({ metric: 'CLS', value: 5000 }), NOW);
    expect(cls?.value).toBe(VITAL_VALUE_CAPS.CLS);
    // Honest readings — even slow ones — pass through unchanged.
    const slow = toWebVitalSample(vitalEvent({ value: 30_000 }), NOW);
    expect(slow?.value).toBe(30_000);
  });

  it('normalizes the route bucket against the ROUTE_PATTERNS catalog (allowlist, fail closed)', () => {
    // Members of the shared route-pattern SSOT persist as-is.
    expect(normalizeRouteBucket('/stories/$storyId')).toBe('/stories/$storyId');
    expect(normalizeRouteBucket('/')).toBe('/');
    expect(normalizeRouteBucket('/rooms_/$roomId_/governance')).toBe('/rooms_/$roomId_/governance');
    expect(normalizeRouteBucket(undefined)).toBe('unknown');
    // ANYTHING outside the catalog — a concrete path, an identifier, a
    // handle, a slug, a forged string — must never enter the 90-day series.
    expect(normalizeRouteBucket('/stories/2b7e1516-28ae-d2a6-abf7-158809cf4f3c')).toBe('unknown');
    expect(normalizeRouteBucket('/profile/alice')).toBe('unknown'); // user handle
    expect(normalizeRouteBucket('/rooms/my-private-room')).toBe('unknown'); // room slug
    expect(normalizeRouteBucket('/orders/123456')).toBe('unknown'); // numeric id
    expect(normalizeRouteBucket('not-a-path')).toBe('unknown');
    expect(normalizeRouteBucket('/search?q=secret')).toBe('unknown'); // query strings
    // The mapping applies inside toWebVitalSample.
    const sampleRow = toWebVitalSample(vitalEvent({ bucket: '/stories/123456' }), NOW);
    expect(sampleRow?.route).toBe('unknown');
  });

  it('rejects non-vitals and malformed values; counts every event name', async () => {
    expect(toWebVitalSample(vitalEvent({ metric: 'not-a-vital' }), NOW)).toBeNull();
    expect(toWebVitalSample(vitalEvent({ value: undefined }), NOW)).toBeNull();
    expect(toWebVitalSample(vitalEvent({ value: -5 }), NOW)).toBeNull();
    expect(
      toWebVitalSample({ name: 'navigation', bucket: '/', value: 12, at: iso(NOW) }, NOW),
    ).toBe(null);

    const services = createInMemoryTelemetryServices({ now: () => NOW });
    const accepted = await services.ingest([
      vitalEvent(),
      { name: 'navigation', bucket: '/', value: 12, at: iso(NOW) },
      { name: 'query_error', metric: 'network', count: 1, at: iso(NOW) },
    ]);
    expect(accepted).toBe(3);
    expect(await services.samples.listSince(iso(NOW - 1000))).toHaveLength(1);
    const counts = services.metrics.snapshot();
    expect(counts['telemetry.event.web_vital']).toBe(1);
    expect(counts['telemetry.event.navigation']).toBe(1);
    expect(counts['telemetry.event.query_error']).toBe(1);
  });
});

describe('runTelemetryTick', () => {
  it('aggregates the rolling window, alerts on regressions, and sweeps retention', async () => {
    const alerts: Array<Record<string, unknown>> = [];
    const services = createInMemoryTelemetryServices({
      now: () => NOW,
      alert: (_event, meta) => alerts.push(meta),
    });
    // Twelve slow LCPs inside the window; one ancient sample outside it.
    await services.samples.insert([
      ...Array.from({ length: 12 }, (_, i) => sample({ value: 4000 + i })),
      sample({ at: iso(NOW - SAMPLE_RETENTION_MS - 1000), value: 100 }),
    ]);
    await runTelemetryTick(services, () => {}, NOW);

    const series = await services.aggregates.listSeries('LCP', iso(NOW - VITALS_WINDOW_MS));
    expect(series).toHaveLength(1);
    expect(series[0]?.sampleCount).toBe(12);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.['metric']).toBe('LCP');
    expect(alerts[0]?.['worst_route']).toBe('/');
    // The ancient sample was swept; the in-window samples remain.
    expect(await services.samples.listSince(iso(0))).toHaveLength(12);
  });
});

describe('startTelemetryScheduler', () => {
  it('a lease-store failure is reported and skips the tick (fail closed)', async () => {
    const services = createInMemoryTelemetryServices({ now: () => NOW });
    const tickReads = vi.spyOn(services.samples, 'listSince');
    const failures: string[] = [];
    const lease: JobLeaseStore = {
      tryAcquire: async () => {
        throw new Error('lease store down');
      },
    };
    const stop = startTelemetryScheduler(services, (_err, task) => failures.push(task), 5, {
      lease,
      holder: 'test-holder',
    });
    const deadline = Date.now() + 5_000;
    while (failures.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stop();
    // The failure surfaced through onError as the 'lease' task (never an
    // unhandled rejection), and the tick body never ran.
    expect(failures[0]).toBe('lease');
    expect(tickReads).not.toHaveBeenCalled();
  });
});

// GATED live-Postgres contract for the production adapters.
const DB_URL = process.env['DATABASE_URL'];
describe.skipIf(!DB_URL)('Drizzle Web Vitals stores (live Postgres)', () => {
  it('round-trips samples and aggregates with indexed range sweeps', async () => {
    const { createDbClient, migrationsFolder } = await import('@licio/db');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const { DrizzleWebVitalAggregateStore, DrizzleWebVitalSampleStore } = await import(
      '../telemetry/drizzle-telemetry-stores.js'
    );
    const db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    const samples = new DrizzleWebVitalSampleStore(db);
    const aggregates = new DrizzleWebVitalAggregateStore(db);
    await samples.clear();
    await aggregates.clear();
    try {
      await samples.insert([
        sample({ value: 1000 }),
        sample({ value: 2000, at: iso(NOW - 30_000) }),
        sample({ value: 3000, at: iso(NOW - VITALS_WINDOW_MS - 60_000) }), // outside window
      ]);
      const windowed = await samples.listSince(iso(NOW - VITALS_WINDOW_MS));
      expect(windowed).toHaveLength(2);
      expect(windowed.map((s) => s.value).sort()).toEqual([1000, 2000]);
      expect(await samples.sweepBefore(iso(NOW - VITALS_WINDOW_MS))).toBe(1);

      await aggregates.insert(aggregateWindow(windowed, iso(NOW)));
      const series = await aggregates.listSeries('LCP', iso(NOW - VITALS_WINDOW_MS));
      expect(series).toHaveLength(1);
      expect(series[0]?.p75).toBe(2000);
      expect(series[0]?.sampleCount).toBe(2);
      expect(await aggregates.sweepBefore(iso(NOW + 1000))).toBe(1);
    } finally {
      await samples.clear();
      await aggregates.clear();
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    }
  });
});
