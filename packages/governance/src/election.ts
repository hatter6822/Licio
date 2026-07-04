// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U steward-election tally (SPEC §16.6, §17.5; ADR-7/8). Deterministic,
// quorum-gated, and fail-safe: below quorum/turnout the incumbent (or bootstrap
// holder) continues — a failed election never vacates the seat. This tally is a
// kernel/platform function; the AI agent has NO vote/tally/weight capability, so
// it cannot compute or influence the outcome (ADR-8). Tie-break: incumbent (if
// among the top), then earliest candidate id.

import type { Ballot, CandidateTally, ElectionResult } from './schemas/election.js';
import type { ElectionRules } from './schemas/law-pack.js';

export interface ElectionContext {
  /** Eligible voter count (for turnout); the caller derives it from membership. */
  eligibleCount: number;
  /** Current seat holder, kept on a failed election; null if none. */
  incumbentUserId: string | null;
}

export function tallyElection(
  ballots: readonly Ballot[],
  rules: ElectionRules,
  ctx: ElectionContext,
): ElectionResult {
  // One ballot per voter (the store enforces this; dedupe defensively, first wins).
  const seen = new Set<string>();
  const unique: Ballot[] = [];
  for (const ballot of ballots) {
    if (!seen.has(ballot.voterUserId)) {
      seen.add(ballot.voterUserId);
      unique.push(ballot);
    }
  }
  const distinctVoters = unique.length;
  // Clamp to the schema's [0,1] contract: `eligibleCount` is a membership read at
  // settle time while ballots were cast earlier, so a membership shrink can make
  // distinctVoters exceed eligibleCount — a turnout > 1 would violate
  // `electionResultSchema` and always over-satisfy the turnout gate.
  const turnout = ctx.eligibleCount > 0 ? Math.min(1, distinctVoters / ctx.eligibleCount) : 0;
  const weightPerVote = Math.min(1, rules.perAccountCap);

  const tallyMap = new Map<string, number>();
  for (const ballot of unique) {
    tallyMap.set(
      ballot.candidateUserId,
      (tallyMap.get(ballot.candidateUserId) ?? 0) + weightPerVote,
    );
  }
  const tally: CandidateTally[] = [...tallyMap.entries()]
    .map(([candidateUserId, weight]) => ({ candidateUserId, weight }))
    .sort((a, b) => b.weight - a.weight || compareIds(a.candidateUserId, b.candidateUserId));

  if (distinctVoters < rules.minQuorum || turnout < rules.minTurnout) {
    return {
      settled: false,
      winnerUserId: ctx.incumbentUserId,
      reason: `Quorum/turnout not met (voters=${distinctVoters}, turnout=${turnout.toFixed(3)}); incumbent continues.`,
      tally,
      distinctVoters,
      turnout,
    };
  }

  const top = tally[0];
  if (!top) {
    return {
      settled: false,
      winnerUserId: ctx.incumbentUserId,
      reason: 'No ballots cast; incumbent continues.',
      tally,
      distinctVoters,
      turnout,
    };
  }

  const topTier = tally.filter((t) => t.weight === top.weight);
  let winner = top.candidateUserId;
  if (
    topTier.length > 1 &&
    ctx.incumbentUserId !== null &&
    topTier.some((t) => t.candidateUserId === ctx.incumbentUserId)
  ) {
    winner = ctx.incumbentUserId;
  }
  return {
    settled: true,
    winnerUserId: winner,
    reason: 'Election settled.',
    tally,
    distinctVoters,
    turnout,
  };
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
