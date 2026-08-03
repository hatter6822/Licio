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
  /** The room the STORY row names — where it was submitted. */
  roomId?: string;
  /** The room the CONVERSATION sits in, which a thread move separates from the
   *  story's room (WS-Q). The bridge endpoint authorizes against THIS one. */
  threadRoomId?: string;
}

/** Minimal stand-ins for the two service surfaces `buildCivicMap` reads. */
function services(stories: FakeStory[], opts: { omitFromList?: string[] } = {}) {
  const omitted = new Set(opts.omitFromList ?? []);
  const events = {
    windowStore: {
      // The landscape STARTS from the window — what actually drew attention —
      // rather than from the most recent stories filtered by activity.
      listActiveInWindow: (_start: string, _size: string, limit: number) =>
        Promise.resolve(
          stories
            .filter((s) => s.events > 0)
            .sort((a, b) => b.events - a.events)
            .slice(0, limit)
            .map((s) => ({ itemId: s.storyId, eventCount: s.events })),
        ),
    },
  } as unknown as Parameters<typeof buildCivicMap>[0];
  const ingestion = {
    stories: {
      getPublicByIds: (ids: readonly string[]) =>
        Promise.resolve(
          new Map(
            stories
              .filter((s) => ids.includes(s.storyId) && !omitted.has(s.storyId))
              .map((s) => [
                s.storyId,
                {
                  storyId: s.storyId,
                  title: s.title,
                  topicIds: s.topicIds,
                  roomId: s.roomId ?? null,
                },
              ]),
          ),
        ),
      getThreadsByStoryIds: (storyIds: readonly string[]) =>
        Promise.resolve(
          new Map(
            storyIds.map((id) => [
              id,
              {
                threadId: `thread-${id}`,
                roomId: stories.find((s) => s.storyId === id)?.threadRoomId ?? null,
              },
            ]),
          ),
        ),
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
    const map = await buildCivicMap(events, ingestion, NOW, async () => true);
    expect(map).not.toBe(null);
    if (!map) return;
    const basin = map.basins[0];
    expect(basin?.title).toMatch(/^Story /);
    expect(basin?.thread_id).toBe(`thread-${basin?.basin_id}`);
    expect(basin?.topics[0]?.name).toBe(TOPIC_A?.name);
  });

  it('reports a quiet hour as empty rather than inventing a landscape from old adjacency', async () => {
    // Stories exist; none drew an event this hour. `reebGraph` would happily
    // build basins and merges out of topic adjacency alone, and the panel would
    // claim attention is grouping "this hour" from an hour in which nobody read
    // anything.
    const quiet = [
      {
        storyId: 'aaaaaaaa-1111-4111-8111-111111111111',
        title: 'A',
        topicIds: [TOPIC_A?.id ?? ''],
        events: 0,
      },
      {
        storyId: 'bbbbbbbb-2222-4222-8222-222222222222',
        title: 'B',
        topicIds: [TOPIC_A?.id ?? ''],
        events: 0,
      },
    ];
    const { events, ingestion } = services(quiet);
    expect(await buildCivicMap(events, ingestion, NOW)).toBeNull();
  });

  it('leaves a story with no activity this hour OUT of the landscape entirely', async () => {
    // The all-zero guard covers a quiet window; this covers the mixed one. A
    // single active story must not drag silent ones into the map as level-0
    // peaks that then form basins out of topic adjacency alone.
    const mixed = [
      {
        storyId: 'aaaaaaaa-1111-4111-8111-111111111111',
        title: 'Busy',
        topicIds: [TOPIC_A?.id ?? ''],
        events: 12,
      },
      {
        storyId: 'bbbbbbbb-2222-4222-8222-222222222222',
        title: 'Silent',
        topicIds: [TOPIC_A?.id ?? ''],
        events: 0,
      },
    ];
    const { events, ingestion } = services(mixed);
    const map = await buildCivicMap(events, ingestion, NOW, async () => true);
    expect(map).not.toBeNull();
    expect(map?.basins.map((basin) => basin.title)).toEqual(['Busy']);
    // …and no merge, because the edge to a node outside the landscape is not an
    // edge — the two stories share a topic but only one drew attention.
    expect(map?.merges).toEqual([]);
  });

  it('offers a bridge target only where THIS caller could act', async () => {
    // Reading the landscape is a platform-integrity power; opening a bridge
    // request on a room's conversation is a room-steward one. Publishing every
    // thread id rendered controls that deterministically 404.
    const rows = [
      {
        storyId: 'aaaaaaaa-1111-4111-8111-111111111111',
        title: 'A',
        topicIds: [TOPIC_A?.id ?? ''],
        events: 9,
      },
      {
        storyId: 'bbbbbbbb-2222-4222-8222-222222222222',
        title: 'B',
        topicIds: [TOPIC_A?.id ?? ''],
        events: 4,
      },
    ];
    const { events, ingestion } = services(rows);
    const unauthorized = await buildCivicMap(events, ingestion, NOW, async () => false);
    expect(unauthorized?.basins.every((basin) => basin.thread_id === null)).toBe(true);
    expect(unauthorized?.merges.every((saddle) => saddle.bridge_thread_id === null)).toBe(true);

    // …and the DEFAULT is that same closed answer, so a caller that forgets to
    // pass an authority resolver cannot publish targets by omission.
    const byDefault = await buildCivicMap(events, ingestion, NOW);
    expect(byDefault?.basins.every((basin) => basin.thread_id === null)).toBe(true);
  });

  it('hands the resolver a THREAD id and nothing else', async () => {
    // The resolver used to be handed the room and story alongside it, which
    // invited it to answer from what the MAP knows — and the map knows the
    // STORY row's room, not the room the conversation is in (WS-Q moves
    // threads). `bridgeEligibility` reads the thread itself, so the map cannot
    // hand it a stale room at all; what it must pass is the thread of the
    // node's own shell, not one derived from the story id.
    const seen: string[] = [];
    const rows: FakeStory[] = [
      {
        storyId: 'aaaaaaaa-1111-4111-8111-111111111111',
        title: 'A',
        topicIds: [TOPIC_A?.id ?? ''],
        events: 9,
        roomId: 'origin-room',
        threadRoomId: 'current-room',
      },
      {
        storyId: 'bbbbbbbb-2222-4222-8222-222222222222',
        title: 'B',
        topicIds: [TOPIC_A?.id ?? ''],
        events: 4,
        roomId: 'origin-room',
        threadRoomId: 'current-room',
      },
    ];
    const { events, ingestion } = services(rows);
    await buildCivicMap(events, ingestion, NOW, async (threadId) => {
      seen.push(threadId);
      return true;
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const threadId of seen) expect(threadId).toMatch(/^thread-/);
    // Memoized per story: one resolution per node, however many saddles sample it.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('reports whether the window was scanned to its END', async () => {
    // The landscape is bounded twice — a node cap and a scan ceiling — and a
    // partial hour drawn as the hour is the same defect as an empty report read
    // as a clean room. The completeness travels in the RESULT, so a consumer
    // cannot hold the node list without it.
    const rows = [
      {
        storyId: 'aaaaaaaa-1111-4111-8111-111111111111',
        title: 'A',
        topicIds: [TOPIC_A?.id ?? ''],
        events: 9,
      },
    ];
    const { events, ingestion } = services(rows);
    const map = await buildCivicMap(events, ingestion, NOW, async () => true);
    expect(map?.scan.complete).toBe(true);
    expect(map?.scan.examined).toBe(1);
  });

  it('calls a NODE-CAPPED window incomplete even when the batch was short', async () => {
    // The case between the two bounds: 101–199 active stories fill the 100-node
    // cap inside a batch that is itself shorter than the scan batch, so the walk
    // ended at the window AND dropped stories. Reading the short batch as "the
    // end" reported a bounded map as complete and suppressed the very warning
    // the field exists for.
    const rows = Array.from({ length: 150 }, (_, i) =>
      story(`${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`, 150 - i, [
        TOPIC_A?.id ?? '',
      ]),
    );
    const { events, ingestion } = services(rows);
    const map = await buildCivicMap(events, ingestion, NOW, async () => true);
    expect(map?.basins).toBeDefined();
    expect(map?.scan.complete).toBe(false);
    // Exactly the cap was drawn — the rest were never looked at.
    expect(map?.scan.examined).toBe(100);
  });

  it('bridges on a CONNECTING story, not on a basin peak', async () => {
    // Basins meet through their lower-level members: a peak about X joins a
    // peak about Z through an X/Y story, and the join is about Y. Opening on a
    // peak points the endpoint's SCOI baseline at a different conversation.
    const peakX = 'aaaaaaaa-1111-4111-8111-111111111111';
    const peakZ = 'bbbbbbbb-2222-4222-8222-222222222222';
    const bridgeXY = 'cccccccc-3333-4333-8333-333333333333';
    const rows = [
      { storyId: peakX, title: 'X peak', topicIds: [TOPIC_A?.id ?? ''], events: 20 },
      { storyId: peakZ, title: 'Z peak', topicIds: [TOPIC_B?.id ?? ''], events: 18 },
      {
        storyId: bridgeXY,
        title: 'The connector',
        topicIds: [TOPIC_A?.id ?? '', TOPIC_B?.id ?? ''],
        events: 2,
      },
    ];
    const { events, ingestion } = services(rows);
    const map = await buildCivicMap(events, ingestion, NOW, async () => true);
    const saddle = map?.merges[0];
    expect(saddle).toBeDefined();
    // The connector's thread, not either peak's.
    expect(saddle?.bridge_thread_id).toBe(`thread-${bridgeXY}`);
  });

  it('includes an ACTIVE older story that a recency bound would have cut', async () => {
    // The landscape starts from the window's active rows, so the bound applies
    // to what drew attention. Selecting by creation time first would drop this
    // busy older story in favour of quiet newer ones — and a hundred of those
    // would report an empty landscape for an hour that had real activity.
    const busyOld = 'aaaaaaaa-1111-4111-8111-111111111111';
    const rows = [
      { storyId: busyOld, title: 'Old but busy', topicIds: [TOPIC_A?.id ?? ''], events: 40 },
      {
        storyId: 'bbbbbbbb-2222-4222-8222-222222222222',
        title: 'New and quiet',
        topicIds: [TOPIC_A?.id ?? ''],
        events: 0,
      },
    ];
    const { events, ingestion } = services(rows);
    const map = await buildCivicMap(events, ingestion, NOW, async () => true);
    expect(map?.basins.map((basin) => basin.title)).toEqual(['Old but busy']);
  });

  it('keeps looking past restricted rows rather than spending the cap on them', async () => {
    // A window's busiest rows are not all public. Applying the node cap to the
    // candidate READ meant a run of high-activity restricted stories consumed
    // the whole budget and the map came back empty for an hour with real public
    // activity.
    const restricted = Array.from({ length: 150 }, (_unused, i) => ({
      storyId: `${String(i).padStart(8, '0')}-9999-4999-8999-999999999999`,
      title: `Restricted ${i}`,
      topicIds: [TOPIC_A?.id ?? ''],
      events: 1_000 - i,
    }));
    const publicOne = {
      storyId: 'aaaaaaaa-1111-4111-8111-111111111111',
      title: 'The public one',
      topicIds: [TOPIC_A?.id ?? ''],
      events: 5,
    };
    const { events } = services([...restricted, publicOne]);
    const ingestion = {
      stories: {
        // Only the public story hydrates — the rest are `room_only`/hidden, so
        // the public-only read does not return them.
        getPublicByIds: (ids: readonly string[]) =>
          Promise.resolve(
            new Map(ids.includes(publicOne.storyId) ? [[publicOne.storyId, publicOne]] : []),
          ),
        getThreadsByStoryIds: (ids: readonly string[]) =>
          Promise.resolve(new Map(ids.map((id) => [id, { threadId: `thread-${id}` }]))),
      },
    } as unknown as Parameters<typeof buildCivicMap>[1];
    const map = await buildCivicMap(events, ingestion, NOW, async () => true);
    expect(map?.basins.map((basin) => basin.title)).toEqual(['The public one']);
  });

  it('never surfaces the UNCLASSIFIED sentinel as a topic', async () => {
    const { events, ingestion } = services([
      story('11111111-1111-4111-8111-111111111111', 10, [UNCLASSIFIED_TOPIC_ID]),
      story('22222222-2222-4222-8222-222222222222', 4, [UNCLASSIFIED_TOPIC_ID]),
    ]);
    const map = await buildCivicMap(events, ingestion, NOW, async () => true);
    expect(map).not.toBe(null);
    if (!map) return;
    for (const basin of map.basins) {
      expect(basin.topics.map((topic) => topic.id)).not.toContain(UNCLASSIFIED_TOPIC_ID);
    }
    // …and two unclassified stories are NOT topic-adjacent, so they never join.
    expect(map.summary.merge_count).toBe(0);
  });

  it('is unaffected by stories arriving mid-request (enrichment is by id)', async () => {
    // `listRecent(n)` returns the n most recent AT THAT INSTANT, so a second
    // read could push graph members out of the window and blank live basins.
    // Enriching by the graph's own ids removes the race entirely.
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const rows = [
      { storyId: a, title: 'Original A', topicIds: [TOPIC_A?.id ?? ''] },
      { storyId: b, title: 'Original B', topicIds: [TOPIC_A?.id ?? ''] },
    ];
    const events = {
      windowStore: {
        listActiveInWindow: (_start: string, _size: string, limit: number) =>
          Promise.resolve(rows.slice(0, limit).map((r) => ({ itemId: r.storyId, eventCount: 5 }))),
      },
    } as unknown as Parameters<typeof buildCivicMap>[0];
    const busy = {
      stories: {
        // The landscape sees the two originals…
        // …and by enrichment time a flood of newer stories has landed. A
        // window-based re-read would miss both; an id-based one cannot.
        getPublicByIds: (ids: readonly string[]) =>
          Promise.resolve(
            new Map(rows.filter((r) => ids.includes(r.storyId)).map((r) => [r.storyId, r])),
          ),
        getThreadsByStoryIds: (ids: readonly string[]) =>
          Promise.resolve(new Map(ids.map((id) => [id, { threadId: `thread-${id}` }]))),
      },
    } as unknown as Parameters<typeof buildCivicMap>[1];
    const map = await buildCivicMap(events, busy, NOW, async () => true);
    expect(map).not.toBe(null);
    if (!map) return;
    for (const basin of map.basins) {
      expect(basin.title).not.toBe('Story unavailable');
      expect(basin.topics.length).toBeGreaterThan(0);
    }
  });

  it('leaves a story that stopped being public OUT of the landscape', async () => {
    // Assembly hydrates BEFORE it builds the graph, and the hydrated rows travel
    // with it — so a story that is no longer public never becomes a node, rather
    // than becoming one the map cannot name. The second by-id read that used to
    // produce a "Story unavailable" basin is gone, and with it the race.
    const gone = '33333333-3333-4333-8333-333333333333';
    const rows = [
      { storyId: gone, title: 'Vanishing', topicIds: [TOPIC_A?.id ?? ''] },
      {
        storyId: '22222222-2222-4222-8222-222222222222',
        title: 'Survivor',
        topicIds: [TOPIC_A?.id ?? ''],
      },
    ];
    const events = {
      windowStore: {
        listActiveInWindow: (_start: string, _size: string, limit: number) =>
          Promise.resolve(
            rows
              .slice(0, limit)
              .map((r) => ({ itemId: r.storyId, eventCount: r.storyId === gone ? 20 : 3 })),
          ),
      },
    } as unknown as Parameters<typeof buildCivicMap>[0];
    const deleting = {
      stories: {
        getPublicByIds: (ids: readonly string[]) =>
          Promise.resolve(
            new Map(
              rows
                .filter((r) => r.storyId !== gone && ids.includes(r.storyId))
                .map((r) => [r.storyId, r]),
            ),
          ),
        getThreadsByStoryIds: (ids: readonly string[]) =>
          Promise.resolve(new Map(ids.map((id) => [id, { threadId: `thread-${id}` }]))),
      },
    } as unknown as Parameters<typeof buildCivicMap>[1];
    const map = await buildCivicMap(events, deleting, NOW, async () => true);
    expect(map).not.toBe(null);
    expect(map?.basins.find((basin) => basin.basin_id === gone)).toBeUndefined();
    expect(map?.basins.map((basin) => basin.title)).toEqual(['Survivor']);
  });

  it('reports the window it swept and a coverage share', async () => {
    const { events, ingestion } = services([
      story('11111111-1111-4111-8111-111111111111', 10, [TOPIC_A?.id ?? '']),
      story('22222222-2222-4222-8222-222222222222', 4, [TOPIC_A?.id ?? '']),
      // Topic-isolated: it drags coverage below 1.
      story('44444444-4444-4444-8444-444444444444', 2, [TOPIC_B?.id ?? '']),
    ]);
    const map = await buildCivicMap(events, ingestion, NOW, async () => true);
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
    const map = await buildCivicMap(events, ingestion, NOW, async () => true);
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
