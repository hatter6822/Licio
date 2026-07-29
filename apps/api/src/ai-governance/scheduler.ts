// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K maintenance scheduler (the WS-E/F/H lease-guarded pattern): every instance
// ticks hourly, the job lease grants at most one executor per window, and each
// task is independent. The tick reloads the fail-closed config, runs the runtime
// monitor (drift/report-rate alerts + rollback recommendations, WS-K.1.2f), and
// recomputes the per-use-case accuracy metrics from accumulated steward
// corrections (WS-K.1.3c). Rollback is only ever RECOMMENDED, never executed.
import { ALL_USE_CASE_IDS } from '@licio/ai-governance';
import { AlwaysGrantJobLeaseStore, type JobLeaseStore } from '../identity/job-lease.js';
import { accuracyMetrics } from './correction.js';
import { runtimeMonitorTick } from './runtime-monitor.js';
import type { AiGovernanceServices } from './services.js';
import { generateThreadSummary } from './summaries.js';
import { buildCorrectionDeps, buildRuntimeMonitorDeps, buildSummaryDeps } from './wiring.js';

export const AI_GOVERNANCE_JOB_LEASE = 'ai_governance_hourly';
export const AI_GOVERNANCE_SCHEDULER_INTERVAL_MS = 3_600_000;

/**
 * Threads examined per summary sweep.
 *
 * A bound, not a target: the sweep walks the newest visible threads and stops.
 * Unbounded enumeration inside an hourly lease is how a maintenance job becomes
 * an outage, and a thread missed this hour is picked up the next.
 */
export const SUMMARY_SWEEP_THREAD_LIMIT = 50;

export type AiGovernanceSchedulerTask =
  | 'config_reload'
  | 'runtime_monitor'
  | 'accuracy_recompute'
  | 'summary_sweep';

/**
 * WS-K.1.4a — generate the automated-draft summaries the pipeline exists to
 * produce.
 *
 * `generateThreadSummary` had no production caller while `reportSummary`, from
 * the same module, was routed at `POST /v1/ai/summaries/:id/report`: a summary
 * could be REPORTED but never GENERATED, so the report route addressed drafts
 * that could not exist and the module's own note that the pipeline "still
 * evaluates + records it (AIOutputRecord + the AI draft store) for
 * governance/audit" described a pipeline nothing ran.
 *
 * A thread is summarized at most ONCE. The §24.3 reader-facing Overview was
 * removed, so a draft is an audit artifact rather than something a reader sees
 * go stale; re-summarizing on every tick would mint a fresh AIOutputRecord per
 * thread per hour — unbounded audit noise, and unbounded guard/LLM work — for
 * no new governance signal. `getLatestForThread` answers "already done" against
 * the `ai_summary_drafts_thread_idx` index, which existed with no query behind
 * it.
 *
 * Per-thread failures are isolated: one thread that throws must not cost the
 * rest of the page, because the next tick would start from the same place and
 * never get past it.
 */
