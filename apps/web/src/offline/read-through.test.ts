// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import type { SignalLedgerEntry, StoryDetail, ThreadDetail } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheSignalLedger,
  cacheThreadSnapshot,
  isStorySaved,
  listSavedStories,
  readCachedSignalLedger,
  readThreadSnapshot,
  saveStory,
  unsaveStory,
} from './read-through.js';
import { savedStories, signalLedger, threadSnapshots } from './store.js';

const STORY: StoryDetail = {
  story_id: '11111111-1111-4111-8111-111111111111',
  title: 'A measured headline',
  source: 'example.org',
  origin: 'independent',
  url: 'https://example.org/a',
  reading_minutes: 4,
  rating_label: 'well-sourced',
  exposure_label: null,
  distribution_reason: 'Read by people who also read primary sources.',
  context_chips: [],
  safety_state: 'ok',
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
  branch_depth_bucket: 'moderate',
  return_visit_count_bucket: 'few',
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
  sections: { overview: 1, questions: 0, evidence: 1, challenges: 0, lenses: 0, chronology: 2 },
  summary_status: 'community_synthesis',
  current_summary: {
    summary_id: '44444444-4444-4444-8444-444444444444',
    thread_id: '33333333-3333-4333-8333-333333333333',
    layer: 'community_synthesis',
    body: 'Where the conversation stands.',
    cited_branch_ids: [],
    cited_evidence_ids: [],
    unresolved_uncertainty: 'Open question.',
    minority_views_note: null,
    machine_generated: false,
    authored_by_handle: 'mara',
    approved_by_handle: null,
    created_at: '2026-06-09T12:00:00.000Z',
    updated_at: '2026-06-09T12:00:00.000Z',
  },
  summary_layers: ['community_synthesis'],
};

beforeEach(async () => {
  await Promise.all([savedStories.clear(), signalLedger.clear(), threadSnapshots.clear()]);
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
  it('caches a thread summary and reads it back', async () => {
    await cacheThreadSnapshot(THREAD);
    const record = await readThreadSnapshot(THREAD.thread_id);
    expect(record?.title).toBe(THREAD.title);
    expect(record?.summary).toBe(THREAD.current_summary?.body);
  });

  it('stores an empty summary when the thread has none', async () => {
    await cacheThreadSnapshot({ ...THREAD, current_summary: null });
    const record = await readThreadSnapshot(THREAD.thread_id);
    expect(record?.summary).toBe('');
  });

  it('returns undefined for an uncached thread', async () => {
    expect(await readThreadSnapshot(THREAD.thread_id)).toBeUndefined();
  });
});
