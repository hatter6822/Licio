// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hourly WS-F maintenance under its own Postgres job lease (`ingestion_hourly`
// — the WS-D/WS-E distributed-runner pattern: every instance ticks, at most
// one executes per window, a crashed holder's lease expires for the next
// claimant, and a lease failure SKIPS the tick — every task here is
// idempotent, so the next tick catches up):
//
//   • lifecycle low-activity sweep (WS-F.1.1c: active → archived)
//   • freshness-baseline refresh sweep (WS-F.1.4g)
//   • extraction retries whose backoff elapsed (WS-F.1.4e non-blocking
//     failures, crawl-delay deferrals, robots-unreachable fail-closed holds)
//   • one rate-limited embedding-backfill step when a migration is active
//     (WS-F.3.2f)
//   • runtime-config reload (steward writes on OTHER instances converge
//     within one tick).
import { hostname } from 'node:os';
import type { EventPipelineServices } from '../events/services.js';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { runBackfillStep } from './embeddings.js';
import { sweepFreshness } from './freshness.js';
import { sweepLowActivity } from './lifecycle.js';
import { retryDueExtractions, submissionText } from './pipeline.js';
import type { IngestionServices } from './services.js';

export const INGESTION_JOB_LEASE = 'ingestion_hourly';
export const INGESTION_SCHEDULER_INTERVAL_MS = 3_600_000;

export type IngestionSchedulerTask =
  | 'lease'
  | 'config_reload'
  | 'lifecycle_sweep'
  | 'freshness_sweep'
  | 'extraction_retries'
  | 'embedding_backfill';

/** One full maintenance tick (exported for tests; tasks are independent —
 *  one task's failure is reported and never blocks the others). */
export async function runIngestionTick(
  ingestion: IngestionServices,
  events: EventPipelineServices,
  onError: (err: unknown, task: IngestionSchedulerTask) => void,
): Promise<void> {
  try {
    await ingestion.reloadConfig();
  } catch (err) {
    onError(err, 'config_reload');
  }
  const config = ingestion.config();
  try {
    const archived = await sweepLowActivity(
      ingestion.stories,
      ingestion.lifecycleAudits,
      ingestion.now(),
      config.lifecycleIdleDays,
      500,
      ingestion.metrics,
    );
    if (archived > 0) ingestion.log('ingestion.lifecycle_sweep', { archived });
  } catch (err) {
    onError(err, 'lifecycle_sweep');
  }
  try {
    await sweepFreshness(ingestion.stories, ingestion.freshness, ingestion.now(), 55, 500);
  } catch (err) {
    onError(err, 'freshness_sweep');
  }
  try {
    const retried = await retryDueExtractions(ingestion, events, 100);
    if (retried > 0) ingestion.log('ingestion.extraction_retries', { retried });
  } catch (err) {
    onError(err, 'extraction_retries');
  }
  try {
    const progress = await runBackfillStep(
      ingestion.embeddings,
      events.configStore,
      ingestion.embeddingProvider,
      async (targetType, targetId) => {
        if (targetType === 'story') {
          const story = await ingestion.stories.getById(targetId);
          return story === null ? null : submissionText(story);
        }
        if (targetType === 'claim') {
          const claim = await ingestion.claims.getById(targetId);
          return claim?.canonicalText ?? null;
        }
        if (targetType === 'evidence_card') {
          const card = await ingestion.evidence.getById(targetId);
          return card === null ? null : `${card.relevanceNote} ${card.citationUrlOrRef}`;
        }
        return null; // sources/interpretations re-embed with their owners
      },
      config.embeddingBackfillBatch,
      ingestion.now,
    );
    if (progress && !progress.completed) {
      ingestion.log('ingestion.embedding_backfill_step', {
        embedded: progress.embedded,
        to_version: progress.model_version,
      });
    }
  } catch (err) {
    onError(err, 'embedding_backfill');
  }
}

/** Start the hourly runner (the WS-E scheduler shape; returns a stopper). */
export function startIngestionScheduler(
  ingestion: IngestionServices,
  events: EventPipelineServices,
  onError: (err: unknown, task: IngestionSchedulerTask) => void = () => {},
  intervalMs: number = INGESTION_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const holder = runner?.holder ?? `${hostname()}:${process.pid}`;
  const leaseTtlMs = Math.max(1, Math.floor(intervalMs * 0.9));
  const tick = async (): Promise<void> => {
    if (runner) {
      try {
        if (!(await runner.lease.tryAcquire(INGESTION_JOB_LEASE, leaseTtlMs, holder))) return;
      } catch (err) {
        onError(err, 'lease');
        return; // fail closed: skip the tick; idempotent tasks catch up next time
      }
    }
    await runIngestionTick(ingestion, events, onError);
  };
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  void tick();
  return () => clearInterval(timer);
}
