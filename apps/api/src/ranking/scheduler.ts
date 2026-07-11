// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I maintenance scheduler (the house lease-guarded pattern): every
// instance ticks hourly; the Postgres job lease grants at most one executor
// per window; a crashed holder's lease expires for the next claimant. Tasks:
//
//   1. Feature-store batch refresh (WS-I.2.1d batch path).
//   2. Decision-log retention sweep (§22.4: 180–365 days).
//   3. Replay-regression sample (WS-I.2.5b): re-rank a sample of recent
//      decisions at their recorded versions; ANY mismatch is alerting
//      evidence that a deploy changed ranking arithmetic.
//   4. Runtime-config reload (picks up validated steward writes).

import { hostname } from 'node:os';
import { EXPLANATION_TEMPLATES } from '@licio/ranking';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { runFeatureBatch } from './features.js';
import { replayDecision } from './service.js';
import type { RankingServices } from './services.js';

export const RANKING_JOB_LEASE = 'ranking_hourly';
export const RANKING_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;

export type RankingSchedulerTask =
  | 'feature_batch'
  | 'decision_log_sweep'
  | 'replay_regression'
  | 'config_reload'
  | 'lease';

/** One scheduler tick; exported for tests and manual recovery. */
export async function runRankingTick(
  services: RankingServices,
  onError: (err: unknown, task: RankingSchedulerTask) => void = () => {},
  nowMs: number = services.now(),
): Promise<void> {
  try {
    await services.reloadConfig();
  } catch (err) {
    onError(err, 'config_reload');
  }
  const config = services.config();
  try {
    await runFeatureBatch(
      {
        events: services.events,
        ingestion: services.ingestion,
        invariants: services.invariants,
        featureStore: services.featureStore,
        log: services.log,
        now: services.now,
      },
      config.featureBatchLimit,
      config.featureStaleHours,
    );
  } catch (err) {
    onError(err, 'feature_batch');
  }
  try {
    const removed = await services.decisionLogs.sweepExpired(new Date(nowMs).toISOString());
    if (removed > 0) services.log('ranking.decision_log.swept', { removed });
  } catch (err) {
    onError(err, 'decision_log_sweep');
  }
  try {
    if (config.replaySampleSize > 0) {
      const recent = await services.decisionLogs.query({ limit: config.replaySampleSize });
      let mismatches = 0;
      let unknownTemplates = 0;
      for (const log of recent.logs) {
        const result = await replayDecision(services, log.request_id);
        if (!result.match) mismatches += 1;
        // Explanation-consistency check (WS-I.2.6b observability): every
        // logged explanation template must still exist in the registry — a
        // removed/renamed template would silently orphan served reasons.
        for (const templateId of Object.values(log.explanation_ids)) {
          if (!EXPLANATION_TEMPLATES.has(templateId)) unknownTemplates += 1;
        }
      }
      if (mismatches > 0) {
        services.events.metrics.increment('ranking.replay.regression_mismatch', mismatches);
        services.log('ranking.replay.regression', {
          sampled: recent.logs.length,
          mismatches,
        });
      }
      if (unknownTemplates > 0) {
        services.events.metrics.increment('ranking.explanation.unknown_template', unknownTemplates);
        services.log('ranking.explanation.unknown_template', { count: unknownTemplates });
      }
    }
  } catch (err) {
    onError(err, 'replay_regression');
  }
  try {
    // Feature-staleness observability (WS-I.2.1d): the OLDEST unrefreshed
    // vector's age is the dashboard's staleness needle.
    const staleHorizon = new Date(nowMs - config.featureStaleHours * 3_600_000).toISOString();
    const staleIds = await services.featureStore.listStaleItems(staleHorizon, 1);
    const oldestId = staleIds[0];
    if (oldestId !== undefined) {
      const oldest = await services.featureStore.getLatest(oldestId);
      services.log('ranking.feature.staleness', {
        oldest_item: oldestId,
        oldest_updated_at: oldest?.updated_at ?? null,
      });
    }
  } catch (err) {
    onError(err, 'feature_batch');
  }
}

/** Start the interval runner (lease-guarded in production). */
export function startRankingScheduler(
  services: RankingServices,
  onError: (err: unknown, task: RankingSchedulerTask) => void = () => {},
  intervalMs: number = RANKING_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const tick = async (): Promise<void> => {
    if (runner) {
      try {
        const acquired = await runner.lease.tryAcquire(
          RANKING_JOB_LEASE,
          Math.ceil(intervalMs * 0.9),
          runner.holder ?? hostname(),
        );
        if (!acquired) return;
      } catch (err) {
        onError(err, 'lease');
        return; // fail closed: skip the tick; idempotent tasks catch up next time
      }
    }
    await runRankingTick(services, onError);
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
