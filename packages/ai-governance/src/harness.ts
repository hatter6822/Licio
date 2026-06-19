// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Evaluation harness + deployment-gate logic (WS-K.1.2e, SPEC §24.2/§30.9). Pure
// and deterministic: given a candidate's modalities, risk level, and the
// evaluation results, it selects the REQUIRED evaluation set (by modality and
// risk), checks each, and returns a deploy/block decision with reasons and the
// dataset versions used. Re-running with the same inputs yields the same
// decision (reproducibility). The selection realizes the §30.9 AI gate
// (source-grounded, logged, evaluated, correctable) as an automated chokepoint;
// the registry refuses any deploy the harness blocks.
import type { AiModality, AiRiskLevel } from './schemas/common.js';
import type {
  DatasetVersionRef,
  EvaluationKind,
  EvaluationResult,
  HarnessDecision,
} from './schemas/evaluation.js';

export interface RequiredEvalOptions {
  /** WS-K.1.2d: force red-team (initial deploy / major upgrade / guardrail change). */
  forceRedTeam?: boolean;
}

/**
 * The required evaluation set for a candidate (WS-K.1.2e). Bias always applies;
 * generation adds hallucination + safety + red-team; classification adds safety;
 * HIGH/CRITICAL risk requires the FULL set; and `forceRedTeam` adds red-team for
 * the WS-K.1.2d initial/major-upgrade rule.
 */
export function requiredEvaluations(
  modalities: readonly AiModality[],
  riskLevel: AiRiskLevel,
  options: RequiredEvalOptions = {},
): Set<EvaluationKind> {
  const required = new Set<EvaluationKind>(['bias_audit']);
  if (modalities.includes('generation')) {
    required.add('hallucination');
    required.add('safety_privacy');
    required.add('red_team');
  }
  if (modalities.includes('classification')) {
    required.add('safety_privacy');
  }
  if (riskLevel === 'high' || riskLevel === 'critical') {
    required.add('bias_audit');
    required.add('hallucination');
    required.add('safety_privacy');
    required.add('red_team');
  }
  if (options.forceRedTeam) required.add('red_team');
  return required;
}

/**
 * Whether a single evaluation result satisfies the gate. Bias acceptance is
 * already folded into `passed`; hallucination honors a documented acceptance;
 * safety and red-team NEVER honor acceptance (a leak or a critical finding
 * always blocks).
 */
function evalSatisfiesGate(result: EvaluationResult): boolean {
  switch (result.eval_kind) {
    case 'bias_audit':
      return result.passed;
    case 'hallucination':
      return result.passed || result.accepted_with_documentation;
    case 'safety_privacy':
      return result.passed;
    case 'red_team':
      return result.passed;
  }
}

export interface HarnessInput {
  model_name: string;
  version: string;
  modalities: readonly AiModality[];
  risk_level: AiRiskLevel;
  results: readonly EvaluationResult[];
  /** WS-K.1.2d: initial deploy / major upgrade ⇒ force red-team. */
  force_red_team?: boolean;
  evaluated_at: string;
}

/** Run the harness and produce the deploy/block decision. */
export function runHarness(input: HarnessInput): HarnessDecision {
  const required = requiredEvaluations(input.modalities, input.risk_level, {
    ...(input.force_red_team !== undefined ? { forceRedTeam: input.force_red_team } : {}),
  });
  const byKind = new Map<EvaluationKind, EvaluationResult>();
  for (const result of input.results) byKind.set(result.eval_kind, result);

  const blockedReasons: string[] = [];
  for (const kind of required) {
    const result = byKind.get(kind);
    if (result === undefined) {
      blockedReasons.push(`missing required evaluation: ${kind}`);
      continue;
    }
    if (!evalSatisfiesGate(result)) {
      blockedReasons.push(`failing required evaluation: ${kind}`);
    }
  }

  // Aggregate dataset versions across every supplied evaluation (dedup).
  const datasetVersions: DatasetVersionRef[] = [];
  const seen = new Set<string>();
  for (const result of input.results) {
    for (const dv of result.dataset_versions) {
      const key = `${dv.dataset_id}@${dv.version}`;
      if (!seen.has(key)) {
        seen.add(key);
        datasetVersions.push(dv);
      }
    }
  }

  return {
    model_name: input.model_name,
    version: input.version,
    decision: blockedReasons.length === 0 ? 'deploy' : 'block',
    per_eval: [...input.results],
    blocked_reasons: blockedReasons,
    dataset_versions: datasetVersions,
    evaluated_at: input.evaluated_at,
  };
}
