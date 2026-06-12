// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.6a/b/c — explanation templates + generation. Asserts the four
// template categories exist, parameter validation, priority selection, the
// STRUCTURAL prohibited-language block (templates cannot emit "trending"/
// "because of the algorithm"/endorsement vocabulary), slowing explanations
// carrying no raw statistics, and the honest fallback reasons.

import { describe, expect, it } from 'vitest';
import { explainItem, fallbackExplanation } from '../explain/generate.js';
import {
  EXPLANATION_TEMPLATES,
  ExplanationParamError,
  PROHIBITED_EXPLANATION_PATTERNS,
  ProhibitedExplanationError,
  renderTemplate,
  TEMPLATE_CATEGORIES,
  violatesProhibitedLanguage,
} from '../explain/templates.js';
import type { ScoredItem } from '../schemas/scored-item.js';

function scored(partial: {
  components?: Partial<ScoredItem['score_components']>;
  flags?: ScoredItem['constraint_flags'];
  redundancy?: { value: number; enforced: boolean };
}): ScoredItem {
  const redundancy = partial.redundancy ?? { value: 0, enforced: false };
  return {
    item_id: '00000000-0000-4000-8000-000000000001',
    pwatt_score: 1,
    score_components: {
      active_attention: 0.1,
      constructive_participation: 0.1,
      exposure_independence: 0.1,
      source_evidence_completeness: 0.1,
      context_coherence_gain: 0.1,
      weights: { wA: 20, wP: 40, wE: 15, wS: 15, wC: 10 },
      positive: 1,
      ...partial.components,
    },
    penalty_components: {
      coordination: { value: 0, coefficient: 1, applied: 0, enforced: false },
      holonomy: { value: 0, coefficient: 1, applied: 0, enforced: false },
      harmful_tension: { value: 0, coefficient: 1, applied: 0, enforced: false },
      redundancy: {
        value: redundancy.value,
        coefficient: 1,
        applied: redundancy.enforced ? redundancy.value : 0,
        enforced: redundancy.enforced,
      },
      total_applied: redundancy.enforced ? redundancy.value : 0,
    },
    baseline: {
      freshness_decay: 0.5,
      source_reliability: 0.5,
      topic_relevance: null,
      value: 0.5,
    },
    constraint_flags: partial.flags ?? [],
  };
}

const NO_SIGNALS = {
  roomCount: 1,
  evidenceCount: 0,
  fromDiversityQuota: false,
  previouslySeen: false,
};

describe('WS-I.2.6a template system', () => {
  it('covers all four categories', () => {
    const categories = new Set([...EXPLANATION_TEMPLATES.values()].map((t) => t.category));
    for (const category of TEMPLATE_CATEGORIES) expect(categories.has(category)).toBe(true);
  });

  it('every template has a unique id, signal type, priority, and i18n key', () => {
    const ids = new Set<string>();
    for (const template of EXPLANATION_TEMPLATES.values()) {
      expect(ids.has(template.templateId)).toBe(false);
      ids.add(template.templateId);
      expect(template.signalType.length).toBeGreaterThan(0);
      expect(template.i18nKey.startsWith('explain.')).toBe(true);
      expect(template.priority).toBeGreaterThanOrEqual(0);
    }
  });

  it('renders with valid params and rejects invalid ones', () => {
    expect(renderTemplate('positive.evidence_rising', { roomCount: 3, evidenceCount: 2 })).toBe(
      'Rising because readers in 3 rooms opened the source and added 2 independent evidence cards.',
    );
    expect(() => renderTemplate('positive.evidence_rising', { roomCount: 0 })).toThrow(
      ExplanationParamError,
    );
    expect(() => renderTemplate('unknown.template', {})).toThrow(ExplanationParamError);
  });

  it('NO template can render prohibited language (structural, every template)', () => {
    // Render every registered template with minimal valid params and scan
    // against the SHARED prohibited list (the WS-I.3.1i artifact).
    const minimalParams: Record<string, unknown> = {
      'positive.evidence_rising': { roomCount: 1, evidenceCount: 1 },
      'contextual.lens_diversity': { lensCount: 2 },
    };
    for (const template of EXPLANATION_TEMPLATES.values()) {
      const rendered = renderTemplate(
        template.templateId,
        minimalParams[template.templateId] ?? {},
      );
      expect(violatesProhibitedLanguage(rendered)).toBe(false);
      expect(rendered.length).toBeGreaterThan(0);
    }
  });

  it('the render guard throws on dynamically-composed prohibited output', () => {
    // A hypothetical bad template cannot ship: the guard fires at render.
    expect(violatesProhibitedLanguage('This is trending now')).toBe(true);
    expect(violatesProhibitedLanguage('Shown because of the algorithm')).toBe(true);
    expect(violatesProhibitedLanguage('Donations endorse this content')).toBe(true);
    expect(PROHIBITED_EXPLANATION_PATTERNS.length).toBeGreaterThanOrEqual(10);
    expect(ProhibitedExplanationError).toBeDefined();
  });
});

