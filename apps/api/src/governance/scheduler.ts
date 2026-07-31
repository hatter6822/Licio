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
import type {
  DeferredRemoderationApplier,
  GovernanceService,
  ModerationContextLoader,
} from './service.js';

export const GOVERNANCE_JOB_LEASE = 'governance_hourly';
export const GOVERNANCE_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;
/** Default cap on deferred re-moderation items drained per tick. */
export const REMODERATION_SWEEP_LIMIT = 100;

export type GovernanceSchedulerTask =
  | 'election_lifecycle'
  | 'ratification_lifecycle'
  | 'remoderation_lifecycle'
  | 'admission_retry'
  | 'adjudication_repin'
  | 'moderation_readmission';

export interface GovernanceSchedulerDeps {
  service: GovernanceService;
  /** Eligible voters for a room's election/ratification quorum (soft cross-context read). */
  eligibleVoterCount: (roomId: string, asOf: string) => Promise<number>;
  /** Whether a user is currently a member of a room (soft cross-context read) — used
   *  to re-validate an election winner is still a member before seating them. */
  isRoomMember?: (roomId: string, userId: string) => Promise<boolean>;
  /** WS-U ADR-9 deferred re-moderation CONTEXT LOADER: reconstruct a contribution's
   *  moderation context from the live stores at retry (the queue holds no content).
   *  Absent ⇒ the deferred-re-moderation sweep is skipped entirely (items stay
   *  queued until a node with the loader ticks). */
  loadModerationContext?: ModerationContextLoader;
  /** WS-U ADR-9 deferred re-moderation re-seam: RAISE a contribution whose deferred
   *  judgment finally decided a restriction (floor-dominant). Absent/null ⇒ the
   *  sweep still runs but keeps an `applied` item queued (no forum bound to raise
   *  it), so the judgment is never silently dropped. */
  applyDeferredRemoderation?: DeferredRemoderationApplier | null;
  /** Max deferred re-moderation items drained per tick (default REMODERATION_SWEEP_LIMIT). */
  remoderationSweepLimit?: number;
  /** The FREEZE reader for a newly scheduled election: the electorate count AND the
   *  instant it was measured at, from one read.  Distinct from `eligibleVoterCount`,
   *  which answers about an election's ALREADY-RECORDED open for the settle
   *  fallback — a different question, and rightly a different read.  Absent ⇒ a
   *  scheduled election freezes a zero denominator, as before. */
  measureElectorate?: (roomId: string) => Promise<{ count: number; asOf: string }>;
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
      deps.measureElectorate,
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
  if (deps.loadModerationContext) {
    try {
      // WS-U ADR-9: drain the deferred re-moderation queue — reconstruct each
      // outage-deferred contribution's context from the live stores, re-run the
      // model, and on a decided restriction raise it to human review post-hoc (the
      // model's judgment is delayed, never dropped).
      const swept = await deps.service.sweepPendingRemoderation(
        deps.loadModerationContext,
        deps.applyDeferredRemoderation ?? null,
        deps.remoderationSweepLimit ?? REMODERATION_SWEEP_LIMIT,
      );
      if (swept.swept > 0) {
        deps.log('governance.remoderation_lifecycle', { ...swept });
      }
    } catch (err) {
      onError(err, 'remoderation_lifecycle');
    }
  }
  try {
    // WS-U ADR-9 review: retry admission for models left `evaluating` by a transient
    // in-room-proposer outage, so a flaky backend never permanently rejects a bundle.
    const { retried, resolved } = await deps.service.reEvaluateStuckAdmissions();
    if (retried > 0) {
      deps.log('governance.admission_retry', { retried, resolved });
    }
  } catch (err) {
    onError(err, 'admission_retry');
  }
  try {
    // The role split: heal the ADJUDICATION pin of approved `debate.judge`
    // bundles whose pin no longer matches the live adjudication backend (rows
    // approved before the split, lane-model swaps) — a passing validity
    // re-probe is exactly that lane's re-admission, so the room's debate leg
    // recovers without demoting the approved model.
    const { mismatched, repinned } = await deps.service.repinAdjudication();
    if (mismatched > 0) {
      deps.log('governance.adjudication_repin', { mismatched, repinned });
    }
  } catch (err) {
    onError(err, 'adjudication_repin');
  }
  try {
    // The MODERATION re-admission sweep: an approved model whose moderation
    // pin no longer matches the live backend (a lane/default upgrade, a URL
    // move, a dialect/prompt-version bump) is re-run through the FULL k-of-N
    // floor evaluation and re-pinned on a clean pass — without this, a lane
    // change would strand every approved room on the platform baseline
    // forever (the identical bundle is digest-locked against re-proposal).
    const { mismatched, readmitted, refused } = await deps.service.readmitModeration();
    if (mismatched > 0) {
      deps.log('governance.moderation_readmission', { mismatched, readmitted, refused });
    }
  } catch (err) {
    onError(err, 'moderation_readmission');
  }
}

/** Start the interval runner (lease-guarded in production). */
export function startGovernanceScheduler(
  deps: GovernanceSchedulerDeps,
  // `'lease'` widens the channel exactly as the ai-governance and invariants
  // schedulers already do, so a lease failure is REPORTED rather than lost.
  onError: (err: unknown, task: GovernanceSchedulerTask | 'lease') => void = () => {},
  intervalMs: number = GOVERNANCE_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const timer = setInterval(async () => {
    if (!runner) {
      await runGovernanceTick(deps, onError);
      return;
    }
    // The lease acquire is the one await in this callback nothing else guards:
    // `runGovernanceTick` catches per task, but a `tryAcquire` rejection (any
    // transient Postgres error — the Drizzle store issues raw SQL and catches
    // nothing) escapes an async `setInterval` callback whose promise nobody
    // holds, and Node's default `--unhandled-rejections=throw` then takes the
    // whole BFF down over a blip in a background job.  Every sibling scheduler
    // already fails closed here; this one and the debate scheduler were the two
    // that did not.
    let acquired: boolean;
    try {
      acquired = await runner.lease.tryAcquire(
        GOVERNANCE_JOB_LEASE,
        Math.ceil(intervalMs * 0.9),
        runner.holder ?? hostname(),
      );
    } catch (err) {
      onError(err, 'lease');
      return; // fail closed: no lease, no tick — the next interval retries
    }
    if (acquired) await runGovernanceTick(deps, onError);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
