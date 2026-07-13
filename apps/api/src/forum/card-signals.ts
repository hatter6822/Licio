// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC §5.6 story-card signals — the SINGLE batched derivation shared by the
// WS-I feed path (apps/api/src/ranking/service.ts) and the story-detail read
// (apps/api/src/routes/v1.ts), so the two surfaces agree by construction (the
// house pattern of `deriveStorySafetyState`).  These are the compact signals
// that replaced the former rating labels: the sourced-comment count (the same
// number as the comment section's "Sources" view) and the WS-T corrections
// tally for the comment section (live arenas / validated / incorrect).
// Content-integrity signals, never popularity — no like/vote/reaction count
// can flow through here by construction (the counts are citation- and
// adjudication-derived).
//
// Batched by design: TWO grouped store reads per feed page (the per-thread
// contribution tallies + the live comment-arena counts), never per-item
// round trips.

import { EMPTY_STORY_CORRECTIONS, type StoryCorrections } from '@licio/shared';
import type { DebateStore } from './debate-store.js';
import type { ContributionStore } from './stores.js';

/** Per-story card signals on their way to the wire (`sources_count` +
 *  `corrections` on the §23.3 FeedItem). */
export interface StoryCardSignals {
  /** Published comments carrying ≥1 citation (the "Sources" view count). */
  sourced: number;
  /** The WS-T corrections tally for the COMMENT section; the story's own
   *  posture rides `dispute_status` separately (never double-reported). */
  corrections: StoryCorrections;
}

/** The neutral signal set (no thread, or nothing to report yet). */
export const EMPTY_CARD_SIGNALS: StoryCardSignals = Object.freeze({
  sourced: 0,
  corrections: EMPTY_STORY_CORRECTIONS,
});

/**
 * Batch the §5.6 card signals for a set of stories.  `threadByStory` maps each
 * story id to its thread id (or null for a story with no thread yet — it gets
 * the neutral signals).  Every requested story id is present in the result.
 */
export async function storyCardSignals(
  forum: { contributions: ContributionStore; debates: DebateStore },
  threadByStory: ReadonlyMap<string, string | null>,
): Promise<Map<string, StoryCardSignals>> {
  const out = new Map<string, StoryCardSignals>();
  if (threadByStory.size === 0) return out;
  const threadIds = [...threadByStory.values()].filter((id): id is string => id !== null);
  const [tallies, activeArenas] = await Promise.all([
    forum.contributions.cardSignalCounts(threadIds),
    forum.debates.countActiveCommentArenas([...threadByStory.keys()]),
  ]);
  for (const [storyId, threadId] of threadByStory) {
    const tally = threadId === null ? undefined : tallies.get(threadId);
    const active = activeArenas.get(storyId) ?? 0;
    if (tally === undefined && active === 0) {
      out.set(storyId, EMPTY_CARD_SIGNALS);
      continue;
    }
    out.set(storyId, {
      sourced: tally?.sourced ?? 0,
      corrections: {
        active,
        validated: tally?.validated ?? 0,
        incorrect: tally?.incorrect ?? 0,
      },
    });
  }
  return out;
}
