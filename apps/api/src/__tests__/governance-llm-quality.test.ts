// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The deterministic §24.5 acceptance gate over an LLM-drafted lawmaking
// summary: bounds, the URL-not-in-proposal injection/exfiltration rule, and the
// token-overlap grounding check that rejects hallucinated or off-topic drafts.
import { describe, expect, it } from 'vitest';
import {
  checkLawmakingSummaryQuality,
  GROUNDING_MIN_FRACTION,
  LLM_SUMMARY_BODY_MAX,
  LLM_SUMMARY_HEADLINE_MAX,
} from '../ai-governance/llm/quality.js';

const PROPOSAL_TEXT = [
  'Adopt a weekly digest',
  'Create an opt-in weekly digest email that collects the room highlights every Friday. Details: https://example.org/digest-plan',
  'Yes',
  'No',
].join('\n');

/** A strictly extractive draft — every content token appears in the proposal. */
const GOOD_DRAFT = {
  headline: 'Adopt a weekly digest',
  summary:
    'Create an opt-in weekly digest email that collects the room highlights every Friday. Yes. No.',
};

describe('checkLawmakingSummaryQuality', () => {
  it('accepts a grounded extractive draft and returns it whitespace-collapsed', () => {
    const result = checkLawmakingSummaryQuality({
      proposalText: PROPOSAL_TEXT,
      draft: {
        headline: '  Adopt a   weekly\n digest ',
        summary: `${GOOD_DRAFT.summary.replace(' email ', '\n\temail  ')}`,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headline).toBe('Adopt a weekly digest');
      expect(result.summary).toBe(GOOD_DRAFT.summary);
      expect(result.headline.includes('\n')).toBe(false);
    }
  });

  it('rejects an ungrounded (hallucinated / off-topic) summary', () => {
    const result = checkLawmakingSummaryQuality({
      proposalText: PROPOSAL_TEXT,
      draft: {
        headline: GOOD_DRAFT.headline,
        summary:
          'Members must immediately transfer treasury funds into cryptocurrency ventures for guaranteed returns.',
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures).toContain('insufficient_grounding');
    expect(GROUNDING_MIN_FRACTION).toBeGreaterThan(0.5); // the bar stays meaningful
  });

  it('rejects a URL absent from the proposal (injection/exfil vector)…', () => {
    const result = checkLawmakingSummaryQuality({
      proposalText: PROPOSAL_TEXT,
      draft: {
        headline: GOOD_DRAFT.headline,
        summary: `${GOOD_DRAFT.summary} See https://evil.example.com/steal.`,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures).toContain('url_not_in_proposal');
  });

  it('…but accepts a URL the proposal itself carries (trailing punctuation tolerated)', () => {
    const result = checkLawmakingSummaryQuality({
      proposalText: PROPOSAL_TEXT,
      draft: {
        headline: GOOD_DRAFT.headline,
        summary:
          'Create an opt-in weekly digest email that collects the room highlights every Friday, details https://example.org/digest-plan.',
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects empty and overlong fields with named failures', () => {
    const empty = checkLawmakingSummaryQuality({
      proposalText: PROPOSAL_TEXT,
      draft: { headline: '   ', summary: '' },
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.failures).toContain('headline_empty');
      expect(empty.failures).toContain('summary_empty');
    }

    const overlong = checkLawmakingSummaryQuality({
      proposalText: `${PROPOSAL_TEXT} ${'digest '.repeat(400)}`,
      draft: {
        headline: 'digest '.repeat(30),
        summary: 'weekly digest '.repeat(80),
      },
    });
    expect(overlong.ok).toBe(false);
    if (!overlong.ok) {
      expect(overlong.failures).toContain('headline_too_long');
      expect(overlong.failures).toContain('summary_too_long');
    }
    expect(LLM_SUMMARY_HEADLINE_MAX).toBe(120);
    expect(LLM_SUMMARY_BODY_MAX).toBe(700);
  });

  it('rejects a draft with no substantive content tokens', () => {
    const result = checkLawmakingSummaryQuality({
      proposalText: PROPOSAL_TEXT,
      draft: { headline: '&&& !!!', summary: '??? --- !!!' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures).toContain('no_substantive_content');
  });
});
