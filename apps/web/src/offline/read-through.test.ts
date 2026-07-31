// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import type {
  SignalLedgerEntry,
  StoryCommentsResponse,
  StoryDetail,
  ThreadDetail,
} from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rawPut, STORE } from './db.js';
import {
  cacheSignalLedger,
  cacheStoryCommentsSnapshot,
  cacheThreadSnapshot,
  expireOldSnapshots,
  isStorySaved,
  listSavedStories,
  MAX_STORY_COMMENT_SNAPSHOTS,
  MAX_THREAD_SNAPSHOTS,
  readCachedSignalLedger,
  readStoryCommentsSnapshot,
  readThreadSnapshot,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_TRIM_RATIO,
  saveStory,
  unsaveStory,
} from './read-through.js';
import {
  draftContributions,
  savedStories,
  signalLedger,
  storyComments,
  threadSnapshots,
} from './store.js';

const STORY: StoryDetail = {
  story_id: '11111111-1111-4111-8111-111111111111',
  title: 'A measured headline',
  source: 'example.org',
  url: 'https://example.org/a',
  reading_minutes: 4,
  sources_count: 0,
  corrections: { active: 0, validated: 0, incorrect: 0 },
  more_on_this_story: [],
  context_chips: [],
  safety_state: 'ok',
  dispute_status: 'none',
  body_summary: 'A short, structurally honest summary.',
  thread_id: null,
  topic_ids: [],
};

const LEDGER_ENTRY: SignalLedgerEntry = {
  item_id: '22222222-2222-4222-8222-222222222222',
  story_title: 'Tracked story',
  recorded_at: '2026-06-09T13:00:00.000Z',
  active_dwell_bucket: 'medium',
  source_opened: true,
  context_opened: false,
  reply_depth_bucket: 'moderate',
  return_visit_count_bucket: 'few',
  saved_for_later: true,
  anti_signals: ['rapid_repetition', 'coordinated_burst'],
  summary: 'You read this for a moderate duration and opened the source.',
  cap_reached: false,
};

const THREAD: ThreadDetail = {
  thread_id: '33333333-3333-4333-8333-333333333333',
  story_id: STORY.story_id,
  room_id: null,
  branch_index: 0,
  title: 'A deliberative thread',
  conversation_state: 'active',
  safety_state: 'normal',
  contribution_count: 2,
  created_at: '2026-06-09T12:00:00.000Z',
  updated_at: '2026-06-09T12:00:00.000Z',
  sections: { sources: 1, challenges: 0, chronology: 2 },
};

const COMMENTS: StoryCommentsResponse = {
  comments: [],
  next_cursor: null,
  anchor: null,
  overview: {
    comment_count: 0,
    sources_count: 0,
    corrections_count: 0,
    debates_count: 0,
    incorrect_count: 0,
  },
};

