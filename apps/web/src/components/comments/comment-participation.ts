// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-comment PWAtt PARTICIPATION weight (WS-E.2.1c / WS-T) for the "Highest
// participation" comment view.
//
// IMPORTANT — what this is and is NOT: PWAtt (participation-weighted attention)
// is scored per THREAD, not per comment — `contribution.created` events fold
// under the thread id, and attention is never tracked per comment. So there is
// no per-comment attention score to sort by. What IS real and per-comment is the
// CONTENT participation weight the WS-E.2.1c math already uses: a constructive,
// SOURCED comment participates more than an unsourced one. That is a
// content/evidence weight, never applause or popularity. This function surfaces
// exactly that component so the sort is honest and doctrine-safe.
//
// A comment that lost a debate (`incorrect`) sinks below everything else,
// mirroring the server's visible-but-sunk ordering (`bySinkThenOrder`).
import { type CommentItem, resolveCommentSources } from '@licio/shared';

/** WS-E.2.1c `citationBonus`: the extra participation a SOURCED comment earns. */
export const SOURCED_PARTICIPATION_BONUS = 0.35;
/** Sink weight for a debate-loser — below any live comment (base 1). */
const SUNK_WEIGHT = -1;

/**
 * The comment's content-participation weight. Higher = more constructive
 * participation (sourced comments rank above unsourced; a debate-loser sinks).
 * Pure and total; identical inputs → identical output.
 */
export function commentParticipationWeight(comment: CommentItem): number {
  if (comment.dispute_status === 'incorrect') return SUNK_WEIGHT;
  const sourced = resolveCommentSources(comment.body, comment.citations).length > 0;
  return 1 + (sourced ? SOURCED_PARTICIPATION_BONUS : 0);
}

/**
 * Order comments by descending participation weight, preserving the incoming
 * (server) order within ties. Weights are computed ONCE per comment (the body is
 * parsed once, not on every comparison), and the original index is the explicit
 * tie-break so the result is stable regardless of the engine's sort stability.
 */
export function byParticipationDesc(comments: readonly CommentItem[]): CommentItem[] {
  return comments
    .map((comment, index) => ({ comment, index, weight: commentParticipationWeight(comment) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((entry) => entry.comment);
}
