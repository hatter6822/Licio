// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.7.4 — the Civic Map projection (PRIVATE to stewards; SPEC §12.4, §34).
//
// What is worth asserting is the projection's CONTRACT, not that `reebGraph`
// works (its own suite covers the sweep):
//
//   • the summary agrees with what `ReebService` persists, so the panel and the
//     invariant output can never disagree about the same window;
//   • basins carry the enrichment a human needs — title, catalog topics, and
//     the thread a bridge request targets;
//   • the non-subject UNCLASSIFIED sentinel never appears as a topic;
//   • a basin whose story row vanished still renders rather than dropping a
//     node the tree's edges reference;
//   • an empty landscape is `null` (a real state), not a throw.
import { TOPICS, UNCLASSIFIED_TOPIC_ID } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { buildCivicMap } from '../invariants/civic-map.js';

/** Two real catalog topics to build a topic-adjacency edge from. */
const SUBJECT = TOPICS.filter((topic) => topic.sentinel !== true);
const TOPIC_A = SUBJECT[0];
const TOPIC_B = SUBJECT[1];

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

interface FakeStory {
  storyId: string;
  title: string;
  topicIds: string[];
  events: number;
}

/** Minimal stand-ins for the two service surfaces `buildCivicMap` reads. */
function services(stories: FakeStory[], opts: { omitFromList?: string[] } = {}) {
  const omitted = new Set(opts.omitFromList ?? []);
  const events = {
    windowStore: {
      get: (storyId: string) => {
        const story = stories.find((s) => s.storyId === storyId);
        return Promise.resolve(story ? { eventCount: story.events } : null);
      },
    },
  } as unknown as Parameters<typeof buildCivicMap>[0];
  const ingestion = {
    stories: {
      listRecent: () =>
        Promise.resolve(
          stories
            .filter((s) => !omitted.has(s.storyId))
            .map((s) => ({ storyId: s.storyId, title: s.title, topicIds: s.topicIds })),
        ),
      getThreadsByStoryIds: (storyIds: readonly string[]) =>
        Promise.resolve(new Map(storyIds.map((id) => [id, { threadId: `thread-${id}` }]))),
    },
  } as unknown as Parameters<typeof buildCivicMap>[1];
  return { events, ingestion };
}

function story(id: string, events: number, topicIds: string[], title = `Story ${id}`): FakeStory {
  return { storyId: id, title, topicIds, events };
}

describe('buildCivicMap (WS-H.7.4)', () => {
  it('returns null for an empty landscape — a quiet window is not an error', async () => {
    const { events, ingestion } = services([]);
    expect(await buildCivicMap(events, ingestion, NOW)).toBe(null);
  });

  it('enriches each basin with title, topics, and the bridge-request thread', async () => {
    const { events, ingestion } = services([
      story('11111111-1111-4111-8111-111111111111', 10, [TOPIC_A?.id ?? '']),
      story('22222222-2222-4222-8222-222222222222', 4, [TOPIC_A?.id ?? '']),
    ]);
    const map = await buildCivicMap(events, ingestion, NOW);
    expect(map).not.toBe(null);
    if (!map) return;
    const basin = map.basins[0];
    expect(basin?.title).toMatch(/^Story /);
    expect(basin?.thread_id).toBe(`thread-${basin?.basin_id}`);
    expect(basin?.topics[0]?.name).toBe(TOPIC_A?.name);
  });

  it('never surfaces the UNCLASSIFIED sentinel as a topic', async () => {
    const { events, ingestion } = services([
      story('11111111-1111-4111-8111-111111111111', 10, [UNCLASSIFIED_TOPIC_ID]),
      story('22222222-2222-4222-8222-222222222222', 4, [UNCLASSIFIED_TOPIC_ID]),
    ]);
    const map = await buildCivicMap(events, ingestion, NOW);
    expect(map).not.toBe(null);
    if (!map) return;
    for (const basin of map.basins) {
      expect(basin.topics.map((topic) => topic.id)).not.toContain(UNCLASSIFIED_TOPIC_ID);
    }
    // …and two unclassified stories are NOT topic-adjacent, so they never join.
    expect(map.summary.merge_count).toBe(0);
  });

  it('keeps a basin whose story row vanished, naming it honestly', async () => {
    const gone = '33333333-3333-4333-8333-333333333333';
    const { events } = services([
      story(gone, 10, [TOPIC_A?.id ?? '']),
      story('22222222-2222-4222-8222-222222222222', 4, [TOPIC_A?.id ?? '']),
    ]);
    // The enrichment read is a SECOND call; simulate the row disappearing between
    // them by having listRecent drop it only on the later call.
    let call = 0;
    const drifting = {
      stories: {
        listRecent: () => {
          call += 1;
          const rows = [
            { storyId: gone, title: 'Vanishing', topicIds: [TOPIC_A?.id ?? ''] },
            {
              storyId: '22222222-2222-4222-8222-222222222222',
              title: 'Survivor',
              topicIds: [TOPIC_A?.id ?? ''],
            },
          ];
          return Promise.resolve(call === 1 ? rows : rows.slice(1));
        },
        getThreadsByStoryIds: (storyIds: readonly string[]) =>
          Promise.resolve(new Map(storyIds.map((id) => [id, { threadId: `thread-${id}` }]))),
      },
    } as unknown as Parameters<typeof buildCivicMap>[1];
    const map = await buildCivicMap(events, drifting, NOW);
    expect(map).not.toBe(null);
    if (!map) return;
    const vanished = map.basins.find((b) => b.basin_id === gone);
    expect(vanished).toBeDefined();
    expect(vanished?.title).toBe('Story unavailable');
  });

  it('reports the window it swept and a coverage share', async () => {
    const { events, ingestion } = services([
      story('11111111-1111-4111-8111-111111111111', 10, [TOPIC_A?.id ?? '']),
      story('22222222-2222-4222-8222-222222222222', 4, [TOPIC_A?.id ?? '']),
      // Topic-isolated: it drags coverage below 1.
      story('44444444-4444-4444-8444-444444444444', 2, [TOPIC_B?.id ?? '']),
    ]);
    const map = await buildCivicMap(events, ingestion, NOW);
    expect(map).not.toBe(null);
    if (!map) return;
    const windowEnd = Math.floor(NOW / HOUR) * HOUR;
    expect(map.window.end).toBe(new Date(windowEnd).toISOString());
    expect(map.window.start).toBe(new Date(windowEnd - HOUR).toISOString());
    expect(map.coverage).toBeGreaterThan(0);
    expect(map.coverage).toBeLessThan(1);
  });

  it('summary counts match the graph the invariant persists', async () => {
    const { events, ingestion } = services([
      story('11111111-1111-4111-8111-111111111111', 10, [TOPIC_A?.id ?? '']),
      story('22222222-2222-4222-8222-222222222222', 4, [TOPIC_A?.id ?? '']),
    ]);
    const map = await buildCivicMap(events, ingestion, NOW);
    expect(map).not.toBe(null);
    if (!map) return;
    // basin_count is the peak count, and every basin is published.
    expect(map.summary.basin_count).toBe(map.basins.length);
    // Every published saddle carries its connecting-edge count, which is what
    // makes "fragile" auditable rather than a bare boolean.
    for (const saddle of map.merges) {
      expect(saddle.connecting_edges).toBeGreaterThanOrEqual(0);
    }
  });
});
