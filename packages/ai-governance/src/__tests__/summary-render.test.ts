// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.4a — rendering a structured draft into the WS-G summary shape. Facts are
// declarative, claims attributed, interpretations marked; unresolved questions
// and minority views are surfaced; citations are the deduped union.
import { describe, expect, it } from 'vitest';
import { type AiSummaryDraft, renderSummaryDraft } from '../index.js';

const draft: AiSummaryDraft = {
  thread_id: 't1',
  statements: [
    {
      kind: 'fact',
      text: 'The vote passed.',
      attribution: null,
      cited_contribution_ids: ['c1'],
    },
    {
      kind: 'claim',
      text: 'the policy helps',
      attribution: 'User A',
      cited_contribution_ids: ['c2'],
    },
    {
      kind: 'interpretation',
      text: 'the mood was cautious',
      attribution: null,
      cited_contribution_ids: ['c1'],
    },
  ],
  unresolved_questions: ['whether it applies retroactively'],
  minority_views: [{ text: 'Some disagree.', cited_contribution_ids: ['c3'] }],
  covered_contribution_ids: ['c1', 'c2', 'c3'],
  model_name: 'summarizer',
  model_version: '1.0.0',
  output_id: 'out1',
  generated_at: '2026-06-19T00:00:00.000Z',
};

describe('WS-K.1.4a renderSummaryDraft', () => {
  it('renders facts, claims, and interpretations distinctly', () => {
    const rendered = renderSummaryDraft(draft);
    expect(rendered.body).toContain('The vote passed.');
    expect(rendered.body).toContain('User A argues that the policy helps');
    expect(rendered.body).toContain('Interpretation: the mood was cautious');
  });

  it('surfaces unresolved questions and minority views', () => {
    const rendered = renderSummaryDraft(draft);
    expect(rendered.unresolved_uncertainty).toContain(
      'Unresolved: whether it applies retroactively',
    );
    expect(rendered.minority_views_note).toContain('Some disagree.');
  });

  it('produces the deduped union of citations', () => {
    const rendered = renderSummaryDraft(draft);
    expect(rendered.cited_contribution_ids.sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('falls back to a placeholder body when empty', () => {
    const rendered = renderSummaryDraft({
      ...draft,
      statements: [],
      minority_views: [],
      unresolved_questions: [],
    });
    expect(rendered.body.length).toBeGreaterThan(0);
    expect(rendered.unresolved_uncertainty).toBeNull();
    expect(rendered.minority_views_note).toBeNull();
  });
});
