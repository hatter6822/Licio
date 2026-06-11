// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H batch-tier scheduler (WS-H.1.2f), following the WS-E/F lease-guarded
// pattern: every instance ticks hourly, the Postgres job lease grants at
// most one executor per window, and each task is independent (one failure
// never blocks the others — the fallback wrapper guarantees that per
// invariant too). The nightly tick (hour 0 UTC) additionally runs the
// regression suite against the production algorithm versions and records
// the drift report (WS-H.1.2d-2).

import { runRegressionSuite } from '@licio/invariants';
import type { EventPipelineServices } from '../events/services.js';
import { AlwaysGrantJobLeaseStore, type JobLeaseStore } from '../identity/job-lease.js';
import type { IngestionServices } from '../ingestion/services.js';
import { hourWindow, mapBounded, persistComputations, runGuarded } from './runner.js';
import type { InvariantPlatformServices } from './services.js';
import { GLOBAL_FEED_TARGET_ID } from './services-impl.js';

export const INVARIANTS_JOB_LEASE = 'invariants_hourly';
export const INVARIANTS_SCHEDULER_INTERVAL_MS = 3_600_000;

export type InvariantsSchedulerTask =
  | 'config_reload'
  | 'batch_compute'
  | 'session_sweep'
  | 'nightly_regression';

/** One scheduler tick: config reload → batch tier → sweeps → nightly drift. */
export async function runInvariantsTick(
  invariants: InvariantPlatformServices,
  events: EventPipelineServices,
  ingestion: IngestionServices,
  onError: (err: unknown, task: InvariantsSchedulerTask) => void = () => {},
  nowMs: number = invariants.now(),
): Promise<void> {
  try {
    await invariants.reloadConfig();
  } catch (err) {
    onError(err, 'config_reload');
  }

  try {
    await runBatchTier(invariants, events, ingestion, nowMs);
  } catch (err) {
    onError(err, 'batch_compute');
  }

  try {
    await invariants.sessions.sweepExpired(nowMs);
  } catch (err) {
    onError(err, 'session_sweep');
  }

  // Nightly (00:xx UTC): regression drift report against production code.
  if (new Date(nowMs).getUTCHours() === 0) {
    try {
      const report = runRegressionSuite();
      invariants.log('invariants.regression.nightly', {
        pass: report.pass,
        checks: report.checks.length,
        failures: report.failures.map((f) => `${f.invariant}/${f.dataset}/${f.metric}`),
      });
      events.metrics.increment(
        report.pass ? 'invariants.regression.pass' : 'invariants.regression.drift',
      );
    } catch (err) {
      onError(err, 'nightly_regression');
    }
  }
}

