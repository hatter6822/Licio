// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K governance backbone: the seed proves every governed model passes the
// evaluation harness and the registry deployment gate end to end; the registry
// gate, prohibited-use guard, output records, and data lineage enforce their
// doctrine.
import {
  type AiInvocation,
  buildRiskAssessment,
  type ModelCard,
  modelCardSchema,
  riskAssessmentRefFor,
} from '@licio/ai-governance';
import { beforeEach, describe, expect, it } from 'vitest';
import { runEvaluationHarness } from '../ai-governance/harness.js';
import { recordLineage } from '../ai-governance/lineage.js';
import { recordAiOutput } from '../ai-governance/output-records.js';
import { deployModel, type RegistryDeps, registerModel } from '../ai-governance/registry.js';
import { seedAiGovernance } from '../ai-governance/seed.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
} from '../ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';

const NOW = () => Date.parse('2026-06-19T00:00:00.000Z');

function freshServices(): AiGovernanceServices {
  const events = createInMemoryEventPipelineServices({ now: NOW });
  return createInMemoryAiGovernanceServices(events, { now: NOW });
}

function registryDeps(s: AiGovernanceServices): RegistryDeps {
  return {
    registry: s.registry,
    riskAssessments: s.riskAssessments,
    lineage: s.lineage,
    evaluations: s.evaluations,
    metrics: s.metrics,
    log: s.log,
    now: s.now,
  };
}

describe('WS-K seed (end-to-end deployment gate)', () => {
  let services: AiGovernanceServices;
  beforeEach(async () => {
    services = freshServices();
    await seedAiGovernance(services);
  });

  it('registers and DEPLOYS every governed model through the real gate', async () => {
    for (const name of [
      'topic-classifier',
      'claim-extractor',
      'thread-summarizer',
      'content-translator',
      'governance-summarizer',
    ]) {
      const deployed = await services.registry.getDeployed(name);
      expect(deployed, name).not.toBeNull();
      expect(deployed?.status).toBe('deployed');
      expect(deployed?.deployed_at).not.toBeNull();
    }
  });

  it('publishes an inventory of all eight use cases with model links', async () => {
    const inventory = await services.inventory.latest();
    expect(inventory?.use_cases).toHaveLength(8);
    const topic = inventory?.use_cases.find((u) => u.use_case_id === 'topic_classification');
    expect(topic?.model_names).toContain('topic-classifier');
    const governance = inventory?.use_cases.find((u) => u.use_case_id === 'governance_assistance');
    expect(governance?.never_autonomous).toBe(true);
  });

  it('resolves every model card risk assessment and lineage', async () => {
    const deployed = await services.registry.getDeployed('thread-summarizer');
    const assessment = await services.riskAssessments.get(deployed?.card.risk_assessment_ref ?? '');
    expect(assessment).not.toBeNull();
    for (const ref of deployed?.card.data_lineage_refs ?? []) {
      const lineage = await services.lineage.list();
      expect(lineage.some((r) => r.dataset_id === ref)).toBe(true);
    }
  });
});

