// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Evaluation harness orchestrator (WS-K.1.2e, SPEC §24.2/§30.9). Runs the four
// pure evaluators (bias/subgroup, hallucination, safety/privacy, red-team) for a
// candidate, aggregates them through the deploy/block gate, and PERSISTS the
// decision so the registry's deployment gate (registry.ts) can read it. Threshold
// defaults come from the fail-closed runtime config. The decision records the
// dataset versions used, so a re-run is verifiable. This is the automated §30.9
// AI chokepoint: no model deploys without bias/safety/privacy/red-team coverage.
import {
  type AiModality,
  type AiRiskLevel,
  type BiasAuditOptions,
  computeBiasAudit,
  computeRedTeamResult,
  type DatasetVersionRef,
  detectHallucination,
  type EvaluationResult,
  type HallucinationInput,
  type HarnessDecision,
  type RedTeamCategoryInput,
  runHarness,
  runSafetySuite,
  type SafetySuiteInput,
  type SubgroupMetric,
} from '@licio/ai-governance';
import type { AiGovernanceConfig } from './config.js';
import type { AiGovernanceMetrics } from './metrics.js';
import type { EvaluationStore } from './stores.js';

export interface HarnessDeps {
  evaluations: EvaluationStore;
  config: () => AiGovernanceConfig;
  metrics: AiGovernanceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export interface HarnessRunInput {
  modelName: string;
  version: string;
  modalities: readonly AiModality[];
  riskLevel: AiRiskLevel;
  /** WS-K.1.2d: initial deploy / major upgrade ⇒ force red-team. */
  forceRedTeam?: boolean;
  bias?: {
    metrics: readonly SubgroupMetric[];
    acceptedDisparities?: ReadonlySet<string>;
    justification?: string | null;
    datasetVersions?: readonly DatasetVersionRef[];
  };
  hallucination?: {
    input: HallucinationInput;
    acceptedWithDocumentation?: boolean;
    datasetVersions?: readonly DatasetVersionRef[];
  };
  safety?: SafetySuiteInput;
  redTeam?: {
    inputs: readonly RedTeamCategoryInput[];
    acceptedRisks?: readonly string[];
    datasetVersions?: readonly DatasetVersionRef[];
  };
}

/** Run the applicable evaluations and persist the deploy/block decision. */
export async function runEvaluationHarness(
  deps: HarnessDeps,
  input: HarnessRunInput,
): Promise<HarnessDecision> {
  const config = deps.config();
  const results: EvaluationResult[] = [];

  if (input.bias) {
    const options: BiasAuditOptions = {
      threshold: config.biasDisparityThreshold,
      minSampleSize: config.biasMinSampleSize,
      ...(input.bias.acceptedDisparities
        ? { acceptedDisparities: input.bias.acceptedDisparities }
        : {}),
      ...(input.bias.justification !== undefined
        ? { justification: input.bias.justification }
        : {}),
      ...(input.bias.datasetVersions ? { datasetVersions: [...input.bias.datasetVersions] } : {}),
    };
    results.push(computeBiasAudit(input.bias.metrics, options));
  }
  if (input.hallucination) {
    results.push(
      detectHallucination(input.hallucination.input, {
        rateThreshold: config.hallucinationRateThreshold,
        ...(input.hallucination.acceptedWithDocumentation !== undefined
          ? { acceptedWithDocumentation: input.hallucination.acceptedWithDocumentation }
          : {}),
        ...(input.hallucination.datasetVersions
          ? { datasetVersions: input.hallucination.datasetVersions }
          : {}),
      }),
    );
  }
  if (input.safety) {
    results.push(runSafetySuite(input.safety));
  }
  if (input.redTeam) {
    results.push(
      computeRedTeamResult(input.redTeam.inputs, {
        minPerCategory: config.redTeamMinPerCategory,
        ...(input.redTeam.acceptedRisks ? { acceptedRisks: input.redTeam.acceptedRisks } : {}),
        ...(input.redTeam.datasetVersions
          ? { datasetVersions: input.redTeam.datasetVersions }
          : {}),
      }),
    );
  }

  const decision = runHarness({
    model_name: input.modelName,
    version: input.version,
    modalities: input.modalities,
    risk_level: input.riskLevel,
    results,
    ...(input.forceRedTeam !== undefined ? { force_red_team: input.forceRedTeam } : {}),
    evaluated_at: new Date(deps.now()).toISOString(),
  });

  await deps.evaluations.put(decision);
  deps.metrics.increment('ai.model.evaluation.run');
  deps.metrics.increment(
    decision.decision === 'deploy' ? 'ai.model.evaluation.deploy' : 'ai.model.evaluation.block',
  );
  deps.log('model.evaluation.run.completed', {
    model_name: input.modelName,
    version: input.version,
    decision: decision.decision,
    blocked_reasons: decision.blocked_reasons,
    dataset_versions: decision.dataset_versions.map((d) => `${d.dataset_id}@${d.version}`),
  });
  return decision;
}

/** The per-evaluation results from a decision (to attach to a model card). */
export function evaluationResultsOf(decision: HarnessDecision): EvaluationResult[] {
  return [...decision.per_eval];
}