/** The batch tier: run every invariant guarded, persist shadow outputs. */
export async function runBatchTier(
  invariants: InvariantPlatformServices,
  events: EventPipelineServices,
  ingestion: IngestionServices,
  nowMs: number,
): Promise<void> {
  const config = invariants.config();
  const window = hourWindow(nowMs);
  const deps = {
    runMetadata: invariants.runMetadata,
    metrics: events.metrics,
    log: invariants.log,
    now: invariants.now,
  };

  // Target assembly per invariant family.
  const recentStories = await ingestion.stories.listRecent(50);
  const storyTargets = recentStories.map((s) => ({
    targetType: 'story' as const,
    targetId: s.storyId,
  }));
  const threadTargets: Array<{ targetType: 'thread'; targetId: string }> = [];
  for (const story of recentStories.slice(0, 25)) {
    const thread = await ingestion.stories.getThreadByStoryId(story.storyId);
    if (thread) threadTargets.push({ targetType: 'thread', targetId: thread.threadId });
  }
  const feedTarget = { targetType: 'feed' as const, targetId: GLOBAL_FEED_TARGET_ID };

  const jobs: Array<() => Promise<void>> = [
    async () => {
      const run = await runGuarded(
        deps,
        'MERI',
        invariants.meri.getCard().version,
        'batch',
        feedTarget,
        config.wrapperTimeoutMs,
        () => invariants.meri.computeBatch([feedTarget], window),
      );
      if (run.ok) {
        invariants.meri.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.meri.health.observeError();
    },
    async () => {
      // MFCI batch: the hottest recent story (cap: 3 targets per tick).
      const targets = storyTargets.slice(0, 3);
      if (targets.length === 0) return;
      const run = await runGuarded(
        deps,
        'MFCI',
        invariants.mfci.getCard().version,
        'batch',
        targets[0] ?? null,
        config.wrapperTimeoutMs,
        () => invariants.mfci.computeBatch(targets, window),
      );
      if (run.ok) {
        invariants.mfci.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.mfci.health.observeError();
    },
    async () => {
      const run = await runGuarded(
        deps,
        'GWEI',
        invariants.gwei.getCard().version,
        'batch',
        null,
        config.wrapperTimeoutMs,
        () => invariants.gwei.computeBatch([], window),
      );
      if (run.ok) {
        invariants.gwei.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.gwei.health.observeError();
    },
    async () => {
      const run = await runGuarded(
        deps,
        'SCOI',
        invariants.scoi.getCard().version,
        'batch',
        null,
        config.wrapperTimeoutMs,
        () => invariants.scoi.computeBatch(storyTargets, window),
      );
      if (run.ok) {
        invariants.scoi.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.scoi.health.observeError();
    },
    async () => {
      const run = await runGuarded(
        deps,
        'PHI',
        invariants.phi.getCard().version,
        'batch',
        null,
        config.wrapperTimeoutMs,
        () => invariants.phi.computeBatch([], window),
      );
      if (run.ok) {
        invariants.phi.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.phi.health.observeError();
    },
    async () => {
      const run = await runGuarded(
        deps,
        'hodge_tension',
        invariants.hodge.getCard().version,
        'batch',
        null,
        config.wrapperTimeoutMs,
        () => invariants.hodge.computeBatch(threadTargets, window),
      );
      if (run.ok) {
        invariants.hodge.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.hodge.health.observeError();
    },
    async () => {
      const run = await runGuarded(
        deps,
        'tropical_cascade',
        invariants.tropical.getCard().version,
        'batch',
        null,
        config.wrapperTimeoutMs,
        () => invariants.tropical.computeBatch([], window),
      );
      if (run.ok) {
        invariants.tropical.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.tropical.health.observeError();
    },
    async () => {
      const run = await runGuarded(
        deps,
        'braid_dynamics',
        invariants.braid.getCard().version,
        'batch',
        null,
        config.wrapperTimeoutMs,
        () => invariants.braid.computeBatch([], window),
      );
      if (run.ok) {
        invariants.braid.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.braid.health.observeError();
    },
    async () => {
      const run = await runGuarded(
        deps,
        'reeb_landscape',
        invariants.reeb.getCard().version,
        'batch',
        null,
        config.wrapperTimeoutMs,
        () => invariants.reeb.computeBatch([], window),
      );
      if (run.ok) {
        invariants.reeb.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.reeb.health.observeError();
    },
    async () => {
      const run = await runGuarded(
        deps,
        'counterfactual_defect',
        invariants.cid.getCard().version,
        'batch',
        null,
        config.wrapperTimeoutMs,
        () => invariants.cid.computeBatch([], window),
      );
      if (run.ok) {
        invariants.cid.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.cid.health.observeError();
    },
    async () => {
      const run = await runGuarded(
        deps,
        'path_signature_wellbeing',
        invariants.pathsig.getCard().version,
        'batch',
        null,
        config.wrapperTimeoutMs,
        () => invariants.pathsig.computeBatch([], window),
      );
      if (run.ok) {
        invariants.pathsig.health.observe(run.durationMs, run.outputs);
        await persistComputations(events.invariantStore, deps, run.outputs);
      } else invariants.pathsig.health.observeError();
    },
  ];
  // Bounded concurrency: the batch tier may never starve real-time work.
  await mapBounded(jobs, config.batchConcurrency, (job) => job());
}

/** Start the hourly scheduler under the distributed lease. */
export function startInvariantsScheduler(
  invariants: InvariantPlatformServices,
  events: EventPipelineServices,
  ingestion: IngestionServices,
  onError: (err: unknown, task: InvariantsSchedulerTask | 'lease') => void = () => {},
  intervalMs: number = INVARIANTS_SCHEDULER_INTERVAL_MS,
  runner: { lease: JobLeaseStore; holder?: string } = { lease: new AlwaysGrantJobLeaseStore() },
): () => void {
  const holder = runner.holder ?? `invariants-${Math.random().toString(36).slice(2, 10)}`;
  const timer = setInterval(async () => {
    try {
      const granted = await runner.lease.tryAcquire(
        INVARIANTS_JOB_LEASE,
        Math.floor(intervalMs * 0.9),
        holder,
      );
      if (!granted) return;
    } catch (err) {
      onError(err, 'lease');
      return; // fail closed: no lease, no tick
    }
    await runInvariantsTick(invariants, events, ingestion, onError);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