describe('WS-K.1.1b registry deployment gate', () => {
  let services: AiGovernanceServices;
  beforeEach(async () => {
    services = freshServices();
    await services.riskAssessments.put(
      buildRiskAssessment('summarization', '2026-06-19T00:00:00.000Z'),
    );
    await services.lineage.put({
      dataset_id: 'eval-corpus',
      version: '1.0.0',
      source: 'public',
      consent_basis: 'public license',
      contains_user_derived: false,
      transformations: [],
      privacy_review_ref: null,
      used_by: [],
      predecessor_dataset_id: null,
      usable: true,
      created_at: '2026-06-19T00:00:00.000Z',
    });
  });

  const card = (over: Partial<ModelCard> = {}): ModelCard =>
    modelCardSchema.parse({
      name: 'sum',
      version: '1.0.0',
      owner: 'ai-governance',
      purpose: 'summarize',
      use_case_id: 'summarization',
      modalities: ['generation'],
      training_data_summary: 'x',
      data_lineage_refs: ['eval-corpus'],
      input_schema: 'i',
      output_schema: 'o',
      prohibited_uses: [],
      evaluation_results: [
        {
          eval_kind: 'safety_privacy',
          categories: [],
          passed: true,
          dataset_versions: [],
        },
      ],
      risk_assessment_ref: riskAssessmentRefFor('summarization'),
      update_history: [
        {
          version: '1.0.0',
          date: '2026-06-19T00:00:00.000Z',
          description: 'init',
          evaluation_summary: 'ok',
        },
      ],
      ...over,
    });

  it('rejects registration without an evaluation result', async () => {
    const result = await registerModel(registryDeps(services), card({ evaluation_results: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_evaluations');
  });

  it('rejects registration with an unresolved risk assessment', async () => {
    const result = await registerModel(
      registryDeps(services),
      card({ risk_assessment_ref: 'risk:missing:v1' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('risk_assessment_missing');
  });

  it('refuses to deploy a model the harness blocked', async () => {
    await registerModel(registryDeps(services), card());
    // Record a BLOCKING harness decision (a failing safety eval).
    await runEvaluationHarness(
      {
        evaluations: services.evaluations,
        config: services.config,
        metrics: services.metrics,
        log: services.log,
        now: services.now,
      },
      {
        modelName: 'sum',
        version: '1.0.0',
        modalities: ['generation'],
        riskLevel: 'medium',
        safety: {
          cases: [{ output_text: 'leak: jane@example.com' }],
          harmful_term_denylist: [],
          disclaimer_markers: [],
        },
      },
    );
    const deploy = await deployModel(registryDeps(services), 'sum', '1.0.0');
    expect(deploy.ok).toBe(false);
    if (!deploy.ok) expect(deploy.code).toBe('evaluation_blocked');
  });

  it('refuses to deploy without any harness evaluation', async () => {
    await registerModel(registryDeps(services), card());
    const deploy = await deployModel(registryDeps(services), 'sum', '1.0.0');
    expect(deploy.ok).toBe(false);
    if (!deploy.ok) expect(deploy.code).toBe('evaluation_missing');
  });

  it('preserves old versions and enforces append-only update history', async () => {
    await registerModel(registryDeps(services), card());
    const { versionModel } = await import('../ai-governance/registry.js');
    // A v2 whose history rewrites the v1 entry is rejected.
    const bad = await versionModel(
      registryDeps(services),
      card({
        version: '2.0.0',
        update_history: [
          {
            version: '1.0.0',
            date: '2026-06-19T00:00:00.000Z',
            description: 'REWRITTEN',
            evaluation_summary: 'ok',
          },
          {
            version: '2.0.0',
            date: '2026-06-20T00:00:00.000Z',
            description: 'v2',
            evaluation_summary: 'ok',
          },
        ],
      }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('history_not_appendonly');
    // A proper append succeeds and preserves v1.
    const good = await versionModel(
      registryDeps(services),
      card({
        version: '2.0.0',
        update_history: [
          {
            version: '1.0.0',
            date: '2026-06-19T00:00:00.000Z',
            description: 'init',
            evaluation_summary: 'ok',
          },
          {
            version: '2.0.0',
            date: '2026-06-20T00:00:00.000Z',
            description: 'v2',
            evaluation_summary: 'ok',
          },
        ],
      }),
    );
    expect(good.ok).toBe(true);
    expect(await services.registry.getVersion('sum', '1.0.0')).not.toBeNull();
  });

  it('deprecates a model and warns on lookup', async () => {
    await registerModel(registryDeps(services), card());
    const { deprecateModel, lookupModels } = await import('../ai-governance/registry.js');
    await deprecateModel(registryDeps(services), 'sum', '1.0.0', 'superseded', '2.0.0');
    const before = services.metrics.counter('ai.model.deprecated_lookup');
    const found = await lookupModels(registryDeps(services), { name: 'sum' });
    expect(found[0]?.status).toBe('deprecated');
    expect(services.metrics.counter('ai.model.deprecated_lookup')).toBeGreaterThan(before);
  });
});

describe('WS-K.1.1d prohibited-use guard service', () => {
  it('audits a blocked invocation', async () => {
    const services = freshServices();
    const invocation: AiInvocation = {
      use_case_id: 'governance_assistance',
      capability: 'treasury_execute',
      caller: 'governance-ai',
      effect: 'advisory',
      uses_wealth_signals: false,
      targets_risk_identity: false,
    };
    const decision = await services.guard.check(invocation);
    expect(decision.decision).toBe('block');
    const audit = await services.blocked.list(10);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.prohibition).toBe('autonomous_treasury_execution');
    expect(services.metrics.counter('ai.invocation.blocked')).toBe(1);
  });

  it('enforce() throws on a prohibited invocation', async () => {
    const services = freshServices();
    await expect(
      services.guard.enforce({
        use_case_id: 'governance_assistance',
        capability: 'gov_voting_recommendation',
        caller: 'x',
        effect: 'advisory',
        uses_wealth_signals: false,
        targets_risk_identity: false,
      }),
    ).rejects.toThrow(/prohibited AI use/);
  });
});

describe('WS-K.1.1e/1.1f lineage + output records', () => {
  it('blocks a usable user-derived dataset without a privacy review', async () => {
    const services = freshServices();
    const result = await recordLineage(
      { lineage: services.lineage, metrics: services.metrics, log: services.log },
      {
        dataset_id: 'feedback',
        version: '1.0.0',
        source: 'steward corrections',
        consent_basis: 'governance approval',
        contains_user_derived: true,
        transformations: [],
        privacy_review_ref: null,
        used_by: [],
        predecessor_dataset_id: null,
        usable: true,
        created_at: '2026-06-19T00:00:00.000Z',
      },
    );
    expect(result.ok).toBe(false);
  });

  it('writes an immutable output record with a deterministic config hash', async () => {
    const services = freshServices();
    const record = await recordAiOutput(services.outputRecords, {
      modelName: 'thread-summarizer',
      modelVersion: '1.0.0',
      promptTemplateId: 'tmpl-1',
      config: { temperature: 0, b: 2, a: 1 },
      inputRefs: ['thread:1'],
      outputRef: 'summary:1',
      useCaseId: 'summarization',
      nowIso: '2026-06-19T00:00:00.000Z',
    });
    expect(record.config_hash).toMatch(/^[0-9a-f]{64}$/);
    // Same config (different key order) ⇒ same hash.
    const again = await recordAiOutput(services.outputRecords, {
      modelName: 'thread-summarizer',
      modelVersion: '1.0.0',
      promptTemplateId: 'tmpl-1',
      config: { a: 1, b: 2, temperature: 0 },
      inputRefs: ['thread:2'],
      outputRef: 'summary:2',
      useCaseId: 'summarization',
      nowIso: '2026-06-19T00:00:00.000Z',
    });
    expect(again.config_hash).toBe(record.config_hash);
    // Linking a correction is the only permitted mutation.
    const linked = await services.outputRecords.linkCorrection(record.output_id, 'corr:1');
    expect(linked?.correction_ref).toBe('corr:1');
  });
});
