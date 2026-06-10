// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ranking v0 (WS-E.2.1e): freshness/baseline ONLY. This is the ranking
// pipeline the shadow-mode equivalence test exercises: its output is provably
// identical with and without PWAtt scores present, because every invariant
// input passes the shadow boundary (which rejects all PWAtt rows while §30.5
// shadow staging holds) and v0 ordering reads nothing but freshness.
// Deterministic: ties break on story id, so equivalence is byte-exact.
import type { InvariantOutputRecord } from '../events/stores.js';
import { selectRankingInputs } from './shadow.js';

export interface RankingCandidate {
  storyId: string;
  /** ISO creation instant (the freshness baseline input). */
  createdAt: string;
}

export interface RankingV0Result {
  /** Story ids, newest first (freshness baseline, SPEC §30.5 v0). */
  order: string[];
  /** Shadow outputs rejected at the boundary (observability, never inputs). */
  rejectedShadowInputs: number;
}

/** Rank candidates by freshness only; invariant inputs pass the boundary. */
export function rankFrontPageV0(
  candidates: readonly RankingCandidate[],
  invariantInputs: readonly InvariantOutputRecord[] = [],
): RankingV0Result {
  const { allowed, rejected } = selectRankingInputs(invariantInputs);
  // v0 consumes NO invariant signal at all — `allowed` is deliberately unused
  // beyond this point; reading it would be a WS-I (post-shadow) change.
  void allowed;
  const order = [...candidates]
    .sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.storyId.localeCompare(b.storyId),
    )
    .map((candidate) => candidate.storyId);
  return { order, rejectedShadowInputs: rejected.length };
}