export async function runSummarySweep(
  ai: AiGovernanceServices,
  onThreadError: (err: unknown, threadId: string) => void = () => {},
  limit: number = SUMMARY_SWEEP_THREAD_LIMIT,
): Promise<{ examined: number; generated: number; skipped: number }> {
  const deps = buildSummaryDeps(ai);
  // PAGE FORWARD from where the last tick stopped.  Reading `listThreads(null,
  // limit)` every hour returns the same newest page forever: once those threads
  // have drafts — or keep answering `insufficient_activity` — the sweep never
  // reaches an older one, so any deployment with more than `limit` threads
  // leaves the remainder permanently without the audit summaries this exists to
  // produce.
  //
  // PERSISTED, because the tick runs under a distributed lease.  A cursor held
  // in this process is lost to every restart, deploy, and lease handover to
  // another pod — each one resetting the sweep to the newest page.  At one page
  // an hour a large installation is reset long before it reaches the tail, so
  // the older threads never come up: the same permanent gap, one layer up.
  const stored = await ai.sweepCursors.get(SUMMARY_SWEEP_CURSOR);
  const threads = await deps.stories.listThreads(
    stored === null ? null : { createdAt: stored.createdAt, threadId: stored.ref },
    limit,
  );
  let generated = 0;
  let skipped = 0;
  /** The last thread processed with NO failure before it — how far the cursor
   *  may honestly advance.  Null ⇒ the very first thread failed, so the cursor
   *  must not move at all. */
  let lastSettled: { createdAt: string; threadId: string } | null = null;
  let anyFailed = false;
  for (const thread of threads) {
    try {
      if ((await deps.aiSummaries.getLatestForThread(thread.threadId)) !== null) {
        skipped += 1;
      } else {
        const outcome = await generateThreadSummary(deps, thread.threadId);
        // `insufficient_activity` is the common, expected answer for a young
        // thread — it is a skip, not a failure, and must not read as one.
        if (outcome.ok) generated += 1;
        else skipped += 1;
      }
      // Only extend the committable position while nothing has failed yet: past
      // a failure the cursor must not advance, or the failed thread is skipped.
      if (!anyFailed) lastSettled = { createdAt: thread.createdAt, threadId: thread.threadId };
    } catch (err) {
      // A THREAD THAT FAILED IS NOT A THREAD THAT WAS PROCESSED.  The per-thread
      // catch keeps one bad thread from costing the rest of the page, but
      // letting the cursor advance past it turned a transient failure into a
      // summary missing until the whole corpus wraps — days on a large
      // installation.  The cursor now stops at the last thread BEFORE the first
      // failure, so the next tick retries it.  Re-examining the successes after
      // it costs one `getLatestForThread` each; skipping the failure costs its
      // audit summary, and that asymmetry is the whole argument.
      anyFailed = true;
      onThreadError(err, thread.threadId);
    }
  }
  // COMMIT THE POSITION ONLY NOW, after the page has actually been processed.
  // Advancing the cursor before the loop meant a stop or crash between the two
  // — precisely the restart the persistence exists to survive — left the next
  // lease holder starting AFTER up to `limit` unexamined threads, which are
  // then unreachable until the whole corpus wraps back to the newest page.  A
  // cursor that can skip work is worse than one that repeats it: re-examining a
  // thread costs one `getLatestForThread`, and skipping one costs its summary
  // until the wrap.
  //
  // Three outcomes, spelled out rather than folded into one ternary — the
  // folded version silently WRAPPED when the very first thread failed
  // (`lastSettled === null` reads the same as "tail reached"), which is the
  // opposite of retrying it.
  if (anyFailed) {
    // A failure suppresses the wrap too: rewinding to the newest page would put
    // the failed thread behind a whole traversal, which is what the retry
    // exists to avoid.  With NOTHING settled before the failure the cursor is
    // left exactly where it was, so the next tick re-reads this same page.
    if (lastSettled !== null) {
      await ai.sweepCursors.set(SUMMARY_SWEEP_CURSOR, {
        createdAt: lastSettled.createdAt,
        ref: lastSettled.threadId,
      });
    }
  } else {
    // Exhausted the tail ⇒ start again from the newest next tick, so a thread
    // that only later crosses the activity threshold is eventually summarized.
    const last = threads[threads.length - 1];
    await ai.sweepCursors.set(
      SUMMARY_SWEEP_CURSOR,
      threads.length < limit || last === undefined
        ? null
        : { createdAt: last.createdAt, ref: last.threadId },
    );
  }
  return { examined: threads.length, generated, skipped };
}

/** The sweep's row in the durable cursor store. */
export const SUMMARY_SWEEP_CURSOR = 'ai_summary_sweep';

/** One maintenance pass. Each task is isolated — one failure never blocks the
 *  others (each is reported through `onError`). */
export async function runAiGovernanceTick(
  ai: AiGovernanceServices,
  onError: (err: unknown, task: AiGovernanceSchedulerTask) => void = () => {},
): Promise<void> {
  try {
    await ai.reloadConfig();
  } catch (err) {
    onError(err, 'config_reload');
  }
  try {
    await runtimeMonitorTick(buildRuntimeMonitorDeps(ai));
  } catch (err) {
    onError(err, 'runtime_monitor');
  }
  try {
    const correctionDeps = buildCorrectionDeps(ai);
    for (const useCaseId of ALL_USE_CASE_IDS) {
      await accuracyMetrics(correctionDeps, useCaseId);
    }
  } catch (err) {
    onError(err, 'accuracy_recompute');
  }
  try {
    await runSummarySweep(ai, (err) => onError(err, 'summary_sweep'));
  } catch (err) {
    // `buildSummaryDeps` throws when the forum/ingestion seam is unwired (a
    // deployment without those services); that is a configuration fact, not a
    // tick failure, and it must not stop the tasks above from having run.
    onError(err, 'summary_sweep');
  }
}

/** Start the hourly scheduler under the distributed lease. */
export function startAiGovernanceScheduler(
  ai: AiGovernanceServices,
  onError: (err: unknown, task: AiGovernanceSchedulerTask | 'lease') => void = () => {},
  intervalMs: number = AI_GOVERNANCE_SCHEDULER_INTERVAL_MS,
  runner: { lease: JobLeaseStore; holder?: string } = { lease: new AlwaysGrantJobLeaseStore() },
): () => void {
  const holder = runner.holder ?? `ai-governance-${Math.random().toString(36).slice(2, 10)}`;
  const timer = setInterval(async () => {
    try {
      const granted = await runner.lease.tryAcquire(
        AI_GOVERNANCE_JOB_LEASE,
        Math.floor(intervalMs * 0.9),
        holder,
      );
      if (!granted) return;
    } catch (err) {
      onError(err, 'lease');
      return; // fail closed: no lease, no tick
    }
    await runAiGovernanceTick(ai, onError);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
