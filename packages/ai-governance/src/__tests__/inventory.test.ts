// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.1c — the AI use-case inventory + NIST/ISO risk assessments. All eight
// use cases are present with risk levels, assessments, and oversight; the
// governance use case is marked never-autonomous; every entry resolves to a
// valid risk assessment whose risk level/oversight agree.
import { describe, expect, it } from 'vitest';
import {
  AI_USE_CASE_IDS,
  ALL_USE_CASE_IDS,
  buildInventory,
  buildRiskAssessment,
  buildUseCaseEntry,
  riskAssessmentRefFor,
  riskAssessmentSchema,
} from '../index.js';

const NOW = '2026-06-19T00:00:00.000Z';

describe('WS-K.1.1c AI inventory', () => {
  it('documents every canonical use case', () => {
    const inventory = buildInventory(1, NOW);
    expect(inventory.use_cases).toHaveLength(AI_USE_CASE_IDS.length);
    expect(inventory.use_cases.map((u) => u.use_case_id).sort()).toEqual(
      [...AI_USE_CASE_IDS].sort(),
    );
  });

  it('marks governance assistance never-autonomous (§24.5)', () => {
    const entry = buildUseCaseEntry('governance_assistance');
    expect(entry.never_autonomous).toBe(true);
    expect(entry.human_oversight).toBe('approval');
    expect(entry.risk_level).toBe('high');
  });

  it('matches the §24.1 risk/oversight table', () => {
    const expected: Record<string, { risk: string; oversight: string }> = {
      topic_classification: { risk: 'medium', oversight: 'review' },
      duplicate_detection: { risk: 'low', oversight: 'none' },
      claim_extraction: { risk: 'medium', oversight: 'review' },
      toxicity_safety_triage: { risk: 'high', oversight: 'approval' },
      summarization: { risk: 'medium', oversight: 'review' },
      translation: { risk: 'medium', oversight: 'review' },
      embedding_generation: { risk: 'low', oversight: 'none' },
      governance_assistance: { risk: 'high', oversight: 'approval' },
      debate_adjudication: { risk: 'high', oversight: 'approval' },
    };
    for (const id of ALL_USE_CASE_IDS) {
      const entry = buildUseCaseEntry(id);
      expect(entry.risk_level).toBe(expected[id]?.risk);
      expect(entry.human_oversight).toBe(expected[id]?.oversight);
    }
  });

  it('every use-case entry resolves to a valid risk assessment', () => {
    for (const id of ALL_USE_CASE_IDS) {
      const entry = buildUseCaseEntry(id);
      const assessment = buildRiskAssessment(id, NOW);
      expect(entry.risk_assessment_ref).toBe(assessment.assessment_id);
      expect(entry.risk_assessment_ref).toBe(riskAssessmentRefFor(id));
      // Inventory posture and assessment posture agree.
      expect(assessment.risk_level).toBe(entry.risk_level);
      expect(assessment.human_oversight).toBe(entry.human_oversight);
      // Affected populations are present (drives bias-audit subgroup selection).
      expect(assessment.affected_populations.length).toBeGreaterThan(0);
    }
  });

  it('risk assessments validate against the schema', () => {
    for (const id of ALL_USE_CASE_IDS) {
      expect(() => riskAssessmentSchema.parse(buildRiskAssessment(id, NOW))).not.toThrow();
    }
  });

  it('links models into the inventory when provided', () => {
    const inventory = buildInventory(2, NOW, { topic_classification: ['topic-classifier'] });
    const topic = inventory.use_cases.find((u) => u.use_case_id === 'topic_classification');
    expect(topic?.model_names).toContain('topic-classifier');
    expect(inventory.version).toBe(2);
  });
});
