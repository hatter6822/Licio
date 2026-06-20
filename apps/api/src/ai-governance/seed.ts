// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K governance seed. Populates the registry, risk assessments, data lineage,
// and AI inventory, and registers + DEPLOYS each governed model THROUGH the real
// machinery — every model passes the evaluation harness (bias/hallucination/
// safety/red-team) and the registry deployment gate before it is marked
// deployed. This proves the whole governance backbone end to end and gives the
// pipelines a real deployed model version to reference. Runs on non-prod boot
// and in tests.
import {
  type AiRiskLevel,
  type AiUseCaseId,
  ALL_USE_CASE_IDS,
  buildInventory,
  buildRiskAssessment,
  CANONICAL_USE_CASES,
  type DataLineageRecord,
  type ModelCard,
  modelCardSchema,
  riskAssessmentRefFor,
} from '@licio/ai-governance';
import { type HarnessRunInput, runEvaluationHarness } from './harness.js';
import { GOVERNED_MODELS, type ModelIdentity } from './models.js';
import { deployModel, type RegistryDeps, registerModel } from './registry.js';
import type { AiGovernanceServices } from './services.js';

/** Passing evaluation inputs for a candidate (deterministic; always deploys). */
function passingHarnessInput(model: ModelIdentity, riskLevel: AiRiskLevel): HarnessRunInput {
  const datasetVersions = [{ dataset_id: 'eval-corpus', version: '1.0.0' as const }];
  const generation = model.modalities.includes('generation');
  const input: HarnessRunInput = {
    modelName: model.name,
    version: model.version,
    modalities: model.modalities,
    riskLevel,
    forceRedTeam: true, // initial deployment (WS-K.1.2d)
    bias: {
      metrics: [
        {
          dimension: 'language',
          subgroup: 'en',
          sample_size: 200,
          accuracy: 0.9,
          quality_score: 0.9,
        },
        {
          dimension: 'language',
          subgroup: 'es',
          sample_size: 200,
          accuracy: 0.9,
          quality_score: 0.9,
        },
      ],
      datasetVersions,
    },
    safety: {
      cases: [{ output_text: 'A neutral, well-formed governed output.' }],
      harmful_term_denylist: [],
      disclaimer_markers: ['seek help', 'support is available'],
    },
    redTeam: {
      inputs: [
        { category: 'adversarial_prompts', test_count: 50, critical_findings: 0 },
        { category: 'jailbreaks', test_count: 50, critical_findings: 0 },
        { category: 'bias_probing', test_count: 50, critical_findings: 0 },
        { category: 'edge_cases', test_count: 50, critical_findings: 0 },
      ],
      datasetVersions,
    },
  };
  if (generation) {
    input.hallucination = {
      input: {
        statements: [{ text: 'the report covers revenue growth', cited_ids: ['c1'] }],
        source_text: 'The report covers revenue growth and outlook for the year.',
        valid_citation_ids: new Set(['c1']),
      },
      datasetVersions,
    };
  }
  return input;
}

const PURPOSE: Record<AiUseCaseId, string> = {
  topic_classification:
    'Assign multi-label topics to submitted stories for retrieval and features.',
  claim_extraction:
    'Extract discrete candidate claims from story text for the claim-evidence graph.',
  summarization: 'Generate the never-final automated draft thread summary (§15.4).',
  translation: 'Translate content while keeping the original canonical and accessible (§15.5).',
  governance_assistance: 'Summarize proposals and flag COI/scam patterns for stewards (§24.5).',
  duplicate_detection: 'Flag near-duplicate content (MERI owns the decision).',
  toxicity_safety_triage: 'Pre-screen content for safety review; flags only, never enforcement.',
  embedding_generation: 'Produce embeddings for similarity and search.',
};