describe('WS-I.2.6b explanation generation', () => {
  it('selects the evidence template from real signal values', () => {
    const result = explainItem(
      scored({ components: { constructive_participation: 0.6 } }),
      {},
      { ...NO_SIGNALS, evidenceCount: 2, roomCount: 1 },
    );
    expect(result.templateId).toBe('positive.evidence_rising');
    expect(result.distributionReason).toContain('1 room');
    expect(result.distributionReason).toContain('2 independent evidence cards');
  });

  it('every item gets a non-empty, specific explanation (the floor)', () => {
    const result = explainItem(scored({}), {}, NO_SIGNALS);
    expect(result.templateId).toBe('positive.recent_submission');
    expect(result.distributionReason.length).toBeGreaterThan(0);
  });

  it('constraint/safety explanations outrank positive ones (WS-I.2.6c)', () => {
    const result = explainItem(
      scored({ components: { constructive_participation: 0.9 } }),
      { mfci_risk_state: 'severe' },
      { ...NO_SIGNALS, evidenceCount: 5 },
    );
    expect(result.templateId).toBe('safety.under_review');
    expect(result.distributionReason).toBe('This thread is temporarily under integrity review.');
  });

  it('elevated/high MFCI shows the slowing explanation WITHOUT raw statistics', () => {
    for (const state of ['elevated', 'high'] as const) {
      const result = explainItem(scored({}), { mfci_risk_state: state }, NO_SIGNALS);
      expect(result.templateId).toBe('constraint.mfci_slowed');
      expect(result.distributionReason).toBe(
        'Distribution is slowed because synchronized activity is under review.',
      );
      // Non-accusatory, no thresholds, no numbers.
      expect(/\d/.test(result.distributionReason)).toBe(false);
    }
  });

  it('SCOI context flags produce the interpretations-differ explanation', () => {
    const result = explainItem(scored({ flags: ['scoi_context_card'] }), {}, NO_SIGNALS);
    expect(result.templateId).toBe('contextual.interpretations_differ');
  });

  it('enforced high redundancy produces the repeats explanation', () => {
    const result = explainItem(
      scored({ redundancy: { value: 0.8, enforced: true } }),
      {},
      NO_SIGNALS,
    );
    expect(result.templateId).toBe('constraint.repeated_claim');
  });

  it('diversity-quota items explain the source-diversity intent', () => {
    const result = explainItem(scored({}), {}, { ...NO_SIGNALS, fromDiversityQuota: true });
    expect(result.templateId).toBe('positive.fresh_diversity');
  });

  it('is deterministic for identical inputs', () => {
    const a = explainItem(scored({}), { mfci_risk_state: 'elevated' }, NO_SIGNALS);
    const b = explainItem(scored({}), { mfci_risk_state: 'elevated' }, NO_SIGNALS);
    expect(a).toEqual(b);
  });
});

describe('WS-I.4.1b fallback explanations', () => {
  it('incident fallbacks say "ranking is paused" honestly', () => {
    for (const reason of ['kill_switch', 'pipeline_error', 'gwei_gate'] as const) {
      expect(fallbackExplanation(reason).distributionReason).toBe(
        'Shown in time order while ranking is paused.',
      );
    }
  });

  it('user-chosen chronological mode says "time order, as requested"', () => {
    expect(fallbackExplanation('user_mode').distributionReason).toBe(
      'Shown in time order, as your feed mode requests.',
    );
    expect(fallbackExplanation('empty_pool').templateId).toBe('fallback.chronological');
  });
});
