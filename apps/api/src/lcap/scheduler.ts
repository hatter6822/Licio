// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hourly LCAP maintenance under its own Postgres job lease (`lcap_checkpoints_hourly`
// — the WS-D/WS-E distributed-runner pattern: every instance ticks, at most one
// executes per window, a crashed holder's lease expires for the next claimant, and a
// lease failure SKIPS the tick — the work is idempotent, so the next tick catches up):
//
//   • §24.1 checkpoint issuance (WS-R.9.2b / WS-R.12.1c "checkpoint trigger"): issue a
//     fresh authority-signed `room_checkpoint` for every room whose log grew since its
//     last one.  A room this node holds no room-authority SIGNING key for is skipped
//     (no churn), so a node with no signers configured ticks as a harmless no-op.
import { hostname } from 'node:os';
import type { JobLeaseStore } from '../identity/job-lease.js';
import type { LcapIngestServer } from './server-ingest.js';

export const LCAP_JOB_LEASE = 'lcap_checkpoints_hourly';
export const LCAP_SCHEDULER_INTERVAL_MS = 3_600_000;

export type LcapSchedulerTask = 'lease' | 'checkpoint_issuance';

/** One full maintenance tick (exported for tests). */
export async function runLcapTick(
  server: LcapIngestServer,
  onError: (err: unknown, task: LcapSchedulerTask) => void = () => {},
): Promise<readonly string[]> {
  try {
    return await server.issueAllCheckpoints();
  } catch (err) {
    onError(err, 'checkpoint_issuance');
    return [];
  }
}

/** Start the hourly runner (the WS-E scheduler shape; returns a stopper). */
export function startLcapScheduler(
  server: LcapIngestServer,
  onError: (err: unknown, task: LcapSchedulerTask) => void = () => {},
  intervalMs: number = LCAP_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const holder = runner?.holder ?? `${hostname()}:${process.pid}`;
  const leaseTtlMs = Math.max(1, Math.floor(intervalMs * 0.9));
  const tick = async (): Promise<void> => {
    if (runner) {
      try {
        if (!(await runner.lease.tryAcquire(LCAP_JOB_LEASE, leaseTtlMs, holder))) return;
      } catch (err) {
        onError(err, 'lease');
        return; // fail closed: skip the tick; idempotent issuance catches up next time
      }
    }
    await runLcapTick(server, onError);
  };
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  void tick();
  return () => clearInterval(timer);
}
