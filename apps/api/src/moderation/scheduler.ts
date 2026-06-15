// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J lease-guarded maintenance tick (the WS-E/F/I scheduler pattern): reloads
// fail-closed config, auto-lifts expired mutes (WS-J.1.2b), prunes the ephemeral
// submission window, and emits queue-depth / SLA-breach observability gauges
// (WS-J.2.1a).  One instance runs per window via the distributed lease.
import { hostname } from 'node:os';
import type { JobLeaseStore } from '../identity/job-lease.js';
import type { ModerationServices } from './services.js';

export type ModerationSchedulerTask =
  | 'lease'
  | 'config_reload'
  | 'mute_expiry'
  | 'submission_prune'
  | 'queue_metrics';

export const MODERATION_JOB_LEASE = 'moderation:maintenance';
export const MODERATION_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000; // hourly

export async function runModerationTick(
  services: ModerationServices,
  onError: (err: unknown, task: ModerationSchedulerTask) => void = () => {},
): Promise<void> {
  try {
    await services.reloadConfig();
  } catch (err) {
    onError(err, 'config_reload');
  }

  const nowMs = services.now();
  const nowIso = new Date(nowMs).toISOString();

  try {
    const lifted = await services.mutes.expireDue(nowIso);
    if (lifted > 0) {
      services.metrics.increment('mutes.expired', lifted);
      services.log('moderation.mutes_expired', { lifted });
    }
  } catch (err) {
    onError(err, 'mute_expiry');
  }

  try {
    // Prune the ephemeral submission window to the largest detection horizon.
    const config = services.config();
    const horizonMs =
      Math.max(config.spamVelocityWindowSeconds, config.duplicateFloodWindowSeconds) * 1000;
    services.submissions.prune(nowMs, horizonMs);
  } catch (err) {
    onError(err, 'submission_prune');
  }

  try {
    const open = await services.cases.list({
      status: ['new', 'in_progress', 'escalated'],
      limit: 1_000,
    });
    let breached = 0;
    let emergencyOpen = 0;
    for (const c of open) {
      if (c.routedTo === 'emergency') emergencyOpen += 1;
      if (Date.parse(c.slaDueAt) <= nowMs) breached += 1;
    }
    services.metrics.increment('queue.open', open.length);
    services.metrics.increment('queue.emergency_open', emergencyOpen);
    services.metrics.increment('queue.sla_breached', breached);
  } catch (err) {
    onError(err, 'queue_metrics');
  }
}

/** Start the hourly tick; returns a stop function (timer is unref'd). */
export function startModerationScheduler(
  services: ModerationServices,
  onError: (err: unknown, task: ModerationSchedulerTask) => void = () => {},
  intervalMs: number = MODERATION_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const holder = runner?.holder ?? `${hostname()}:${process.pid}`;
  const leaseTtlMs = Math.max(1, Math.floor(intervalMs * 0.9));
  const tick = async (): Promise<void> => {
    if (runner) {
      try {
        if (!(await runner.lease.tryAcquire(MODERATION_JOB_LEASE, leaseTtlMs, holder))) return;
      } catch (err) {
        onError(err, 'lease');
        return;
      }
    }
    await runModerationTick(services, onError);
  };
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  void tick();
  return () => clearInterval(timer);
}
