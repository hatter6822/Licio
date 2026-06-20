// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K schema invariants. The structural refinements that make governance
// guarantees impossible to violate at the type/validation boundary.
import { describe, expect, it } from 'vitest';
import {
  aiOutputRecordSchema,
  aiTranslationSchema,
  aiUseCaseSchema,
  dataLineageRecordSchema,
  governanceProposalSummarySchema,
  harnessDecisionSchema,
  isEvaluationComplete,
  type ModelCard,
  modelCardSchema,
  NOT_YET_EVALUATED,
  registeredModelSchema,
  summaryStatementSchema,
} from '../index.js';

const ISO = '2026-06-19T00:00:00.000Z';

const validCard = (over: Partial<ModelCard> = {}): unknown => ({
  name: 'topic-classifier',
  version: '1.0.0',
  owner: 'ai-governance',
  purpose: 'topic classification for story ingestion',
  use_case_id: 'topic_classification',
  modalities: ['classification'],
  training_data_summary: 'labeled topic corpus, 2024 snapshot',
  data_lineage_refs: ['ds:topics:1.0.0'],
  input_schema: 'story title + body',
  output_schema: 'topic assignments with confidence',
  prohibited_uses: ['wealth_based_profiling'],
  evaluation_results: [],
  risk_assessment_ref: 'risk:topic_classification:v1',
  update_history: [
    { version: '1.0.0', date: ISO, description: 'initial', evaluation_summary: 'passed' },
  ],
  ...over,
});

describe('WS-K.1.1a model card', () => {
  it('validates a complete card and defaults unevaluated fields', () => {
    const card = modelCardSchema.parse(validCard());
    expect(card.known_biases).toBe(NOT_YET_EVALUATED);
    expect(card.limitations).toBe(NOT_YET_EVALUATED);
    expect(isEvaluationComplete(card)).toBe(false);
  });

  it('reports an evaluated card complete', () => {
    const card = modelCardSchema.parse(
      validCard({ known_biases: 'lower accuracy on satire', limitations: 'short texts' }),
    );
    expect(isEvaluationComplete(card)).toBe(true);
  });

  it('rejects a card missing a required field', () => {
    const { purpose: _omit, ...rest } = validCard() as Record<string, unknown>;
    expect(modelCardSchema.safeParse(rest).success).toBe(false);
  });

  it('requires at least one data lineage ref and one update-history entry', () => {
    expect(modelCardSchema.safeParse(validCard({ data_lineage_refs: [] })).success).toBe(false);
    expect(modelCardSchema.safeParse(validCard({ update_history: [] })).success).toBe(false);
  });
});

describe('WS-K.1.1b registry record', () => {
  const deployed = registeredModelSchema.parse({
    name: 'topic-classifier',
    version: '1.0.0',
    card: validCard(),
    status: 'deployed',
    deprecation: null,
    registered_at: ISO,
    deployed_at: ISO,
  });

  it('requires name/version to match the embedded card', () => {
    expect(registeredModelSchema.safeParse({ ...deployed, version: '2.0.0' }).success).toBe(false);
  });

  it('requires deployed_at for a deployed model', () => {
    expect(registeredModelSchema.safeParse({ ...deployed, deployed_at: null }).success).toBe(false);
  });

  it('requires deprecation metadata exactly when deprecated', () => {
    expect(
      registeredModelSchema.safeParse({ ...deployed, status: 'deprecated', deprecation: null })
        .success,
    ).toBe(false);
  });
});

