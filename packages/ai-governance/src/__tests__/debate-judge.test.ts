// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate adjudicator — the governed probabilistic neural model.  Proves the
// deterministic/replayable shell, the softmax probability output, the
// content-structural decision surface, and the neutrality of the feature set.
import type { DebateJudgeInput, DebateJudgeSideInput } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  DEBATE_FEATURE_NAMES,
  DEBATE_JUDGE_WEIGHTS,
  extractSideFeatures,
  judgeDebate,
} from '../debate-judge.js';

function side(
  overrides: Partial<{
    content: string;
    summary: string;
    sources: DebateJudgeSideInput['sources'];
    rebuts: boolean;
  }> = {},
): DebateJudgeSideInput {
  return {
    content: overrides.content ?? '',
    summary: overrides.summary ?? '',
    sources: overrides.sources ?? [],
    rebuts_opponent: overrides.rebuts ?? false,
  };
}

function src(
  domain: string | null,
  linkSafe = true,
  reliability: number | null = null,
): DebateJudgeSideInput['sources'][number] {
  return { url: `https://${domain ?? 'x'}/a`, domain, link_safe: linkSafe, reliability };
}

const strongSide = side({
  summary: 'A '.repeat(200),
  sources: [
    src('a.org', true, 0.8),
    src('b.gov', true, 0.9),
    src('c.edu', true, 0.7),
    src('d.com', true, 0.6),
  ],
  rebuts: true,
});
const weakSide = side({ summary: 'Nope.', sources: [src('x.blog', true, null)] });

describe('WS-T debate adjudicator — feature extraction', () => {
  it('extracts normalized content-structural features', () => {
    const f = extractSideFeatures(strongSide);
    expect(f.sourceCount).toBeCloseTo(4 / 5);
    expect(f.independentDomains).toBeCloseTo(4 / 5);
    expect(f.linkSafeRate).toBe(1);
    // mean known reliability (0.75) × coverage (1.0).
    expect(f.effectiveReliability).toBeCloseTo(0.75);
    expect(f.substance).toBe(1); // 150 tokens ≥ saturation
    expect(f.rebuts).toBe(1);
  });

  it('counts only DISTINCT registrable domains (independence, anti-gaming)', () => {
    // Five links, one domain → high count but low independence.
    const spammy = side({
      sources: [
        src('same.com'),
        src('same.com'),
        src('same.com'),
        src('same.com'),
        src('same.com'),
      ],
    });
    const f = extractSideFeatures(spammy);
    expect(f.sourceCount).toBe(1); // 5/5 capped
    expect(f.independentDomains).toBeCloseTo(1 / 5); // one distinct domain
  });

  it('discounts unsafe and unknown-reliability sources', () => {
    const f = extractSideFeatures(
      side({ sources: [src('a.org', false, null), src('b.org', true, null)] }),
    );
    expect(f.linkSafeRate).toBe(0.5);
    expect(f.effectiveReliability).toBe(0); // no known reliability signal
  });
});

describe('WS-T debate adjudicator — decision surface', () => {
  it('rules for the challenger when it is better sourced (corrected)', () => {
    const v = judgeDebate({ incumbent: weakSide, challenger: strongSide });
    expect(v.winner).toBe('challenger');
    expect(v.verdict).toBe('corrected');
    expect(v.confidence).toBeGreaterThan(0.7);
    expect(v.rationale).toMatch(/challenger/i);
  });

  it('rules for the incumbent when it is better sourced (upheld)', () => {
    const v = judgeDebate({ incumbent: strongSide, challenger: weakSide });
    expect(v.winner).toBe('incumbent');
    expect(v.verdict).toBe('upheld');
    expect(v.confidence).toBeGreaterThan(0.7);
  });

  it('returns inconclusive on a near tie (nothing tagged incorrect)', () => {
    const v = judgeDebate({ incumbent: strongSide, challenger: strongSide });
    expect(v.winner).toBe('none');
    expect(v.verdict).toBe('inconclusive');
  });

  it('returns inconclusive when NEITHER side posts (no case made)', () => {
    const v = judgeDebate({ incumbent: side(), challenger: side() });
    expect(v.verdict).toBe('inconclusive');
    expect(v.winner).toBe('none');
  });

  it('lets a strong challenge prevail over an absent incumbent', () => {
    const v = judgeDebate({ incumbent: side(), challenger: strongSide });
    expect(v.winner).toBe('challenger');
    expect(v.verdict).toBe('corrected');
  });
});

describe('WS-T debate adjudicator — probabilistic + deterministic shell', () => {
  const input: DebateJudgeInput = { incumbent: weakSide, challenger: strongSide };

  it('emits a softmax probability distribution (sums to 1; confidence = max)', () => {
    const v = judgeDebate(input);
    const { incumbent, challenger, inconclusive } = v.probabilities;
    expect(incumbent + challenger + inconclusive).toBeCloseTo(1, 6);
    expect(v.confidence).toBeCloseTo(Math.max(incumbent, challenger, inconclusive), 10);
  });

  it('is deterministic + replayable (same input ⇒ byte-identical verdict)', () => {
    const a = judgeDebate(input);
    const b = judgeDebate(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.model_version).toBe(DEBATE_JUDGE_WEIGHTS.version);
  });

  it('pins a well-formed weights artifact (12 inputs → 4 ReLU → 3 classes)', () => {
    expect(DEBATE_JUDGE_WEIGHTS.featureNames).toHaveLength(2 * DEBATE_FEATURE_NAMES.length);
    expect(DEBATE_JUDGE_WEIGHTS.classes).toEqual(['incumbent', 'challenger', 'inconclusive']);
    for (const row of DEBATE_JUDGE_WEIGHTS.hidden.w) expect(row).toHaveLength(12);
    expect(DEBATE_JUDGE_WEIGHTS.hidden.w).toHaveLength(4);
    for (const row of DEBATE_JUDGE_WEIGHTS.output.w) expect(row).toHaveLength(4);
    expect(DEBATE_JUDGE_WEIGHTS.output.w).toHaveLength(3);
  });
});
