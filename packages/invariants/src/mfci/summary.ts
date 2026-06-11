// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MFCI — human-readable coordination rationale (WS-H.3.4b/WS-H.3.4c,
// SPEC §8.6/§8.7).
//
// Two audiences, one privacy rule: neither summary may contain user
// identifiers, raw action logs, or operational detail that would help an
// adversary evade detection. The analyst summary names the statistic, the
// conditioned margins, and the evidence strength; the appeal summary
// explains in plain language what pattern was unusual and what normal
// behavior was conditioned on (MFCI-5).

import type { MfciStatistic } from './pvalue.js';
import type { MfciRiskState } from './risk.js';

export interface MfciCaseFacts {
  statistic: MfciStatistic;
  mfci: number;
  pHat: number;
  sampleCount: number;
  riskState: MfciRiskState;
  /** Names of the margins conditioned on (axis names, MFCI-4). */
  conditionedMargins: readonly string[];
  /** Number of distinct targets involved. */
  targetCount: number;
}

const STATISTIC_DESCRIPTIONS: Record<MfciStatistic, { pattern: string; appeal: string }> = {
  synchrony: {
    pattern: 'actions arriving in unusually tight time clusters',
    appeal:
      'the timing of actions was far more synchronized than normal activity, even after accounting for how busy the topic and time period were',
  },
  target_concentration: {
    pattern: 'actions unusually concentrated on a small set of targets',
    appeal:
      'activity was far more concentrated on specific content than normal behavior, even after accounting for group size and topic popularity',
  },
  phrase_repetition: {
    pattern: 'near-identical phrasing repeated across accounts',
    appeal:
      'very similar phrasing was repeated toward the same content far more than normal conversation patterns explain',
  },
};

/** Analyst case summary (review queue, WS-H.3.4b). */
export function analystCaseSummary(facts: MfciCaseFacts): string {
  const description = STATISTIC_DESCRIPTIONS[facts.statistic];
  return (
    `Coordination signal: ${description.pattern}. ` +
    `Statistic: ${facts.statistic}; MFCI = ${facts.mfci.toFixed(2)} ` +
    `(conditional p ≈ ${facts.pHat.toExponential(2)}, ${facts.sampleCount} fiber samples). ` +
    `Risk state: ${facts.riskState}. ` +
    `Margins conditioned on: ${facts.conditionedMargins.join(', ')}. ` +
    `Affected targets: ${facts.targetCount}.`
  );
}

/**
 * Appeal-facing summary (WS-H.3.4c). No identifiers, no raw logs, no
 * thresholds — what was detected, what was conditioned on, why unusual.
 */
export function appealSummary(facts: MfciCaseFacts): string {
  const description = STATISTIC_DESCRIPTIONS[facts.statistic];
  return (
    `What was detected: ${description.pattern}. ` +
    `What normal behavior was accounted for: overall activity levels per community, topic interest, time-of-day patterns, and typical action mixes (${facts.conditionedMargins.join(', ')}). ` +
    `Why it was flagged: ${description.appeal}. ` +
    'This assessment compares patterns of activity only; it does not judge the content itself, and it is reviewed by a person before any lasting effect.'
  );
}
