// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-P.1.1d maintenance scheduler (the house lease-guarded pattern): every
// instance ticks hourly; the Postgres job lease grants at most one executor
// per window.  Tasks:
//
//   1. Rolling-24h p75 aggregation per (metric, device class, connection,
//      route) bucket → the durable 90-day trend series, with the
//      `metric.web_vitals.aggregated` observability line.
//   2. Regression detection: any metric whose overall window p75 exceeds its
//      target (LCP 2.5 s / INP 200 ms / CLS 0.1, with a minimum sample floor)
//      fires the alert channel, payload naming the worst-regressing bucket.
//   3. Retention sweeps: raw samples shortly after they age out of the 24h
//      window; aggregates at 90 days.
import { hostname } from 'node:os';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { aggregateWindow, computeVitalAlerts } from './aggregate.js';
import type { TelemetryServices } from './service.js';

export const TELEMETRY_JOB_LEASE = 'telemetry_hourly';
export const TELEMETRY_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;

/** The rolling aggregation window (WS-P.1.1d: 24 hours). */
export const VITALS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Raw samples live one hour past the window (working data only). */
export const SAMPLE_RETENTION_MS = VITALS_WINDOW_MS + 60 * 60 * 1000;
/** Aggregates are the 90-day trend series. */
export const AGGREGATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type TelemetrySchedulerTask = 'aggregate' | 'sweep' | 'lease';

/** One scheduler tick; exported for tests and manual recovery. */
export async function runTelemetryTick(
  services: TelemetryServices,
  onError: (err: unknown, task: TelemetrySchedulerTask) => void = () => {},
  nowMs: number = services.now(),
): Promise<void> {
  const windowEndIso = new Date(nowMs).toISOString();
  try {
    const samples = await services.samples.listSince(
      new Date(nowMs - VITALS_WINDOW_MS).toISOString(),
    );
    if (samples.length > 0) {
      const aggregates = aggregateWindow(samples, windowEndIso);
      await services.aggregates.insert(aggregates);
      services.log('metric.web_vitals.aggregated', {
        buckets: aggregates.length,
        samples: samples.length,
        window_end: windowEndIso,
      });
      for (const alert of computeVitalAlerts(samples, aggregates)) {
        // The WS-P.1.1d regression alert: p75 over target across the rolling
        // window.  Rollback/paging remains a human decision (WS-O binding).
        services.alert('telemetry.web_vitals.regression', {
          metric: alert.metric,
          p75: alert.p75,
          target: alert.target,
          samples: alert.sampleCount,
          worst_route: alert.worst?.route ?? null,
          worst_device_class: alert.worst?.deviceClass ?? null,
          worst_connection: alert.worst?.connection ?? null,
          worst_p75: alert.worst?.p75 ?? null,
        });
      }
    }
  } catch (err) {
    onError(err, 'aggregate');
  }
  try {
    const sweptSamples = await services.samples.sweepBefore(
      new Date(nowMs - SAMPLE_RETENTION_MS).toISOString(),
    );
    const sweptAggregates = await services.aggregates.sweepBefore(
      new Date(nowMs - AGGREGATE_RETENTION_MS).toISOString(),
    );
    if (sweptSamples > 0 || sweptAggregates > 0) {
      services.log('telemetry.retention.swept', {
        samples: sweptSamples,
        aggregates: sweptAggregates,
      });
    }
  } catch (err) {
    onError(err, 'sweep');
  }
}

/** Start the interval runner (lease-guarded in production). */
export function startTelemetryScheduler(
  services: TelemetryServices,
  onError: (err: unknown, task: TelemetrySchedulerTask) => void = () => {},
  intervalMs: number = TELEMETRY_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const tick = async (): Promise<void> => {
    if (runner) {
      try {
        const acquired = await runner.lease.tryAcquire(
          TELEMETRY_JOB_LEASE,
          Math.ceil(intervalMs * 0.9),
          runner.holder ?? hostname(),
        );
        if (!acquired) return;
      } catch (err) {
        onError(err, 'lease');
        return; // fail closed: skip the tick; idempotent tasks catch up next time
      }
    }
    await runTelemetryTick(services, onError);
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
