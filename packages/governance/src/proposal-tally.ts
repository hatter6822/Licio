// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.4.2d — quorum and threshold evaluation over RECORDED weight snapshots
// (SPEC §17.4, §17.5).  The tally sums the `weight_snapshot` captured on each
// GovernanceSignature at signing time — it never recomputes weights, so a later
// cap/eligibility change cannot shift a result after votes were cast.  All
// arithmetic is exact decimal (`decimal.ts`): quorum compares
// `distinctVoters ≥ eligibleCount × minFraction` and the threshold requires the
// affirmative weight STRICTLY greater than `decided × minAffirmativeFraction`
// (the strict `>` bar mirrors the shipped WS-L.4.1d convention, so an exact
// boundary tally crosses NEITHER bar and the proposal stays open until its
// deadline).  §17.5 as amended by WS-U: the KERNEL computes quorum, threshold,
// weight, and tally — this module is that kernel function; the room's AI agent
// holds no vote and no tally authority.

import { decAdd, decCompare, decMul } from './decimal.js';
import type { QuorumRule, ThresholdRule } from './schemas/law-pack.js';
import type { ProposalTallyResult, RecordedVote } from './schemas/voting.js';

export interface ProposalTallyContext {
  /** The quorum-basis population size (eligible voters, or the role class). */
  eligibleCount: number;
  /** Whether the voting deadline has passed (drives terminal outcomes). */
  deadlinePassed: boolean;
  /** Participants counted toward QUORUM when the basis population is narrower
   *  than the voter set (`basis: 'role_class'`: the distinct role-class voters).
   *  Omitted ⇒ every distinct voter counts (the `eligible_voters` basis).
   *  Threshold arithmetic always uses ALL recorded votes — the basis narrows
   *  who must SHOW UP, never whose ballot counts. */
  quorumParticipants?: number;
}

/**
 * Tally recorded votes against the law-pack's quorum + threshold rules.
 *
 * Outcomes are DEADLINE-DRIVEN: before the deadline the tally always reports
 * `open` (with running totals), because a fraction-of-decided threshold crossed
 * mid-vote is NOT a stable result — later voters could flip the fraction back
 * under the bar, so "resolving" early would decide the proposal on a transient
 * snapshot.  (The WS-L.4 simulation resolves early as a deliberate practice-mode
 * simplification; production governance must not.)  At the deadline:
 *  - `quorum_not_met` — participation below the quorum bar (the proposal expires).
 *  - `passed`         — affirmative weight strictly exceeds the threshold bar.
 *  - `rejected`       — otherwise (quorum met, threshold not crossed).
 */
export function tallyProposalVotes(
  votes: readonly RecordedVote[],
  rules: { quorum: QuorumRule; threshold: ThresholdRule },
  ctx: ProposalTallyContext,
): ProposalTallyResult {
  // One vote per voter: dedupe defensively, first recorded wins (the store's
  // unique index enforces this; a replayed list must not double-count).
  const seen = new Set<string>();
  const unique: RecordedVote[] = [];
  for (const vote of votes) {
    if (!seen.has(vote.voterUserId)) {
      seen.add(vote.voterUserId);
      unique.push(vote);
    }
  }

  let approve = '0';
  let reject = '0';
  let abstain = '0';
  for (const vote of unique) {
    if (vote.choice === 'approve') approve = decAdd(approve, vote.weightSnapshot);
    else if (vote.choice === 'reject') reject = decAdd(reject, vote.weightSnapshot);
    else abstain = decAdd(abstain, vote.weightSnapshot);
  }
  const distinctVoters = unique.length;
  // Participants toward quorum: the basis-population voters (role_class) or
  // every distinct voter (eligible_voters).
  const quorumVoters = ctx.quorumParticipants ?? distinctVoters;
  // Turnout clamps to [0,1]: membership can shrink between casting and settling.
  const turnout = ctx.eligibleCount > 0 ? Math.min(1, quorumVoters / ctx.eligibleCount) : 0;

  // Quorum: basis participants ≥ basis × minFraction (exact decimal compare).
  const quorumBar = decMul(ctx.eligibleCount, rules.quorum.minFraction);
  const quorumMet = ctx.eligibleCount > 0 && decCompare(quorumVoters, quorumBar) >= 0;

  const decided = decAdd(approve, reject);
  const base = {
    quorumMet,
    approve,
    reject,
    abstain,
    distinctVoters,
    turnout,
  };

  if (!ctx.deadlinePassed) return { outcome: 'open', ...base };
  if (!quorumMet) return { outcome: 'quorum_not_met', ...base };
  if (decCompare(decided, 0) > 0) {
    // Threshold: affirmative STRICTLY greater than decided × minAffirmativeFraction
    // (exact decimal product — a 0.667 supermajority bar is the exact decimal the
    // law-pack author wrote, never a binary approximation).
    const passBar = decMul(decided, rules.threshold.minAffirmativeFraction);
    if (decCompare(approve, passBar) > 0) {
      return { outcome: 'passed', ...base };
    }
  }
  // Quorum met but the affirmative bar was not crossed by the deadline — the
  // proposal fails.  (An all-abstain tally lands here too: abstentions satisfy
  // quorum but can never pass a proposal.)
  return { outcome: 'rejected', ...base };
}
