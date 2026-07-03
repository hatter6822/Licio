// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v0 client-side topic-frequency dampening (WS-H.6.1c, SPEC §11.6).
//
// The replacement for the interrupting narrow-loop prompt: instead of a popup,
// a topic a reader is CIRCLING appears steadily LESS often in the front-page
// feed, down to a non-zero floor — so a genuinely pursued topic still surfaces,
// only rarely. Two pure functions, both operating on the in-browser session
// topic sequence (topic-cluster ids + timestamps only — nothing leaves the
// device, the same privacy stance as the attention pipeline):
//
//   computeTopicMultipliers  session sequence → per-topic display multiplier in
//                            [floor, 1). A topic re-entered more often gets a
//                            lower multiplier; the score DECAYS with time, so a
//                            reader who moves on recovers the topic's normal
//                            frequency (a self-correcting nudge, never a
//                            permanent penalty).
//   dampenFeed               feed items + multipliers → a subsampled feed that
//                            keeps ~multiplier of a circled topic's items
//                            (deterministic stride), ALWAYS keeping the first
//                            occurrence (the topic is thinned, never hidden).
//
// The UNCLASSIFIED sentinel is never recorded into the sequence (see
// topic-loops.ts), so it can never be dampened — an unclassified story has no
// real topic to circle.

import type { TopicTransition } from '@licio/invariants';

export interface TopicDampeningConfig {
  /** Recency half-life of the circling score (ms). A larger value dampens for
   *  longer after the reader stops; a smaller value recovers faster. */
  readonly halfLifeMs: number;
  /** Decayed RE-ENTRY count at which a topic hits the floor multiplier. */
  readonly scoreAtFloor: number;
  /** The floor multiplier (> 0): a maximally-circled topic still shows about
   *  this fraction as often — "rarely", never zero. */
  readonly minMultiplier: number;
  /** Ignore visits older than this (they have decayed to ~0 anyway). */
  readonly lookbackMs: number;
}

export const DEFAULT_TOPIC_DAMPENING_CONFIG: TopicDampeningConfig = {
  halfLifeMs: 30 * 60_000, // 30 minutes
  scoreAtFloor: 4, // ~4 recent re-entries reach the floor
  minMultiplier: 0.2, // show a circled topic ~1 in 5 at most
  lookbackMs: 2 * 60 * 60_000, // 2 hours
};

/**
 * At or below this display multiplier a topic counts as "being circled" for the
 * quiet-notification policy (a noticeably dampened topic).
 */
export const CIRCLING_QUIET_MULTIPLIER = 0.5;

/**
 * Per-topic display multiplier ∈ [minMultiplier, 1) for topics the reader is
 * circling. Topics with no re-entry (or fully decayed) are omitted (multiplier
 * 1 ⇒ no dampening). Pure and deterministic.
 *
 * Re-entry is the signal: continuous reading of one topic (consecutive same-
 * topic visits) collapses to a single visit, and each topic's FIRST visit never
 * counts — only coming BACK to a topic after leaving it does. Each re-entry is
 * weighted by recency (exponential decay), giving the recovery behaviour.
 */
export function computeTopicMultipliers(
  sequence: readonly TopicTransition[],
  nowMs: number,
  config: TopicDampeningConfig = DEFAULT_TOPIC_DAMPENING_CONFIG,
): Map<string, number> {
  const windowStart = nowMs - config.lookbackMs;
  const recent = sequence.filter((t) => t.atMs >= windowStart);

  // Collapse consecutive same-topic entries into visits (continuous reading of
  // one topic is a single visit, not circling — re-ENTRY is).
  const visits: TopicTransition[] = [];
  for (const transition of recent) {
    const last = visits[visits.length - 1];
    if (!last || last.topicClusterId !== transition.topicClusterId) visits.push(transition);
  }

  const firstSeen = new Set<string>();
  const score = new Map<string, number>();
  for (const visit of visits) {
    if (!firstSeen.has(visit.topicClusterId)) {
      firstSeen.add(visit.topicClusterId);
      continue; // the first visit of a topic is not a re-entry
    }
    // Recency-weighted: an old re-entry contributes little, so once the reader
    // stops circling, the score decays and the multiplier recovers toward 1.
    const weight = Math.exp(-(nowMs - visit.atMs) / config.halfLifeMs);
    score.set(visit.topicClusterId, (score.get(visit.topicClusterId) ?? 0) + weight);
  }

  const multipliers = new Map<string, number>();
  const floor = clampFloor(config.minMultiplier);
  for (const [topic, s] of score) {
    const fraction = Math.min(1, s / Math.max(config.scoreAtFloor, Number.EPSILON));
    // 1 at score 0 → floor at score ≥ scoreAtFloor, linear in between.
    const multiplier = Math.max(floor, 1 - fraction * (1 - floor));
    if (multiplier < 1) multipliers.set(topic, multiplier);
  }
  return multipliers;
}

function clampFloor(value: number): number {
  if (!Number.isFinite(value)) return 0.2;
  // A positive floor strictly below 1 — the topic is thinned, never hidden and
  // never left at full frequency.
  return Math.min(0.99, Math.max(0.01, value));
}

/** The minimal shape dampenFeed needs from a feed item. */
export interface DampenableItem {
  readonly topic_ids?: readonly string[] | null;
}

/**
 * Subsample a feed so each circled topic appears about `multiplier` as often,
 * preserving order. The FIRST item of a circled topic is always kept (so the
 * topic still surfaces — "rarely", never removed); thereafter one item is kept
 * per deterministic stride `round(1 / multiplier)`. Items of un-circled topics
 * (and items whose primary topic has no multiplier) pass through untouched.
 */
export function dampenFeed<T extends DampenableItem>(
  items: readonly T[],
  multipliers: ReadonlyMap<string, number>,
): T[] {
  if (multipliers.size === 0) return [...items];
  const encountered = new Map<string, number>();
  const out: T[] = [];
  for (const item of items) {
    const topic = item.topic_ids?.[0];
    const multiplier = topic === undefined ? undefined : multipliers.get(topic);
    if (topic === undefined || multiplier === undefined || multiplier >= 1) {
      out.push(item);
      continue;
    }
    const index = encountered.get(topic) ?? 0;
    encountered.set(topic, index + 1);
    const stride = Math.max(1, Math.round(1 / multiplier));
    // index 0 (the first occurrence), then every `stride`-th, are kept.
    if (index % stride === 0) out.push(item);
  }
  return out;
}
