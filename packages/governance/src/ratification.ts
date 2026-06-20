// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U model-ratification tally (SPEC §16.6/§24.6; ADR-8). Deterministic,
// quorum-gated, and FAIL-SAFE: a model is adopted ONLY when the vote meets quorum
// and turnout AND a strict majority approves. Every other path — below quorum,
// below turnout, or a tie/rejection — leaves the model UNADOPTED (the room keeps
// its current governance). This is a member function: the AI agent has no
// vote/tally/weight capability and cannot compute or bias the outcome (ADR-8).

import type {
  RatificationBallot,
  RatificationResult,
  RatificationRules,
} from './schemas/ratification.js';

export interface RatificationContext {
  /** Eligible voter count (for turnout); the caller derives it from membership. */
  eligibleCount: number;
}

export function tallyRatification(
  ballots: readonly RatificationBallot[],
  rules: RatificationRules,
  ctx: RatificationContext,
): RatificationResult {
  // One ballot per voter (the store enforces this; dedupe defensively, first wins).
  const seen = new Set<string>();
  let approve = 0;
  let reject = 0;
  for (const ballot of ballots) {
    if (seen.has(ballot.voterUserId)) continue;
    seen.add(ballot.voterUserId);
    if (ballot.choice === 'approve') approve += 1;
    else reject += 1;
  }
  const distinctVoters = approve + reject;
  const turnout = ctx.eligibleCount > 0 ? distinctVoters / ctx.eligibleCount : 0;

  if (distinctVoters < rules.minQuorum || turnout < rules.minTurnout) {
    return {
      settled: false,
      outcome: 'rejected',
      approve,
      reject,
      distinctVoters,
      turnout,
      reason: `Quorum/turnout not met (voters=${distinctVoters}, turnout=${turnout.toFixed(3)}); model not adopted.`,
    };
  }
  // Strict majority adopts; a tie is FAIL-SAFE (not adopted).
  const approved = approve > reject;
  return {
    settled: true,
    outcome: approved ? 'approved' : 'rejected',
    approve,
    reject,
    distinctVoters,
    turnout,
    reason: approved ? 'Ratified by member vote.' : 'Not ratified (no approving majority).',
  };
}
