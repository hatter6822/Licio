// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Freshness-baseline service (WS-F.1.4g): computes the pure
// @licio/invariants score from the story's ages + the TOPIC CADENCE baseline
// (median inter-arrival of recent submissions across the story's topics) and
// persists the versioned feature record consumed by WS-I.2.3d. Recomputed on
// creation, on material-update events, and by the periodic sweep. Reads NO
// financial field by construction (the inputs are story timestamps and topic
// ids; the record schema passes the WS-F.2.5b denylist).
import {
  computeFreshnessScore,
  DEFAULT_FRESHNESS_CONFIG,
  FRESHNESS_FEATURE_VERSION,
  type FreshnessConfig,
} from '@licio/invariants';
import { isSentinelTopicId } from '@licio/shared';
import type { FreshnessStore, StoryRecord, StoryStore } from './stores.js';

/** Cadence window the topic baseline is measured over. */
const TOPIC_BASELINE_WINDOW_DAYS = 14;

/** Median of a sorted numeric array (null for empty input). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The topic-cadence baseline: the median inter-arrival time (ms) of stories
 * in the topic over the trailing window. A story in several topics uses the
 * FASTEST cadence (smallest median) — freshness is judged against the most
 * active community it sits in. Null when no topic has ≥ 2 submissions
 * (graceful degradation; the pure math falls back to the neutral midpoint).
 */
export async function topicCadenceBaseline(
  stories: StoryStore,
  topicIds: readonly string[],
  nowMs: number,
): Promise<number | null> {
  const fromIso = new Date(nowMs - TOPIC_BASELINE_WINDOW_DAYS * 24 * 3_600_000).toISOString();
  const toIso = new Date(nowMs).toISOString();
  let fastest: number | null = null;
  for (const topicId of topicIds.slice(0, 10)) {
    const createdAts = await stories.createdAtsForTopicBetween(topicId, fromIso, toIso);
    if (createdAts.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < createdAts.length; i += 1) {
      gaps.push(Date.parse(createdAts[i] as string) - Date.parse(createdAts[i - 1] as string));
    }
    const topicMedian = median(gaps);
    if (topicMedian !== null && (fastest === null || topicMedian < fastest)) {
      fastest = topicMedian;
    }
  }
  return fastest;
}

/** Compute + persist the story's freshness record (WS-F.1.4g). */
export async function recomputeFreshness(
  stories: StoryStore,
  freshness: FreshnessStore,
  story: StoryRecord,
  nowMs: number,
  config: FreshnessConfig = DEFAULT_FRESHNESS_CONFIG,
): Promise<void> {
  // The UNCLASSIFIED sentinel is not a real shared topic — exclude it so two
  // unclassified stories never derive a common topic-cadence baseline and
  // distort each other's freshness (SPEC §24.1).
  const realTopicIds = story.topicIds.filter((id) => !isSentinelTopicId(id));
  const topicBaselineMs = await topicCadenceBaseline(stories, realTopicIds, nowMs);
  const score = computeFreshnessScore(
    {
      nowMs,
      submittedAtMs: Date.parse(story.createdAt),
      lastMaterialUpdateMs: Date.parse(story.lastMaterialUpdateAt),
      ...(story.publishedAt !== null ? { eventTimeMs: Date.parse(story.publishedAt) } : {}),
      topicMedianInterArrivalMs: topicBaselineMs,
    },
    config,
  );
  await freshness.upsert({
    storyId: story.storyId,
    freshnessScore: score,
    topicBaselineMs,
    featureVersion: FRESHNESS_FEATURE_VERSION,
    computedAt: new Date(nowMs).toISOString(),
  });
}

/** Periodic sweep: refresh records older than `staleMinutes` (WS-F.1.4g). */
export async function sweepFreshness(
  stories: StoryStore,
  freshness: FreshnessStore,
  nowMs: number,
  staleMinutes: number,
  batch: number,
  config: FreshnessConfig = DEFAULT_FRESHNESS_CONFIG,
): Promise<number> {
  const beforeIso = new Date(nowMs - staleMinutes * 60_000).toISOString();
  const stale = await freshness.listComputedBefore(beforeIso, batch);
  let refreshed = 0;
  for (const record of stale) {
    const story = await stories.getById(record.storyId);
    if (!story) continue;
    await recomputeFreshness(stories, freshness, story, nowMs, config);
    refreshed += 1;
  }
  return refreshed;
}
