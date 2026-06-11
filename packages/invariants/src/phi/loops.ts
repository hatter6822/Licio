// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v0 — narrow-loop and compulsive-session detection over session topic
// sequences (WS-H.6.1a/WS-H.6.1b, SPEC §11.3, §30.4 PHI v0).
//
// Privacy by construction: the only inputs are TOPIC-CLUSTER IDS and
// TIMESTAMPS — the transition type carries no content field, no story id,
// and no other user's identity (the type system is the first enforcement
// layer; the API consumer is the second). Detection is a soft wellbeing
// signal: it feeds non-blocking prompts and never blocks the user.

export interface TopicTransition {
  /** Coarse topic-cluster id — never a story id or content. */
  topicClusterId: string;
  atMs: number;
}

export const DEFAULT_SEQUENCE_CAP = 200;

/**
 * Append a transition, enforcing the bounded-sequence cap (oldest dropped)
 * so session state can never grow without bound (WS-H.6.1a).
 */
export function appendTransition(
  sequence: readonly TopicTransition[],
  transition: TopicTransition,
  cap: number = DEFAULT_SEQUENCE_CAP,
): TopicTransition[] {
  const next = [...sequence, transition];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export interface NarrowLoopConfig {
  /** Same-cluster visits within the window to flag (default 3). */
  repeatThreshold: number;
  /** Sliding window the repeats must fall inside (default 30 min). */
  windowMs: number;
}

export const DEFAULT_NARROW_LOOP_CONFIG: NarrowLoopConfig = {
  repeatThreshold: 3,
  windowMs: 30 * 60_000,
};

export interface NarrowLoopDetection {
  detected: boolean;
  topicClusterId: string | null;
  /** Visits of the flagged cluster inside the window. */
  occurrences: number;
  /** The closed revisit path for holonomy computation, oldest first. */
  loopPath: string[];
}

/**
 * Narrow loop: the same topic cluster visited ≥ threshold times within the
 * sliding window, with at least one other topic between visits (a user
 * simply READING one topic continuously is not looping — re-ENTRY is the
 * signal).
 */
export function detectNarrowLoop(
  sequence: readonly TopicTransition[],
  nowMs: number,
  config: NarrowLoopConfig = DEFAULT_NARROW_LOOP_CONFIG,
): NarrowLoopDetection {
  const windowStart = nowMs - config.windowMs;
  const recent = sequence.filter((t) => t.atMs >= windowStart);
  // Collapse consecutive same-cluster entries: continuous reading is one visit.
  const visits: TopicTransition[] = [];
  for (const transition of recent) {
    const last = visits[visits.length - 1];
    if (!last || last.topicClusterId !== transition.topicClusterId) visits.push(transition);
  }
  const counts = new Map<string, number>();
  for (const visit of visits) {
    counts.set(visit.topicClusterId, (counts.get(visit.topicClusterId) ?? 0) + 1);
  }
  let flagged: string | null = null;
  let occurrences = 0;
  for (const [cluster, count] of counts) {
    if (count >= config.repeatThreshold && count > occurrences) {
      flagged = cluster;
      occurrences = count;
    }
  }
  if (!flagged) {
    return { detected: false, topicClusterId: null, occurrences: 0, loopPath: [] };
  }
  // The loop path: from the first flagged-cluster visit to the last, as
  // cluster ids — the closed path x₀ → … → x_k = x₀ for holonomy.
  const first = visits.findIndex((v) => v.topicClusterId === flagged);
  let last = -1;
  for (let i = visits.length - 1; i >= 0; i -= 1) {
    if (visits[i]?.topicClusterId === flagged) {
      last = i;
      break;
    }
  }
  return {
    detected: true,
    topicClusterId: flagged,
    occurrences,
    loopPath: visits.slice(first, last + 1).map((v) => v.topicClusterId),
  };
}

export interface CompulsiveSessionConfig {
  /** An exit-and-return to the same cluster faster than this is hostile. */
  rapidReturnMs: number;
  /** Rapid returns required to flag (default 3). */
  returnThreshold: number;
}

export const DEFAULT_COMPULSIVE_CONFIG: CompulsiveSessionConfig = {
  rapidReturnMs: 5 * 60_000,
  returnThreshold: 3,
};

export interface CompulsiveDetection {
  detected: boolean;
  topicClusterId: string | null;
  rapidReturns: number;
}

/**
 * Compulsive session: repeated rapid exit-and-return — leaving a cluster
 * and re-entering it within `rapidReturnMs`, `returnThreshold` times.
 */
export function detectCompulsiveSession(
  sequence: readonly TopicTransition[],
  config: CompulsiveSessionConfig = DEFAULT_COMPULSIVE_CONFIG,
): CompulsiveDetection {
  // Collapse continuous same-cluster runs into visits with entry times.
  const visits: TopicTransition[] = [];
  for (const transition of sequence) {
    const last = visits[visits.length - 1];
    if (!last || last.topicClusterId !== transition.topicClusterId) visits.push(transition);
  }
  const lastSeenAt = new Map<string, number>();
  const rapidReturnCounts = new Map<string, number>();
  for (const visit of visits) {
    const previous = lastSeenAt.get(visit.topicClusterId);
    if (previous !== undefined && visit.atMs - previous <= config.rapidReturnMs) {
      rapidReturnCounts.set(
        visit.topicClusterId,
        (rapidReturnCounts.get(visit.topicClusterId) ?? 0) + 1,
      );
    }
    lastSeenAt.set(visit.topicClusterId, visit.atMs);
  }
  let flagged: string | null = null;
  let rapidReturns = 0;
  for (const [cluster, count] of rapidReturnCounts) {
    if (count >= config.returnThreshold && count > rapidReturns) {
      flagged = cluster;
      rapidReturns = count;
    }
  }
  return { detected: flagged !== null, topicClusterId: flagged, rapidReturns };
}
