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

/**
 * What a saddle is ABOUT: the topics carried by the edges that actually connect
 * the two basins.
 *
 * Intersecting the two PEAK stories' topics was wrong, and quietly so — basins
 * meet through their lower-level members, so a peak about X can join a peak
 * about Z through an X/Y story and a Y/Z story. The join is entirely about Y,
 * and intersecting the peaks returns nothing, hiding the one subject a bridging
 * comment would have to address. The landscape edge already IS a shared topic
 * (that is what makes two stories adjacent), so reading the connecting edges
 * gives the answer directly.
 */
function saddleTopics(
  edges: readonly { a: string; b: string }[],
  topicsByStory: ReadonlyMap<string, CivicMapTopic[]>,
): CivicMapTopic[] {
  const out = new Map<string, CivicMapTopic>();
  for (const edge of edges) {
    const left = topicsByStory.get(edge.a) ?? [];
    const rightIds = new Set((topicsByStory.get(edge.b) ?? []).map((topic) => topic.id));
    for (const topic of left) {
      if (rightIds.has(topic.id)) out.set(topic.id, topic);
    }
  }
  return [...out.values()].slice(0, 8);
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

  // Enrich BY THE GRAPH'S OWN IDS, not by a second `listRecent`.
  //
  // A repeat `listRecent(n)` returns the n most recent stories AT THAT INSTANT,
  // so stories arriving between assembly and this read push older graph members
  // out of the window — and filtering then dropped live basins to "Story
  // unavailable" with no topics, blaming ordinary concurrent ingestion on a
  // deletion. Fetching the exact ids removes the race and makes the fallback
  // mean what it says: the row really is gone.
  const byId = await ingestion.stories.getByIds(nodes.map((node) => node.id));
  const finalBasins = new Set(graph.finalBasins);

  // Only the basins' peak stories need a thread, not every node — and they are
  // fetched in ONE query. A per-basin `getThreadByStoryId` would be a round trip
  // per basin against Postgres on a surface a steward reloads by hand.
  const threadByStory = await ingestion.stories.getThreadsByStoryIds(
    graph.peaks.map((peak) => peak.basin),
  );

  // Topics for EVERY landscape node, not only the peaks: a saddle's subject
  // usually lives on the lower-level stories that form the connecting edge.
  const topicsByStory = new Map<string, CivicMapTopic[]>();
  for (const node of nodes) {
    topicsByStory.set(node.id, topicsFor(byId.get(node.id)?.topicIds ?? []));
  }

  const basins: CivicMapBasin[] = [];
  for (const peak of graph.peaks) {
    const story = byId.get(peak.basin);
    const topics = topicsByStory.get(peak.basin) ?? [];
    basins.push({
      basin_id: peak.basin,
      // A story whose row vanished between assembly and enrichment (deleted,
      // moderated) still has a place in the graph — name it honestly rather
      // than dropping a node the tree's edges still reference.
      title: story?.title ?? 'Story unavailable',
      level: peak.level,
      thread_id: threadByStory.get(peak.basin)?.threadId ?? null,
      topics,
      final: finalBasins.has(peak.basin),
    });
  }

  const toSaddle = (event: {
    basinA: string;
    basinB: string;
    survivor: string;
    level: number;
    connectingEdges: number;
    connectingEdgeSample: readonly { a: string; b: string }[];
    fragile: boolean;
  }): CivicMapSaddle => ({
    basin_a: event.basinA,
    basin_b: event.basinB,
    level: event.level,
    connecting_edges: event.connectingEdges,
    fragile: event.fragile,
    survivor: event.survivor,
    shared_topics: saddleTopics(event.connectingEdgeSample, topicsByStory),
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
