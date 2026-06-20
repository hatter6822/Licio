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
import { buildCorrectionDeps, buildRuntimeMonitorDeps } from './wiring.js';

export const AI_GOVERNANCE_JOB_LEASE = 'ai_governance_hourly';
export const AI_GOVERNANCE_SCHEDULER_INTERVAL_MS = 3_600_000;

export type AiGovernanceSchedulerTask = 'config_reload' | 'runtime_monitor' | 'accuracy_recompute';

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