function buildCard(
  model: ModelIdentity,
  results: ModelCard['evaluation_results'],
  nowIso: string,
): ModelCard {
  return modelCardSchema.parse({
    name: model.name,
    version: model.version,
    owner: 'ai-governance',
    purpose: PURPOSE[model.useCaseId],
    use_case_id: model.useCaseId,
    modalities: model.modalities,
    training_data_summary:
      'Deterministic provider: governance metadata only; no raw training data is stored on the card.',
    data_lineage_refs: ['training-corpus', 'eval-corpus'],
    input_schema: `docs/ai-governance/README.md#${model.useCaseId}-inputs`,
    output_schema: `@licio/ai-governance ${model.useCaseId} schema`,
    prohibited_uses: ['wealth_based_profiling', 'risk_identity_hiding'],
    known_biases:
      'Deterministic stand-in: documented per-language/topic limits; superseded when a model backend lands.',
    limitations:
      'Heuristic/deterministic provider; accuracy bounded by its rules and the taxonomy.',
    evaluation_results: results,
    risk_assessment_ref: riskAssessmentRefFor(model.useCaseId),
    update_history: [
      {
        version: model.version,
        date: nowIso,
        description: 'initial deployment of the governed deterministic provider',
        evaluation_summary: 'bias/hallucination/safety/red-team all passed',
      },
    ],
  } satisfies ModelCard);
}

/** Seed risk assessments, lineage, models (registered+deployed), and inventory. */
export async function seedAiGovernance(services: AiGovernanceServices): Promise<void> {
  const nowIso = new Date(services.now()).toISOString();

  // 1. Risk assessments for every use case (WS-K.1.1c).
  for (const useCaseId of ALL_USE_CASE_IDS) {
    await services.riskAssessments.put(buildRiskAssessment(useCaseId, nowIso));
  }

  // 2. Base data lineage: a training corpus + an evaluation corpus (neither
  //    user-derived ⇒ usable without a privacy review; WS-K.1.1e).
  const baseLineage = (datasetId: string): DataLineageRecord => ({
    dataset_id: datasetId,
    version: '1.0.0',
    source: 'public licensed reference corpus',
    consent_basis: 'public license (no user-derived content)',
    contains_user_derived: false,
    transformations: [{ transformation: 'cleaning', actor: 'ai-governance', at: nowIso }],
    privacy_review_ref: null,
    used_by: GOVERNED_MODELS.map((m) => `${m.name}@${m.version}`),
    predecessor_dataset_id: null,
    usable: true,
    created_at: nowIso,
  });
  await services.lineage.put(baseLineage('training-corpus'));
  await services.lineage.put(baseLineage('eval-corpus'));

  const registryDeps: RegistryDeps = {
    registry: services.registry,
    riskAssessments: services.riskAssessments,
    lineage: services.lineage,
    evaluations: services.evaluations,
    metrics: services.metrics,
    log: services.log,
    now: services.now,
  };

  // 3. Register + deploy each governed model through the real gate.
  const modelNamesByUseCase: Partial<Record<AiUseCaseId, string[]>> = {};
  for (const model of GOVERNED_MODELS) {
    const riskLevel = CANONICAL_USE_CASES[model.useCaseId].risk_level;
    const decision = await runEvaluationHarness(
      {
        evaluations: services.evaluations,
        config: services.config,
        metrics: services.metrics,
        log: services.log,
        now: services.now,
      },
      passingHarnessInput(model, riskLevel),
    );
    const card = buildCard(model, decision.per_eval, nowIso);
    const registered = await registerModel(registryDeps, card);
    if (!registered.ok) {
      services.log('ai.seed.register_failed', { model: model.name, code: registered.code });
      continue;
    }
    const deployed = await deployModel(registryDeps, model.name, model.version);
    if (!deployed.ok) {
      services.log('ai.seed.deploy_failed', { model: model.name, code: deployed.code });
      continue;
    }
    const list = modelNamesByUseCase[model.useCaseId] ?? [];
    list.push(model.name);
    modelNamesByUseCase[model.useCaseId] = list;
  }

  // 4. The AI inventory linking models to use cases (WS-K.1.1c).
  await services.inventory.put(buildInventory(1, nowIso, modelNamesByUseCase));
  services.metrics.increment('ai.inventory.updated');
  services.log('ai.inventory.updated', { version: 1, models: GOVERNED_MODELS.length });
}
