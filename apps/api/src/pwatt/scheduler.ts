// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The event-pipeline scheduler (WS-E.1.4 / WS-E.2.1a / WS-E.3.2). Hourly tick,
// reusing the WS-D distributed job-lease pattern: every instance ticks, the
// Postgres lease grants at most one executor per window, a crashed holder
// self-heals via lease expiry, and a lease-store outage SKIPS the tick (fail
// closed — read-time expiry and idempotent re-runs still bound everything).
//
// Each tick: score the just-completed windows (1h always; 6h/24h/7d windows
// are recomputed too — idempotent upserts — which also folds in late
// offline-sync events), run the retention sweeps, and reconcile the real-time
// counters against the durable aggregation within the HLL error bound.
import { hostname } from 'node:os';
import { HLL_STANDARD_ERROR } from '../events/hll.js';
import { realtimeWindowStart } from '../events/realtime.js';
import { runRetentionSweeps } from '../events/retention.js';
import type { EventPipelineServices } from '../events/services.js';
import type { JobLeaseStore } from '../identity/job-lease.js';
import type { IdentityServices } from '../identity/services.js';
import { runBehaviorAuthenticityJob } from './behavior.js';
import { DEFAULT_PWATT_RUNTIME_CONFIG, loadPwattRuntimeConfig } from './config.js';
import { runPwattWindow, windowsNeedingCompute } from './scoring.js';

export const EVENT_PIPELINE_SCHEDULER_INTERVAL_MS = 60 * 60_000; // hourly
export const EVENT_PIPELINE_JOB_LEASE = 'events_hourly';

export type SchedulerTask = 'lease' | 'scoring' | 'behavior' | 'retention' | 'reconcile';

/**
 * Reconcile the real-time acceleration layer against the durable aggregation
 * (WS-E.3.2): unique-actor estimates must agree within ~3σ of the HLL error
 * (max(3, 3 × 0.81% × n)). Discrepancies are logged, never silently absorbed —
 * the durable PostgreSQL aggregation is the source of truth.
 */
export async function reconcileRealtimeWindow(
  events: EventPipelineServices,
  windowStartMs: number,
): Promise<{ checked: number; discrepancies: number }> {
  let checked = 0;
  let discrepancies = 0;
  const windowStartIso = new Date(windowStartMs).toISOString();
  for (const itemId of await events.realtime.itemsInWindow(windowStartMs)) {
    const snapshot = await events.realtime.snapshot(itemId, windowStartMs);
    const durable = await events.windowStore.get(itemId, windowStartIso, '1h');
    if (!snapshot || !durable) continue;
    checked += 1;
    const tolerance = Math.max(3, 3 * HLL_STANDARD_ERROR * durable.uniqueActiveUsers);
    if (Math.abs(snapshot.uniqueActors - durable.uniqueActiveUsers) > tolerance) {
      discrepancies += 1;
      events.log('events.realtime.reconciliation_discrepancy', {
        item_id: itemId,
        window_start: windowStartIso,
        realtime_estimate: snapshot.uniqueActors,
        durable_count: durable.uniqueActiveUsers,
        tolerance,
      });
    }
  }
  events.metrics.increment('realtime_reconciliation_checked', checked);
  events.metrics.increment('realtime_reconciliation_discrepancies', discrepancies);
  return { checked, discrepancies };
}

/** One full scheduler tick (exported for tests and the triggered path). */
export async function runEventPipelineTick(
  events: EventPipelineServices,
  identity: IdentityServices,
  onError: (err: unknown, task: SchedulerTask) => void = () => {},
  nowMs: number = events.now(),
): Promise<void> {
  // Load once; fail closed to the reviewed defaults so a config-store hiccup
  // never crashes the whole tick (the behavior job + retention still run).
  let config = DEFAULT_PWATT_RUNTIME_CONFIG;
  try {
    config = await loadPwattRuntimeConfig(events);
  } catch (err) {
    onError(err, 'scoring');
  }
  // Bot-prevention layer 2: refresh every active actor's authenticity assessment
  // (coherence + cross-account duplication clustering; behavior.ts) BEFORE
  // scoring, so the scorer applies assessments computed with the CURRENT behavior
  // config and stamps a `config_hash` that matches it — a behavior-config change
  // takes effect THIS tick, not the next, and replay/audit metadata never
  // misidentifies the calculation. It reads the snapshots PRIOR window runs
  // upserted; this tick's own windows fold during scoring below and feed the next
  // refresh. Its OWN try block — separate from scoring — so a single poison
  // assessment can never starve scoring AND the snapshot/assessment retention
  // pruning.
  try {
    await runBehaviorAuthenticityJob(events, config.behavior, nowMs);
  } catch (err) {
    onError(err, 'behavior');
  }
  try {
    for (const window of await windowsNeedingCompute(events, nowMs)) {
      // Thread the tick's nowMs so account-age + assessment-freshness use the
      // SAME clock the behavior job just ran on (consistent within the tick).
      await runPwattWindow(events, identity, window.startMs, window.size, config, nowMs);
    }
  } catch (err) {
    onError(err, 'scoring');
  }
  try {
    await runRetentionSweeps(events, identity, nowMs);
  } catch (err) {
    onError(err, 'retention');
  }
  try {
    await reconcileRealtimeWindow(events, realtimeWindowStart(nowMs) - 3_600_000);
  } catch (err) {
    onError(err, 'reconcile');
  }
}

/**
 * Start the scheduler. Mirrors startPrivacyScheduler: lease TTL is 90% of the
 * interval (ownership lapses before the next window), the timer is unref'd,
 * and an initial tick runs at startup so overdue work is never deferred a full
 * interval. Returns a stop function.
 */
export function startEventPipelineScheduler(
  events: EventPipelineServices,
  identity: IdentityServices,
  onError: (err: unknown, task: SchedulerTask) => void = () => {},
  intervalMs: number = EVENT_PIPELINE_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const holder = runner?.holder ?? `${hostname()}:${process.pid}`;
  const leaseTtlMs = Math.max(1, Math.floor(intervalMs * 0.9));
  const tick = async (): Promise<void> => {
    if (runner) {
      try {
        if (!(await runner.lease.tryAcquire(EVENT_PIPELINE_JOB_LEASE, leaseTtlMs, holder))) return;
      } catch (err) {
        onError(err, 'lease');
        return; // fail closed: skip the tick, idempotent re-runs catch up
      }
    }
    await runEventPipelineTick(events, identity, onError);
  };
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  void tick();
  return () => clearInterval(timer);
}
