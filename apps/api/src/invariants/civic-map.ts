// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.7.4 — the Civic Map projection of the Reeb attention landscape
// (SPEC §12.4, §34).
//
// `ReebService.computeBatch` persists five integers (peak/merge/split/fragile/
// final counts), which is the right shape for an invariant output and the wrong
// shape for a map: you cannot draw a merge tree from five scalars. This module
// runs the SAME assembly and the SAME `reebGraph` the scheduler runs, then
// enriches the result with what a human needs to read it — story titles,
// catalog topics, and the thread a bridge request would target.
//
// It is deliberately a separate READ path rather than a widened score vector:
// `score_vector` is `Record<string, number>` by contract across every invariant,
// and smuggling a graph through it would break that uniformity for one consumer.
//
// The doctrine boundary this module sits on: the landscape's nodes are STORIES
// and its scalar is an hourly event count, so this projection is analyst-grade
// and belongs behind `requireSteward` — the same bar as the coordinated-report
// incidents it renders beside. It never reaches a reader surface, and `level` is
// published as the merge tree's AXIS, never as a rank (the wire schema's header
// states the same rule for consumers).

import { reebGraph } from '@licio/invariants';
import type { CivicMapBasin, CivicMapResponse, CivicMapSaddle, CivicMapTopic } from '@licio/shared';
import { isSentinelTopicId, topicById } from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { assembleEngagementLandscape } from './data.js';

/** Resolve catalog topics for display, dropping the non-subject sentinel. */
function topicsFor(topicIds: readonly string[]): CivicMapTopic[] {
  const out: CivicMapTopic[] = [];
  for (const id of topicIds) {
    if (isSentinelTopicId(id)) continue;
    const topic = topicById(id);
    if (topic) out.push({ id: topic.id, name: topic.name });
    if (out.length === 8) break;
  }
  return out;
}

/** The topics two basins have in common — what a bridging comment addresses. */
function sharedTopics(a: CivicMapTopic[], b: CivicMapTopic[]): CivicMapTopic[] {
  const bIds = new Set(b.map((t) => t.id));
  return a.filter((t) => bIds.has(t.id)).slice(0, 8);
}

/**
 * Build the Civic Map for the current landscape window.
 *
 * Returns `null` when the landscape has no nodes at all — an empty map is a
 * real state (a quiet hour, a fresh deployment) and the caller renders it as
 * such rather than as an error.
 */
export async function buildCivicMap(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  nowMs: number,
): Promise<CivicMapResponse | null> {
  const { nodes, edges } = await assembleEngagementLandscape(events, ingestion, nowMs);
  if (nodes.length === 0) return null;

  const graph = reebGraph(nodes, edges);

  // One pass over the stories the landscape actually used, so the enrichment
  // cannot drift from the graph (a second `listRecent` could return a different
  // set as new stories land mid-request).
  const storyIds = new Set(nodes.map((n) => n.id));
  const stories = await ingestion.stories.listRecent(nodes.length);
  const byId = new Map(stories.filter((s) => storyIds.has(s.storyId)).map((s) => [s.storyId, s]));
  const finalBasins = new Set(graph.finalBasins);

  // Only the basins' peak stories need a thread lookup, not every node.
  const basinIds = graph.peaks.map((p) => p.basin);
  const threadByStory = new Map<string, string | null>();
  for (const storyId of basinIds) {
    const thread = await ingestion.stories.getThreadByStoryId(storyId);
    threadByStory.set(storyId, thread?.threadId ?? null);
  }

  const topicsByBasin = new Map<string, CivicMapTopic[]>();
  const basins: CivicMapBasin[] = [];
  for (const peak of graph.peaks) {
    const story = byId.get(peak.basin);
    const topics = topicsFor(story?.topicIds ?? []);
    topicsByBasin.set(peak.basin, topics);
    basins.push({
      basin_id: peak.basin,
      // A story whose row vanished between assembly and enrichment (deleted,
      // moderated) still has a place in the graph — name it honestly rather
      // than dropping a node the tree's edges still reference.
      title: story?.title ?? 'Story unavailable',
      level: peak.level,
      thread_id: threadByStory.get(peak.basin) ?? null,
      topics,
      final: finalBasins.has(peak.basin),
    });
  }

  const toSaddle = (event: {
    basinA: string;
    basinB: string;
    level: number;
    connectingEdges: number;
    fragile: boolean;
  }): CivicMapSaddle => ({
    basin_a: event.basinA,
    basin_b: event.basinB,
    level: event.level,
    connecting_edges: event.connectingEdges,
    fragile: event.fragile,
    shared_topics: sharedTopics(
      topicsByBasin.get(event.basinA) ?? [],
      topicsByBasin.get(event.basinB) ?? [],
    ),
  });

  const connected = new Set(edges.flatMap((e) => [e.a, e.b]));
  const hourMs = 3_600_000;
  const windowEnd = Math.floor(nowMs / hourMs) * hourMs;

  return {
    window: {
      start: new Date(windowEnd - hourMs).toISOString(),
      end: new Date(windowEnd).toISOString(),
    },
    summary: {
      basin_count: graph.peaks.length,
      merge_count: graph.merges.length,
      split_count: graph.splits.length,
      fragile_saddle_count: graph.bridgePrompts.length,
      final_basin_count: graph.finalBasins.length,
    },
    basins: basins.slice(0, 120),
    merges: graph.merges.map(toSaddle).slice(0, 240),
    splits: graph.splits.map(toSaddle).slice(0, 240),
    coverage: nodes.length === 0 ? 0 : connected.size / nodes.length,
  };
}