beforeEach(async () => {
  await Promise.all([
    savedStories.clear(),
    signalLedger.clear(),
    threadSnapshots.clear(),
    storyComments.clear(),
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('saved stories', () => {
  it('saves, reports saved, lists, and unsaves a story', async () => {
    expect(await isStorySaved(STORY.story_id)).toBe(false);
    await saveStory(STORY);
    expect(await isStorySaved(STORY.story_id)).toBe(true);

    const list = await listSavedStories();
    expect(list).toHaveLength(1);
    expect(list[0]?.storyId).toBe(STORY.story_id);
    expect(list[0]?.url).toBe(STORY.url);

    await unsaveStory(STORY.story_id);
    expect(await isStorySaved(STORY.story_id)).toBe(false);
    expect(await listSavedStories()).toHaveLength(0);
  });

  it('orders saved stories most-recently-saved first', async () => {
    await saveStory({ ...STORY, story_id: '44444444-4444-4444-8444-444444444444' });
    await new Promise((r) => setTimeout(r, 2));
    await saveStory(STORY); // saved later
    const list = await listSavedStories();
    expect(list[0]?.storyId).toBe(STORY.story_id);
  });

  it('is best-effort: a storage error never throws', async () => {
    vi.spyOn(savedStories, 'put').mockRejectedValueOnce(new Error('quota'));
    await expect(saveStory(STORY)).resolves.toBeUndefined();
  });
});

describe('signal ledger cache (non-lossy round-trip)', () => {
  it('caches and reads back the private ledger', async () => {
    await cacheSignalLedger([LEDGER_ENTRY]);
    const cached = await readCachedSignalLedger();
    expect(cached).toEqual([LEDGER_ENTRY]);
  });

  it('replaces the snapshot on each cache write', async () => {
    await cacheSignalLedger([LEDGER_ENTRY]);
    await cacheSignalLedger([{ ...LEDGER_ENTRY, item_id: '55555555-5555-4555-8555-555555555555' }]);
    const cached = await readCachedSignalLedger();
    expect(cached).toHaveLength(1);
    expect(cached[0]?.item_id).toBe('55555555-5555-4555-8555-555555555555');
  });

  it('returns an empty array when the read fails', async () => {
    vi.spyOn(signalLedger, 'getAll').mockRejectedValueOnce(new Error('offline'));
    expect(await readCachedSignalLedger()).toEqual([]);
  });
});

describe('thread snapshot cache', () => {
  it('caches a thread title and reads it back', async () => {
    await cacheThreadSnapshot(THREAD);
    const record = await readThreadSnapshot(THREAD.thread_id);
    expect(record?.title).toBe(THREAD.title);
  });

  it('returns undefined for an uncached thread', async () => {
    expect(await readThreadSnapshot(THREAD.thread_id)).toBeUndefined();
  });
});

describe('snapshot count caps (the bound age alone does not give)', () => {
  /** A distinct valid UUID per index (the record schema requires one). */
  function threadId(index: number): string {
    return `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
  }

  /** Distinct, strictly increasing `cachedAt` values so LRU order is exact. */
  function monotonicClock(): void {
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 1_000;
      return clock;
    });
  }

  it('caps story-comment snapshots and drops the OLDEST first', async () => {
    monotonicClock();
    // One story, many option keys — the real growth shape: each sort order /
    // filter / drill-down root / depth mints its own full-tree record.
    for (let i = 0; i <= MAX_STORY_COMMENT_SNAPSHOTS; i += 1) {
      await cacheStoryCommentsSnapshot(STORY.story_id, { order: `o${i}` }, COMMENTS);
    }
    const target = Math.floor(MAX_STORY_COMMENT_SNAPSHOTS * SNAPSHOT_TRIM_RATIO);
    expect(await storyComments.count()).toBe(target);
    // The first write is gone; the last survives.
    expect(await readStoryCommentsSnapshot(STORY.story_id, { order: 'o0' })).toBeUndefined();
    expect(
      await readStoryCommentsSnapshot(STORY.story_id, {
        order: `o${MAX_STORY_COMMENT_SNAPSHOTS}`,
      }),
    ).toBeDefined();
  });

  it('caps thread snapshots and drops the OLDEST first', async () => {
    monotonicClock();
    for (let i = 0; i <= MAX_THREAD_SNAPSHOTS; i += 1) {
      await cacheThreadSnapshot({ ...THREAD, thread_id: threadId(i) });
    }
    const target = Math.floor(MAX_THREAD_SNAPSHOTS * SNAPSHOT_TRIM_RATIO);
    expect(await threadSnapshots.count()).toBe(target);
    expect(await readThreadSnapshot(threadId(0))).toBeUndefined();
    expect(await readThreadSnapshot(threadId(MAX_THREAD_SNAPSHOTS))).toBeDefined();
  });

  it('leaves an under-budget store completely alone', async () => {
    await cacheStoryCommentsSnapshot(STORY.story_id, { order: 'oldest' }, COMMENTS);
    await cacheStoryCommentsSnapshot(STORY.story_id, { order: 'newest' }, COMMENTS);
    expect(await storyComments.count()).toBe(2);
  });

  it('an index-invisible record does not steal the budget', async () => {
    monotonicClock();
    // A record with no `cachedAt` is omitted from the index, so the LRU trim can
    // never list it — while `count()` counted it against the cap regardless.  The
    // store therefore settled BELOW the budget in real snapshots and ABOVE it in
    // records, and every write past the crossover re-ran the full scan that the
    // 90% trim ratio exists to amortise.
    const ORPHANS = 50;
    for (let i = 0; i < ORPHANS; i += 1) {
      await rawPut(STORE.storyComments, { cacheKey: `orphan-${i}` });
    }
    for (let i = 0; i < MAX_STORY_COMMENT_SNAPSHOTS; i += 1) {
      await cacheStoryCommentsSnapshot(STORY.story_id, { order: `o${i}` }, COMMENTS);
    }
    // Every slot the budget promises is available to real snapshots.
    expect(await storyComments.countByIndex('cachedAt')).toBe(MAX_STORY_COMMENT_SNAPSHOTS);
    // The store as a whole is over budget, which is what the reap below is for.
    expect(await storyComments.count()).toBe(MAX_STORY_COMMENT_SNAPSHOTS + ORPHANS);
  });

  it('is best-effort: a trim failure never throws into the read path', async () => {
    // `countByIndex`, not `count`: the guard counts the population the trim can
    // actually see, and mocking the method it no longer calls made this pass
    // without exercising a failure at all.
    vi.spyOn(storyComments, 'countByIndex').mockRejectedValueOnce(new Error('quota'));
    await expect(cacheStoryCommentsSnapshot(STORY.story_id, {}, COMMENTS)).resolves.toBeUndefined();
  });
});

describe('snapshot expiry (unbounded-growth control)', () => {
  it('deletes stale snapshots while fresh snapshots and user data survive', async () => {
    // Snapshots + unrelated durable user data, all cached "now".
    await cacheThreadSnapshot(THREAD);
    await cacheStoryCommentsSnapshot(STORY.story_id, {}, COMMENTS);
    await saveStory(STORY);
    await cacheSignalLedger([LEDGER_ENTRY]);

    // Sweep from a point past the max age: every snapshot is now stale.
    await expireOldSnapshots(Date.now() + SNAPSHOT_MAX_AGE_MS + 1_000);

    expect(await readThreadSnapshot(THREAD.thread_id)).toBeUndefined();
    expect(await readStoryCommentsSnapshot(STORY.story_id, {})).toBeUndefined();
    // Explicit saves, the private ledger, and the pending queue are untouched.
    expect(await isStorySaved(STORY.story_id)).toBe(true);
    expect(await readCachedSignalLedger()).toHaveLength(1);
  });

  it('reaps snapshots the cachedAt index cannot see, and never user data', async () => {
    // Invisible to the age sweep AND the LRU trim: nothing could remove these, so
    // they held their share of the quota until the browser evicted the whole
    // database — which takes the reader's UNSENT drafts with it.  Both snapshot
    // stores are server-refetchable, so dropping them costs a refetch.
    await rawPut(STORE.storyComments, { cacheKey: 'orphan-comments' });
    await rawPut(STORE.threadSnapshots, { threadId: 'orphan-thread' });
    await cacheStoryCommentsSnapshot(STORY.story_id, {}, COMMENTS);
    // User data with no indexable `updatedAt` — equally unreachable, and NOT ours
    // to delete: an unreachable draft is still the user's words.
    await rawPut(STORE.draftContributions, { draftId: 'orphan-draft' });

    await expireOldSnapshots();

    expect(await storyComments.count()).toBe(1);
    expect(await readStoryCommentsSnapshot(STORY.story_id, {})).toBeDefined();
    expect(await threadSnapshots.count()).toBe(0);
    expect(await draftContributions.count()).toBe(1);
    // And the quarantine policy refuses the reap outright, not just in this sweep.
    expect(await draftContributions.reapUnindexed('updatedAt')).toBe(0);
    expect(await draftContributions.count()).toBe(1);
  });

  it('leaves fresh snapshots in place', async () => {
    await cacheThreadSnapshot(THREAD);
    await cacheStoryCommentsSnapshot(STORY.story_id, {}, COMMENTS);

    await expireOldSnapshots();

    expect(await readThreadSnapshot(THREAD.thread_id)).toBeDefined();
    expect(await readStoryCommentsSnapshot(STORY.story_id, {})).toBeDefined();
  });

  it('is best-effort: a storage error never throws', async () => {
    vi.spyOn(storyComments, 'getAllByIndex').mockRejectedValueOnce(new Error('offline'));
    await expect(expireOldSnapshots()).resolves.toBeUndefined();
  });

  it('an invalid snapshot record cannot evade the expiry sweep (evicted on scan)', async () => {
    // A stale record whose cached comment carries a pre-WS-T-rework shape: it
    // fails read validation, so the sweep's validated read excludes it from the
    // delete list — under quarantine semantics it would be IMMORTAL, re-warning
    // on every sweep. The evict policy deletes it during the scan itself.
    await rawPut(STORE.storyComments, {
      schemaVersion: 2,
      cacheKey: `${STORY.story_id}:stale`,
      storyId: STORY.story_id,
      optionsKey: '{}',
      comments: [{ type: 'evidence', metadata: { evidence_type: 'primary' } }],
      nextCursor: null,
      overview: { comment_count: 1, sources_count: 1, corrections_count: 0 },
      cachedAt: 1,
    });
    // A second invalid row whose KEY FIELD itself is corrupted (a number is a
    // valid IDB key but an invalid record value) — the sweep's index scan must
    // still evict it, via the true primary key from getAllKeys.
    await rawPut(STORE.storyComments, {
      schemaVersion: 2,
      cacheKey: 42,
      storyId: STORY.story_id,
      optionsKey: '{}',
      comments: [],
      nextCursor: null,
      overview: { comment_count: 0, sources_count: 0, corrections_count: 0 },
      cachedAt: 1,
    });

    await expireOldSnapshots(Date.now() + SNAPSHOT_MAX_AGE_MS + 1_000);
    expect(await storyComments.count()).toBe(0);
  });
});
