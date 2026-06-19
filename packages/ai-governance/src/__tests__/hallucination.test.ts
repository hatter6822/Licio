// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.2b — hallucination detection. Source grounding flags ungrounded
// statements; factual consistency flags numeric and negation contradictions;
// attribution verification flags citations that do not resolve.
import { describe, expect, it } from 'vitest';
import {
  contradictsSource,
  detectHallucination,
  fakeCitations,
  type GroundingStatement,
  isGrounded,
} from '../index.js';

const SOURCE =
  'The company reported revenue of 50 million dollars in 2024. The bill passed the senate on Tuesday.';

const stmt = (text: string, cited_ids: string[] = []): GroundingStatement => ({ text, cited_ids });

describe('WS-K.1.2b grounding', () => {
  it('grounds a statement supported by the source', () => {
    expect(isGrounded(stmt('The company reported revenue'), SOURCE, 0.5)).toBe(true);
  });
  it('flags an unsupported statement', () => {
    expect(isGrounded(stmt('The CEO resigned yesterday afternoon'), SOURCE, 0.5)).toBe(false);
  });
  it('grounds against cited source texts when provided', () => {
    const s: GroundingStatement = {
      text: 'climate policy debate',
      cited_ids: ['c1'],
      cited_source_texts: ['A long discussion of climate policy debate and its merits'],
    };
    expect(isGrounded(s, SOURCE, 0.5)).toBe(true);
  });
});

describe('WS-K.1.2b factual consistency', () => {
  const sentences = [
    'The company reported revenue of 30 percent growth in 2024.',
    'The bill passed the senate on Tuesday.',
  ];
  it('flags a numeric contradiction', () => {
    expect(
      contradictsSource(
        'The company reported revenue of 50 percent growth in 2024',
        sentences,
        0.3,
      ),
    ).toBe(true);
  });
  it('flags a negation-polarity contradiction', () => {
    expect(contradictsSource('The bill did not pass the senate on Tuesday', sentences, 0.3)).toBe(
      true,
    );
  });
  it('does not flag a consistent statement', () => {
    expect(contradictsSource('The bill passed the senate on Tuesday', sentences, 0.3)).toBe(false);
  });
});

describe('WS-K.1.2b attribution verification', () => {
  it('flags citations that do not resolve', () => {
    const valid = new Set(['c1', 'e1']);
    expect(fakeCitations(stmt('x', ['c1', 'ghost']), valid)).toEqual(['ghost']);
    expect(fakeCitations(stmt('x', ['c1', 'e1']), valid)).toEqual([]);
  });
});

describe('WS-K.1.2b detectHallucination', () => {
  it('computes the hallucination rate and pass/fail', () => {
    const result = detectHallucination(
      {
        statements: [
          stmt('The company reported revenue'), // grounded
          stmt('The bill passed the senate'), // grounded
          stmt('Aliens landed in the capital'), // ungrounded ⇒ hallucinated
        ],
        source_text: SOURCE,
        valid_citation_ids: new Set(),
      },
      { rateThreshold: 0.1 },
    );
    expect(result.sample_count).toBe(3);
    expect(result.grounded_count).toBe(2);
    expect(result.hallucination_rate).toBeCloseTo(1 / 3, 6);
    expect(result.passed).toBe(false);
  });

  it('passes a fully grounded, well-cited output', () => {
    const result = detectHallucination(
      {
        statements: [stmt('The company reported revenue', ['c1'])],
        source_text: SOURCE,
        valid_citation_ids: new Set(['c1']),
      },
      { rateThreshold: 0.1 },
    );
    expect(result.passed).toBe(true);
    expect(result.fake_citation_count).toBe(0);
  });

  it('counts fake citations as hallucinations', () => {
    const result = detectHallucination(
      {
        statements: [stmt('The company reported revenue', ['ghost'])],
        source_text: SOURCE,
        valid_citation_ids: new Set(['c1']),
      },
      { rateThreshold: 0 },
    );
    expect(result.fake_citation_count).toBe(1);
    expect(result.hallucination_rate).toBe(1);
    expect(result.passed).toBe(false);
  });

  it('returns a zero rate for an empty batch', () => {
    const result = detectHallucination(
      { statements: [], source_text: SOURCE, valid_citation_ids: new Set() },
      { rateThreshold: 0.1 },
    );
    expect(result.hallucination_rate).toBe(0);
    expect(result.passed).toBe(true);
  });
});
