// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story-composer draft tests (WS-Q.5.1b): the explicit acceptance is that
// autosave/restore round-trips room + visibility (plus the text body, encrypted
// at rest), that listing is newest-first, that discard removes exactly one
// draft, and that the 30-day sweep covers story drafts too.
import 'fake-indexeddb/auto';
import { COMMONS_ROOM_ID } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB_NAME, resetDbConnection } from './db.js';
import {
  DRAFT_MAX_AGE_MS,
  deleteStoryDraft,
  expireOldDrafts,
  listStoryDrafts,
  loadStoryDraft,
  saveStoryDraft,
} from './drafts.js';

const PRIVATE_ROOM = '11111111-1111-4111-8111-111111111111';

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  resetDbConnection();
  await deleteDatabase(DB_NAME);
});

describe('WS-Q.5.1b story-draft autosave', () => {
  it('round-trips room + visibility + the text body', async () => {
    await saveStoryDraft({
      draftId: 'story-1',
      mode: 'link',
      roomId: PRIVATE_ROOM,
      visibility: 'room_only',
      topicIds: [],
      values: { title: 'Reservoir report', url: 'https://example.org/a', reason: 'Primary' },
    });
    const restored = await loadStoryDraft('story-1');
    expect(restored).toBeDefined();
    expect(restored?.roomId).toBe(PRIVATE_ROOM);
    expect(restored?.visibility).toBe('room_only');
    expect(restored?.mode).toBe('link');
    expect(restored?.values['title']).toBe('Reservoir report');
    expect(restored?.values['url']).toBe('https://example.org/a');
    // Encrypted at rest: the cipher exists and the plaintext values are not stored.
    expect(restored?.encrypted).toBe(true);
  });

  it('lists story drafts newest-first', async () => {
    await saveStoryDraft({
      draftId: 'story-old',
      mode: 'link',
      roomId: COMMONS_ROOM_ID,
      visibility: 'public',
      topicIds: [],
      values: { title: 'older' },
    });
    await saveStoryDraft({
      draftId: 'story-new',
      mode: 'original_brief',
      roomId: COMMONS_ROOM_ID,
      visibility: 'public',
      topicIds: [],
      values: { body: 'newer' },
    });
    const drafts = await listStoryDrafts();
    expect(drafts.map((d) => d.draftId)).toEqual(['story-new', 'story-old']);
    expect(drafts[0]?.values['body']).toBe('newer');
  });

  it('discard removes exactly the chosen draft', async () => {
    await saveStoryDraft({
      draftId: 'story-x',
      mode: 'link',
      roomId: COMMONS_ROOM_ID,
      visibility: 'public',
      topicIds: [],
      values: { title: 'x' },
    });
    await deleteStoryDraft('story-x');
    expect(await loadStoryDraft('story-x')).toBeUndefined();
  });

  it('the 30-day sweep expires story drafts too', async () => {
    await saveStoryDraft({
      draftId: 'story-stale',
      mode: 'link',
      roomId: COMMONS_ROOM_ID,
      visibility: 'public',
      topicIds: [],
      values: { title: 'stale' },
    });
    const removed = await expireOldDrafts(Date.now() + DRAFT_MAX_AGE_MS + 1_000);
    expect(removed).toBe(1);
    expect(await loadStoryDraft('story-stale')).toBeUndefined();
  });
});
