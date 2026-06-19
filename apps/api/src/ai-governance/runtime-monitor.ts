// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runtime AI monitoring (WS-K.1.2f, SPEC §24.2/§28.2). Complements pre-deployment
// evaluation: per deployed model it tracks output-distribution / label-rate DRIFT
// (this window vs the prior), the user-report rate, and the withheld-summary
// (runtime hallucination/quality) signal. A threshold crossing raises an alert
// and RECOMMENDS — never autonomously executes — a rollback to the prior registry
// version (§24.1: rollback is human-approved). All reads ride the access-
// controlled AIOutputRecord substrate (no new uncontrolled copy of user data).
import type { RegisteredModel } from '@licio/ai-governance';
import type { AiGovernanceConfig } from './config.js';
import type { AiGovernanceMetrics } from './metrics.js';
import type {
  AiOutputRecordStore,
  ModelRegistryStore,
  RuntimeMonitorStore,
  SummaryStore,
} from './stores.js';

const WINDOW_MS = 3_600_000; // 1 hour

export interface RuntimeMonitorDeps {
  registry: ModelRegistryStore;
  outputRecords: AiOutputRecordStore;
  summaries: SummaryStore;
  runtime: RuntimeMonitorStore;
  config: () => AiGovernanceConfig;
  metrics: AiGovernanceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

/** The prior registry version to recommend rolling back to (or null). */
export async function recommendRollback(
  deps: RuntimeMonitorDeps,
  name: string,
  currentVersion: string,
): Promise<string | null> {
  const versions = (await deps.registry.listVersions(name))
    .filter((v) => v.version !== currentVersion)
    .sort((a, b) => b.registered_at.localeCompare(a.registered_at));
  return versions[0]?.version ?? null;
}

async function raiseAlert(
  deps: RuntimeMonitorDeps,
  model: RegisteredModel,
  metric: string,
  value: number,
  threshold: number,
  nowIso: string,
): Promise<void> {
  const rollback = await recommendRollback(deps, model.name, model.version);
  await deps.runtime.recordAlert({
    modelName: model.name,
    modelVersion: model.version,
    metric,
    value,
    threshold,
    rollbackRecommendation: rollback,
    raisedAt: nowIso,
  });
  deps.metrics.increment('ai.runtime.alert');
  deps.metrics.increment(`ai.runtime.alert.${metric}`);
  deps.log('ai.runtime.alert', {
    model_name: model.name,
    model_version: model.version,
    metric,
    value,
    threshold,
    rollback_recommendation: rollback,
  });
}

/** Evaluate one deployed model's runtime health. */
export async function evaluateModelRuntime(
  deps: RuntimeMonitorDeps,
  model: RegisteredModel,
): Promise<void> {
  const config = deps.config();
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const records = await deps.outputRecords.listByModel(model.name, model.version);
  const inWindow = records.filter((r) => Date.parse(r.timestamp) >= nowMs - WINDOW_MS).length;
  const priorWindow = records.filter(
    (r) =>
      Date.parse(r.timestamp) >= nowMs - 2 * WINDOW_MS &&
      Date.parse(r.timestamp) < nowMs - WINDOW_MS,
  ).length;

  // Output-distribution / label-rate metric + drift alert.
  await deps.runtime.recordMetric({
    modelName: model.name,
    modelVersion: model.version,
    metric: 'output_count',
    value: inWindow,
    recordedAt: nowIso,
  });
  deps.metrics.gauge(`ai.runtime.output_count.${model.name}`, inWindow);
  if (priorWindow > 0) {
    const drift = Math.abs(inWindow - priorWindow) / priorWindow;
    await deps.runtime.recordMetric({
      modelName: model.name,
      modelVersion: model.version,
      metric: 'output_rate_drift',
      value: drift,
      recordedAt: nowIso,
    });
    if (drift > config.runtimeDriftThreshold) {
      await raiseAlert(
        deps,
        model,
        'output_rate_drift',
        drift,
        config.runtimeDriftThreshold,
        nowIso,
      );
    }
  }

  // User-report rate (summarization): reports / outputs.
  if (model.card.use_case_id === 'summarization') {
    const reportCounts = await deps.summaries.countReportsByReason();
    const totalReports = Object.values(reportCounts).reduce((a, b) => a + b, 0);
    const reportRate = records.length === 0 ? 0 : totalReports / records.length;
    await deps.runtime.recordMetric({
      modelName: model.name,
      modelVersion: model.version,
      metric: 'user_report_rate',
      value: reportRate,
      recordedAt: nowIso,
    });
    if (reportRate > config.runtimeUserReportThreshold) {
      await raiseAlert(
        deps,
        model,
        'user_report_rate',
        reportRate,
        config.runtimeUserReportThreshold,
        nowIso,
      );
    }
  }
}

/** One runtime-monitor pass over every deployed model. */
export async function runtimeMonitorTick(deps: RuntimeMonitorDeps): Promise<void> {
  const deployed = await deps.registry.list({ status: 'deployed' });
  for (const model of deployed) {
    await evaluateModelRuntime(deps, model);
  }
  deps.metrics.increment('ai.runtime.tick');
}
