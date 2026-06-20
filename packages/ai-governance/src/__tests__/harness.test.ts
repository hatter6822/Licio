// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.2e — evaluation harness + deployment gate. The required evaluation set
// is selected by modality and risk; a missing or failing required evaluation
// blocks; high/critical require the full set; the decision is reproducible.
import { describe, expect, it } from 'vitest';
import {
  type EvaluationResult,
  type HarnessInput,
  requiredEvaluations,
  runHarness,
} from '../index.js';

const biasPass: EvaluationResult = {
  eval_kind: 'bias_audit',
  subgroup_metrics: [],
  disparities: [],
  threshold: 0.1,
  passed: true,
  accepted_with_documentation: false,
  justification: null,
  dataset_versions: [{ dataset_id: 'eval-set', version: '1.0.0' }],
};
const biasFail: EvaluationResult = { ...biasPass, passed: false };
const hallPass: EvaluationResult = {
  eval_kind: 'hallucination',
  sample_count: 10,
  grounded_count: 10,
  contradiction_count: 0,
  fake_citation_count: 0,
  hallucination_rate: 0,
  threshold: 0.1,
  passed: true,
  accepted_with_documentation: false,
  dataset_versions: [],
};
const safetyPass: EvaluationResult = {
  eval_kind: 'safety_privacy',
  categories: [],
  passed: true,
  dataset_versions: [],
};
const safetyFail: EvaluationResult = { ...safetyPass, passed: false };
const redTeamPass: EvaluationResult = {
  eval_kind: 'red_team',
  categories: [],
  min_per_category: 50,
  critical_finding_count: 0,
  accepted_risks: [],
  passed: true,
  accepted_with_documentation: false,
  dataset_versions: [],
};

const base: Omit<HarnessInput, 'modalities' | 'risk_level' | 'results'> = {
  model_name: 'm',
  version: '1.0.0',
  evaluated_at: '2026-06-19T00:00:00.000Z',
};

describe('WS-K.1.2e requiredEvaluations', () => {
  it('selects bias only for a low-risk embedding model', () => {
    expect([...requiredEvaluations(['embedding'], 'low')]).toEqual(['bias_audit']);
  });
  it('adds safety for a classification model', () => {
    const set = requiredEvaluations(['classification'], 'medium');
    expect(set.has('bias_audit')).toBe(true);
    expect(set.has('safety_privacy')).toBe(true);
    expect(set.has('hallucination')).toBe(false);
  });
  it('requires the full set for a generation model', () => {
    const set = requiredEvaluations(['generation'], 'medium');
    expect([...set].sort()).toEqual(['bias_audit', 'hallucination', 'red_team', 'safety_privacy']);
  });
  it('requires the full set for any high/critical use case', () => {
    const set = requiredEvaluations(['classification'], 'high');
    expect([...set].sort()).toEqual(['bias_audit', 'hallucination', 'red_team', 'safety_privacy']);
  });
  it('forceRedTeam adds red-team (initial/major upgrade rule)', () => {
    expect(requiredEvaluations(['embedding'], 'low', { forceRedTeam: true }).has('red_team')).toBe(
      true,
    );
  });
});

describe('WS-K.1.2e runHarness', () => {
  it('deploys when every required evaluation passes', () => {
    const decision = runHarness({
      ...base,
      modalities: ['generation'],
      risk_level: 'medium',
      results: [biasPass, hallPass, safetyPass, redTeamPass],
    });
    expect(decision.decision).toBe('deploy');
    expect(decision.blocked_reasons).toEqual([]);
  });

  it('blocks when a required evaluation is missing', () => {
    const decision = runHarness({
      ...base,
      modalities: ['generation'],
      risk_level: 'medium',
      results: [biasPass, hallPass, safetyPass], // red_team missing
    });
    expect(decision.decision).toBe('block');
    expect(decision.blocked_reasons.some((r) => r.includes('red_team'))).toBe(true);
  });

  it('blocks when a required evaluation fails', () => {
    const decision = runHarness({
      ...base,
      modalities: ['classification'],
      risk_level: 'medium',
      results: [biasFail, safetyPass],
    });
    expect(decision.decision).toBe('block');
    expect(decision.blocked_reasons.some((r) => r.includes('bias_audit'))).toBe(true);
  });

  it('never honors acceptance for a safety failure', () => {
    const decision = runHarness({
      ...base,
      modalities: ['classification'],
      risk_level: 'medium',
      results: [biasPass, { ...safetyFail }],
    });
    expect(decision.decision).toBe('block');
  });

  it('honors a documented hallucination acceptance', () => {
    const decision = runHarness({
      ...base,
      modalities: ['generation'],
      risk_level: 'medium',
      results: [
        biasPass,
        { ...hallPass, passed: false, accepted_with_documentation: true },
        safetyPass,
        redTeamPass,
      ],
    });
    expect(decision.decision).toBe('deploy');
  });

  it('is reproducible — identical inputs yield identical decisions', () => {
    const input: HarnessInput = {
      ...base,
      modalities: ['generation'],
      risk_level: 'medium',
      results: [biasPass, hallPass, safetyPass, redTeamPass],
    };
    expect(runHarness(input)).toEqual(runHarness(input));
  });

  it('aggregates and de-duplicates dataset versions', () => {
    const safetySameDataset: EvaluationResult = {
      ...safetyPass,
      dataset_versions: [{ dataset_id: 'eval-set', version: '1.0.0' }],
    };
    const decision = runHarness({
      ...base,
      modalities: ['classification'],
      risk_level: 'low',
      results: [biasPass, safetySameDataset],
    });
    expect(decision.dataset_versions).toEqual([{ dataset_id: 'eval-set', version: '1.0.0' }]);
  });
});