describe('WS-K.1.1c use-case posture consistency', () => {
  it('rejects a critical use case without prohibited oversight', () => {
    const result = aiUseCaseSchema.safeParse({
      use_case_id: 'toxicity_safety_triage',
      name: 'x',
      description: 'desc',
      model_names: [],
      risk_level: 'critical',
      human_oversight: 'approval',
      risk_assessment_ref: 'risk:x:v1',
      never_autonomous: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('WS-K.1.1e data lineage', () => {
  const base = {
    dataset_id: 'ds:feedback:1.0.0',
    version: '1.0.0',
    source: 'steward-corrected claim extractions',
    consent_basis: 'platform governance approval for steward corrections',
    contains_user_derived: true,
    transformations: [],
    privacy_review_ref: null,
    used_by: [],
    predecessor_dataset_id: null,
    usable: false,
    created_at: ISO,
  };
  it('forbids a usable user-derived dataset without a privacy review', () => {
    expect(dataLineageRecordSchema.safeParse({ ...base, usable: true }).success).toBe(false);
  });
  it('allows it once a privacy review is referenced', () => {
    expect(
      dataLineageRecordSchema.safeParse({ ...base, usable: true, privacy_review_ref: 'pr:1' })
        .success,
    ).toBe(true);
  });
});

describe('WS-K.1.1f output record', () => {
  const base = {
    output_id: 'out:1',
    model_name: 'summarizer',
    model_version: '1.0.0',
    prompt_template_id: 'tmpl:summary:1',
    config_hash: 'a'.repeat(64),
    input_refs: ['thread:1'],
    output_ref: 'summary:1',
    use_case_id: 'summarization',
    correction_ref: null,
    timestamp: ISO,
  };
  it('requires a SHA-256 hex config hash', () => {
    expect(aiOutputRecordSchema.safeParse(base).success).toBe(true);
    expect(aiOutputRecordSchema.safeParse({ ...base, config_hash: 'short' }).success).toBe(false);
  });
});

describe('WS-K structural refinements', () => {
  it('a claim statement must carry attribution', () => {
    expect(
      summaryStatementSchema.safeParse({
        kind: 'claim',
        text: 'x',
        attribution: null,
        cited_contribution_ids: [],
        cited_evidence_ids: [],
      }).success,
    ).toBe(false);
    expect(
      summaryStatementSchema.safeParse({
        kind: 'fact',
        text: 'x',
        attribution: 'someone',
        cited_contribution_ids: [],
        cited_evidence_ids: [],
      }).success,
    ).toBe(false);
  });

  it('a governance summary must cite fields and match its uncertainty flag', () => {
    const base = {
      summary_id: 's1',
      proposal_ref: 'p1',
      cited_fields: ['budget', 'recipient'],
      body: 'summary',
      material_uncertainty: null,
      uncertainty_flagged: false,
      label: 'machine-generated',
      contestable: true,
      steward_edited: false,
      output_id: 'o1',
      model_name: 'gov',
      model_version: '1.0.0',
      generated_at: ISO,
    };
    expect(governanceProposalSummarySchema.safeParse(base).success).toBe(true);
    expect(governanceProposalSummarySchema.safeParse({ ...base, cited_fields: [] }).success).toBe(
      false,
    );
    expect(
      governanceProposalSummarySchema.safeParse({ ...base, uncertainty_flagged: true }).success,
    ).toBe(false);
  });

  it('a translation source and target language must differ', () => {
    const base = {
      translation_id: 't1',
      source_kind: 'story',
      source_ref: 's1',
      source_lang: 'en',
      target_lang: 'en',
      translated_text: 'x',
      label: 'AI-translated',
      consistency_passed: true,
      model_name: 'translator',
      model_version: '1.0.0',
      output_id: 'o1',
      translated_at: ISO,
    };
    expect(aiTranslationSchema.safeParse(base).success).toBe(false);
    expect(aiTranslationSchema.safeParse({ ...base, target_lang: 'es' }).success).toBe(true);
  });

  it('a harness block decision must carry reasons; a deploy must not', () => {
    const base = {
      model_name: 'm',
      version: '1.0.0',
      decision: 'deploy',
      per_eval: [],
      blocked_reasons: [],
      dataset_versions: [],
      evaluated_at: ISO,
    };
    expect(harnessDecisionSchema.safeParse(base).success).toBe(true);
    expect(harnessDecisionSchema.safeParse({ ...base, decision: 'block' }).success).toBe(false);
    expect(
      harnessDecisionSchema.safeParse({ ...base, decision: 'block', blocked_reasons: ['x'] })
        .success,
    ).toBe(true);
  });
});
