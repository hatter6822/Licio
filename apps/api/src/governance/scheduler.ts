// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U governance maintenance scheduler (the house lease-guarded pattern, like
// ranking/scheduler.ts): every instance ticks hourly; a Postgres job lease grants
// at most one executor per window; a crashed holder's lease expires for the next
// claimant. The single task drives the time-based steward-election lifecycle
// (ADR-7): open an election for each seat whose term has elapsed, and settle each
// open election whose voting window has closed (kernel-tallied, fail-safe). The
// eligible-voter count is injected (a soft cross-context read of room membership)
// so the governance runtime never imports the forum/ranking context.

import { hostname } from 'node:os';
import type { JobLeaseStore } from '../identity/job-lease.js';
import type { GovernanceService } from './service.js';

export const GOVERNANCE_JOB_LEASE = 'governance_hourly';
export const GOVERNANCE_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;

export type GovernanceSchedulerTask = 'election_lifecycle' | 'ratification_lifecycle';

export interface GovernanceSchedulerDeps {
  service: GovernanceService;
  /** Eligible voters for a room's election/ratification quorum (soft cross-context read). */
  eligibleVoterCount: (roomId: string) => Promise<number>;
  /** Whether a user is currently a member of a room (soft cross-context read) — used
   *  to re-validate an election winner is still a member before seating them. */
  isRoomMember?: (roomId: string, userId: string) => Promise<boolean>;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

/** One scheduler tick; exported for tests and manual recovery. */
export async function runGovernanceTick(
  deps: GovernanceSchedulerDeps,
  onError: (err: unknown, task: GovernanceSchedulerTask) => void = () => {},
  nowMs: number = deps.now(),
): Promise<void> {
  try {
    const { scheduled, settled } = await deps.service.runElectionLifecycle(
      deps.eligibleVoterCount,
      nowMs,
      deps.isRoomMember,
    );
    if (scheduled > 0 || settled > 0) {
      deps.log('governance.election_lifecycle', { scheduled, settled });
    }
  } catch (err) {
    onError(err, 'election_lifecycle');
  }
  try {
    const { settled, activated } = await deps.service.runRatificationLifecycle(nowMs);
    if (settled > 0) {
      deps.log('governance.ratification_lifecycle', { settled, activated });
    }
  } catch (err) {
    onError(err, 'ratification_lifecycle');
  }
}

/** Start the interval runner (lease-guarded in production). */
export function startGovernanceScheduler(
  deps: GovernanceSchedulerDeps,
  onError: (err: unknown, task: GovernanceSchedulerTask) => void = () => {},
  intervalMs: number = GOVERNANCE_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const timer = setInterval(async () => {
    if (!runner) {
      await runGovernanceTick(deps, onError);
      return;
    }
    const acquired = await runner.lease.tryAcquire(
      GOVERNANCE_JOB_LEASE,
      Math.ceil(intervalMs * 0.9),
      runner.holder ?? hostname(),
    );
    if (acquired) await runGovernanceTick(deps, onError);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
