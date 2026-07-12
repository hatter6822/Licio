// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.4b — summarization quality constraints. A well-formed draft passes all
// five; each constraint fails on its specific violation.
import { describe, expect, it } from 'vitest';
import { type AiSummaryDraft, checkSummaryQuality, type ThreadQualitySignals } from '../index.js';

function draft(over: Partial<AiSummaryDraft> = {}): AiSummaryDraft {
  return {
    thread_id: 't1',
    statements: [
      {
        kind: 'fact',
        text: 'The vote took place on Tuesday.',
        attribution: null,
        cited_contribution_ids: ['c1'],
      },
      {
        kind: 'claim',
        text: 'the policy will reduce costs',
        attribution: 'User A',
        cited_contribution_ids: ['c2'],
      },
    ],
    unresolved_questions: ['whether the policy applies retroactively'],
    minority_views: [
      { text: 'A minority argues the costs will rise.', cited_contribution_ids: ['c3'] },
    ],
    covered_contribution_ids: ['c1', 'c2', 'c3'],
    model_name: 'summarizer',
    model_version: '1.0.0',
    output_id: 'out1',
    generated_at: '2026-06-19T00:00:00.000Z',
    ...over,
  };
}

const signals: ThreadQualitySignals = {
  hasOpenQuestions: true,
  hasMinorityView: true,
  hasDisputedClaim: true,
};

const ok = (c: ReturnType<typeof checkSummaryQuality>, name: string): boolean =>
  c.constraints.find((x) => x.constraint === name)?.passed ?? false;

describe('WS-K.1.4b quality constraints', () => {
  it('passes a well-formed draft on all five constraints', () => {
    const result = checkSummaryQuality(draft(), signals, { slurDenylist: ['slur1'] });
    expect(result.passed).toBe(true);
  });

  it('fails when a disputed thread is flattened to facts only', () => {
    const result = checkSummaryQuality(
      draft({
        statements: [
          {
            kind: 'fact',
            text: 'The policy will reduce costs.',
            attribution: null,
            cited_contribution_ids: [],
          },
        ],
      }),
      signals,
    );
    expect(ok(result, 'distinguish_facts_claims_interpretations')).toBe(false);
  });

  it('fails when an open question is not preserved', () => {
    const result = checkSummaryQuality(draft({ unresolved_questions: [] }), signals);
    expect(ok(result, 'preserve_uncertainty')).toBe(false);
  });

  it('fails when a fact overclaims resolution of an open question', () => {
    const result = checkSummaryQuality(
      draft({
        statements: [
          {
            kind: 'fact',
            text: 'The matter is definitively settled.',
            attribution: null,
            cited_contribution_ids: [],
          },
          {
            kind: 'claim',
            text: 'x',
            attribution: 'User A',
            cited_contribution_ids: [],
          },
        ],
      }),
      signals,
    );
    expect(ok(result, 'preserve_uncertainty')).toBe(false);
  });

  it('fails when a minority view is omitted', () => {
    const result = checkSummaryQuality(draft({ minority_views: [] }), signals);
    expect(ok(result, 'include_minority_views')).toBe(false);
  });

  it('fails when a fact is justified by prevalence', () => {
    const result = checkSummaryQuality(
      draft({
        statements: [
          {
            kind: 'fact',
            text: 'Most people agree the policy is good.',
            attribution: null,
            cited_contribution_ids: [],
          },
          {
            kind: 'claim',
            text: 'x',
            attribution: 'User A',
            cited_contribution_ids: [],
          },
        ],
      }),
      signals,
    );
    expect(ok(result, 'avoid_majority_as_truth')).toBe(false);
  });

  it('fails when a denylisted term is reproduced', () => {
    const result = checkSummaryQuality(
      draft({
        minority_views: [{ text: 'They called the group a slur1.', cited_contribution_ids: [] }],
      }),
      signals,
      { slurDenylist: ['slur1'] },
    );
    expect(ok(result, 'avoid_slur_synthesis')).toBe(false);
  });

  it('detects an unattributed claim (defensive re-check)', () => {
    const result = checkSummaryQuality(
      draft({
        statements: [
          {
            kind: 'claim',
            text: 'x',
            attribution: null,
            cited_contribution_ids: [],
          },
        ],
      }),
      { hasOpenQuestions: false, hasMinorityView: false, hasDisputedClaim: false },
    );
    expect(ok(result, 'distinguish_facts_claims_interpretations')).toBe(false);
  });
});
