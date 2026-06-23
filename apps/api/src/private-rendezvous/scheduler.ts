// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.6 — the rendezvous expiry sweep under its own Postgres job lease
// (`private_rendezvous_sweep` — the WS-D/WS-E distributed-runner pattern: every
// instance ticks, at most one executes per window, a crashed holder's lease
// expires for the next claimant, and a lease failure SKIPS the tick — the sweep
// is idempotent, so the next tick catches up).
//
// `announce`/`signal` accept arbitrary blind ids, so without an active reaper an
// abusive (or merely steady) flow would retain presence rows / signals well past
// the advertised short rendezvous window (§15.3.2): `poll`/`drainSignals` already
// FILTER expired rows, but the rows themselves linger until something deletes
// them.  This tick deletes them on a sub-window cadence (the in-memory and
// Postgres adapters both implement `sweepExpired`).
import { hostname } from 'node:os';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { getRendezvousService, type RendezvousService } from './service.js';

export const RENDEZVOUS_JOB_LEASE = 'private_rendezvous_sweep';
/** Sweep well within the 5–30 min TTL window so expired rows do not accumulate. */
export const RENDEZVOUS_SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;

export type RendezvousSchedulerTask = 'lease' | 'sweep';

/** One sweep tick (exported for tests): delete every expired record + signal. */
export async function runRendezvousTick(
  service: RendezvousService,
  onError: (err: unknown, task: RendezvousSchedulerTask) => void = () => {},
): Promise<number> {
  try {
    return await service.sweep();
  } catch (err) {
    onError(err, 'sweep');
    return 0;
  }
}

/** Start the periodic expiry sweep (the WS-E scheduler shape; returns a stopper). */
export function startRendezvousScheduler(
  service: RendezvousService = getRendezvousService(),
  onError: (err: unknown, task: RendezvousSchedulerTask) => void = () => {},
  intervalMs: number = RENDEZVOUS_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const holder = runner?.holder ?? `${hostname()}:${process.pid}`;
  const leaseTtlMs = Math.max(1, Math.floor(intervalMs * 0.9));
  const tick = async (): Promise<void> => {
    if (runner) {
      try {
        if (!(await runner.lease.tryAcquire(RENDEZVOUS_JOB_LEASE, leaseTtlMs, holder))) return;
      } catch (err) {
        onError(err, 'lease');
        return; // fail closed: skip the tick; the idempotent sweep catches up next time
      }
    }
    await runRendezvousTick(service, onError);
  };
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  void tick();
  return () => clearInterval(timer);
}
