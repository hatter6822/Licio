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
  /**
   * Decides whether THIS caller could open a bridge request on a given thread.
   *
   * The map is readable by any platform integrity steward, while the bridge
   * endpoint requires a steward role in the thread's own room (or platform
   * admin) — so publishing every thread id offered controls that
   * deterministically 404. Absent ⇒ no thread is actionable, which is the
   * fail-closed answer for a caller whose authority cannot be resolved.
   */
  canBridge: (threadId: string, roomId: string | null) => Promise<boolean> = async () => false,
): Promise<CivicMapResponse | null> {
  const {
    nodes,
    edges,
    stories: byId,
  } = await assembleEngagementLandscape(events, ingestion, nowMs);
  // No nodes ⇒ no landscape. The assembly starts FROM the window's active rows
  // and drops anything that no longer hydrates as public, so an empty result
  // means a quiet hour or a window whose stories are all restricted — both real
  // states this surface renders as "nothing to map yet" rather than an error.
  if (nodes.length === 0) return null;

  const graph = reebGraph(nodes, edges);

  const finalBasins = new Set(graph.finalBasins);

  // Threads for every landscape node, not only the peaks — in ONE query.
  //
  // A bridge request should open on a conversation that actually carries the
  // join. Basins meet through their lower-level members — the X/Y and Y/Z case
  // `saddleTopics` documents — so targeting a peak sends the request to a thread
  // about X while the saddle is about Y, and the endpoint then computes its
  // SCOI baseline and candidate participants for the wrong conversation.
  const threadByStory = await ingestion.stories.getThreadsByStoryIds(nodes.map((node) => node.id));

  /**
   * The thread this caller may actually act on, or null — MEMOIZED per story.
   *
   * Every sampled endpoint of every merge and split asks, story ids repeat
   * across saddles, and the two-pass preference visits some of them twice. Each
   * unmemoized answer is a `rooms.getById` plus usually a `stewardRolesFor`, so
   * one map load ran hundreds of redundant queries. The promise is cached, not
   * the value, so concurrent askers share one round trip rather than racing.
   */
  const authorized = new Map<string, Promise<string | null>>();
  const actionableThread = (storyId: string): Promise<string | null> => {
    const cached = authorized.get(storyId);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      const threadId = threadByStory.get(storyId)?.threadId;
      if (threadId === undefined) return null;
      return (await canBridge(threadId, byId.get(storyId)?.roomId ?? null)) ? threadId : null;
    })();
    authorized.set(storyId, pending);
    return pending;
  };

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
      // Every node HAS a row: the landscape hydrates before it builds the graph
      // and drops anything that did not, and those rows travel with it — so the
      // "Story unavailable" fallback this used to carry described a state that
      // can no longer occur. It came from a second by-id read that has been
      // removed along with the race it reopened.
      title: story?.title ?? '',
      level: peak.level,
      thread_id: await actionableThread(peak.basin),
      topics,
      final: finalBasins.has(peak.basin),
    });
  }

  /**
   * A thread that carries the JOIN, preferred over a basin peak.
   *
   * The connecting edges are the stories that actually make the two basins
   * adjacent, so their conversation is where a bridging comment belongs. Falls
   * back to the surviving peak when none of them has a thread this caller can
   * act on — a bridge on the right room beats no bridge at all.
   */
  const saddleThread = async (
    sample: readonly { a: string; b: string }[],
    basins: readonly string[],
    survivor: string,
  ): Promise<string | null> => {
    // A connecting edge usually has a PEAK on one end — that is what makes it
    // cross between the basins — so the peaks are excluded on the first pass.
    // Otherwise the "prefer a connecting story" rule would return a peak
    // whenever one happened to sit on the left of the first edge, which is
    // exactly the target this is meant to move away from.
    const peaks = new Set(basins);
    for (const pass of [0, 1]) {
      for (const edge of sample) {
        for (const storyId of [edge.a, edge.b]) {
          if (pass === 0 && peaks.has(storyId)) continue;
          const thread = await actionableThread(storyId);
          if (thread !== null) return thread;
        }
      }
    }
    return await actionableThread(survivor);
  };

  const toSaddle =
    (actionable: boolean) =>
    async (event: {
      basinA: string;
      basinB: string;
      survivor: string;
      level: number;
      connectingEdges: number;
      connectingEdgeSample: readonly { a: string; b: string }[];
      fragile: boolean;
    }): Promise<CivicMapSaddle> => ({
      basin_a: event.basinA,
      basin_b: event.basinB,
      level: event.level,
      connecting_edges: event.connectingEdges,
      fragile: event.fragile,
      survivor: event.survivor,
      shared_topics: saddleTopics(event.connectingEdgeSample, topicsByStory),
      // Resolved ONLY where a bridge action exists: the surface offers one for a
      // FRAGILE merge and nowhere else, so authorizing a target for a sturdy
      // merge or a split is work whose answer nothing renders.
      bridge_thread_id:
        actionable && event.fragile
          ? await saddleThread(
              event.connectingEdgeSample,
              [event.basinA, event.basinB],
              event.survivor,
            )
          : null,
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
    merges: await Promise.all(graph.merges.slice(0, 240).map(toSaddle(true))),
    // A split is a basin coming APART — there is no join to bridge, so no
    // target is resolved for one.
    splits: await Promise.all(graph.splits.slice(0, 240).map(toSaddle(false))),
    coverage: nodes.length === 0 ? 0 : connected.size / nodes.length,
  };
}
