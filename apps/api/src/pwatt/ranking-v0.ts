// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ranking v0 (WS-E.2.1e): freshness/baseline ONLY. This is the ranking
// pipeline the shadow-mode equivalence test exercises: its output is provably
// identical with and without PWAtt scores present, because every invariant
// input passes the shadow boundary (which rejects all PWAtt rows while §30.5
// shadow staging holds) and v0 ordering reads nothing but freshness.
// Deterministic: ties break on story id, so equivalence is byte-exact.
//
// The ORDERING is `@licio/ranking`'s `chronologicalOrder` — the WS-I.4.1b safe
// fallback that actually serves — rather than a second sort of its own. That
// matters twice over.  An equivalence proof run against a sort production does
// not use proves nothing about production; and the local sort was not the same
// sort: it compared with bare `Date.parse`, which yields `NaN` on a malformed
// timestamp, and a comparator returning NaN is not a valid comparator, so the
// order became implementation-defined in the one function whose docstring
// promises byte-exact determinism.  `chronologicalOrder` parses through
// `parseTimestampOrZero` and stays a total order on any input.
import { type Candidate, chronologicalOrder } from '@licio/ranking';
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
  // Only the two fields `chronologicalOrder` reads are meaningful here; the
  // rest are inert placeholders that satisfy the `Candidate` shape. Ordering
  // through the served function is the point — a v0 sort of its own would let
  // the equivalence proof and production disagree without either changing.
  const order = chronologicalOrder(
    candidates.map(
      (candidate): Candidate => ({
        item_id: candidate.storyId,
        item_type: 'story',
        source_type: 'global',
        room_id: null,
        visibility: 'public',
        topic_ids: [],
        source_id: null,
        freshness_timestamp: candidate.createdAt,
        retrieval_score: 0,
        retrieval_origins: ['pwatt_v0'],
      }),
    ),
  ).map((candidate) => candidate.item_id);
  return { order, rejectedShadowInputs: rejected.length };
}
