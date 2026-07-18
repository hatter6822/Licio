// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N scheduler (the house lease-guarded pattern): the hourly tick reloads
// the fail-closed config and runs the retention sweep on its own (daily by
// default) cadence.  The config reload runs on EVERY worker (no lease): a
// replica that loses the lease must still pick up an admin's runtime change for
// its own request-path checks (velocity limits, screening cache TTLs), not stay
// on boot-time config until it wins the lease or restarts.  The lease guards
// only the retention SWEEP (at most one executor per window), and retention is
// ALSO enforced at read time by `listExpired`, so a missed sweep never extends
// retention.
import { hostname } from 'node:os';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { runRetentionSweep } from './retention.js';
import { buildCaseDeps, type ComplianceServices } from './services.js';

export type ComplianceSchedulerTask = 'config_reload' | 'retention_sweep' | 'lease';

export const COMPLIANCE_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000; // hourly
const COMPLIANCE_JOB_LEASE = 'scheduler:compliance';

/** The last sweep boundary this process observed (lease-holder local). */
let lastSweepAtMs = 0;

/** Reload the fail-closed runtime config — runs on EVERY worker, no lease — then
 *  re-project any config that other subsystems cache (`afterConfigReload`), so a
 *  losing replica does not keep serving those from stale boot-time values. */
async function reloadComplianceConfig(
  services: ComplianceServices,
  onError: (err: unknown, task: ComplianceSchedulerTask) => void,
  afterConfigReload?: () => void | Promise<void>,
): Promise<void> {
  try {
    await services.reloadConfig();
    await afterConfigReload?.();
  } catch (err) {
    onError(err, 'config_reload');
  }
}

/** The retention sweep on its own cadence — lease-guarded (single executor). */
async function runRetentionSweepTick(
  services: ComplianceServices,
  onError: (err: unknown, task: ComplianceSchedulerTask) => void,
): Promise<void> {
  const nowMs = services.now();
  if (nowMs - lastSweepAtMs >= services.config().retentionSweepIntervalMs) {
    try {
      const summary = await runRetentionSweep({
        caseDeps: buildCaseDeps(services),
        config: services.config,
        log: services.log,
        now: services.now,
      });
      // The marker advances ONLY on a DRAINED sweep: neither a failure nor a
      // leftover backlog may burn the window, or expired cases would stay
      // readable for another full interval (a day by default).  A transient
      // outage or an un-drained page therefore retries on the next tick; the
      // sweep is idempotent, so an extra attempt is free.
      if (summary.drained) lastSweepAtMs = nowMs;
      services.metrics.increment('compliance.retention.deleted', summary.deleted);
      services.metrics.increment('compliance.retention.anonymized', summary.anonymized);
      if (!summary.drained) {
        services.metrics.increment('compliance.retention.not_drained');
        services.alert('compliance.retention.not_drained', {
          errors: summary.errors,
          scheduleRef: services.config().retentionScheduleRef,
        });
      }
    } catch (err) {
      onError(err, 'retention_sweep');
    }
  }
}

/** A full tick (config reload + retention sweep) for a DIRECT / no-lease caller.
 *  The lease scheduler runs the two separately — reload on every worker, sweep
 *  under the lease — so a losing replica never runs on stale config. */
export async function runComplianceTick(
  services: ComplianceServices,
  onError: (err: unknown, task: ComplianceSchedulerTask) => void = () => {},
  afterConfigReload?: () => void | Promise<void>,
): Promise<void> {
  await reloadComplianceConfig(services, onError, afterConfigReload);
  await runRetentionSweepTick(services, onError);
}

export function startComplianceScheduler(
  services: ComplianceServices,
  onError: (err: unknown, task: ComplianceSchedulerTask) => void = () => {},
  intervalMs: number = COMPLIANCE_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
  /** Re-project config that other subsystems cache (e.g. the event-pipeline
   *  retention overrides) — runs on EVERY worker after each reload, so a losing
   *  replica does not keep a stale projection until it wins the lease. */
  afterConfigReload?: () => void | Promise<void>,
): () => void {
  const holder = runner?.holder ?? `${hostname()}:${process.pid}`;
  const leaseTtlMs = Math.max(1, Math.floor(intervalMs * 0.9));
  const tick = async (): Promise<void> => {
    // Config reload on EVERY worker, BEFORE the lease: a replica that loses the
    // lease must still pick up a runtime config change for its request-path
    // checks, not stay on boot-time config until it wins the lease or restarts.
    await reloadComplianceConfig(services, onError, afterConfigReload);
    if (runner) {
      try {
        if (!(await runner.lease.tryAcquire(COMPLIANCE_JOB_LEASE, leaseTtlMs, holder))) return;
      } catch (err) {
        onError(err, 'lease');
        return;
      }
    }
    await runRetentionSweepTick(services, onError);
  };
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  void tick();
  return () => clearInterval(timer);
}

/** Test hook: reset the per-process sweep boundary. */
export function resetComplianceSchedulerForTests(): void {
  lastSweepAtMs = 0;
}
