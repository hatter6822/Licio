// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Draft lifecycle tests (WS-G.3.7c): per-thread recovery listing, discard,
// the 30-day expiry sweep, and multi-thread isolation.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB_NAME, resetDbConnection } from './db.js';
import {
  DRAFT_MAX_AGE_MS,
  deleteDraft,
  expireOldDrafts,
  listDraftsForThread,
  loadDraft,
  saveDraft,
} from './drafts.js';

const THREAD_A = '11111111-1111-4111-8111-111111111111';
const THREAD_B = '22222222-2222-4222-8222-222222222222';

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

describe('WS-G.3.7c draft lifecycle', () => {
  it('lists drafts per thread (newest first) without cross-thread interference', async () => {
    await saveDraft({
      draftId: 'draft-a1',
      storyId: null,
      threadId: THREAD_A,
      contributionType: 'comment',
      values: { body: 'older' },
    });
    await saveDraft({
      draftId: 'draft-a2',
      storyId: null,
      threadId: THREAD_A,
      contributionType: 'correction',
      values: { body: 'newer' },
    });
    await saveDraft({
      draftId: 'draft-b1',
      storyId: null,
      threadId: THREAD_B,
      contributionType: 'comment',
      values: { body: 'other thread' },
    });
    const forA = await listDraftsForThread(THREAD_A);
    expect(forA.map((d) => d.draftId)).toEqual(['draft-a2', 'draft-a1']);
    // Decrypted round-trip: the recovered values are readable.
    expect(forA[0]?.values['body']).toBe('newer');
    const forB = await listDraftsForThread(THREAD_B);
    expect(forB).toHaveLength(1);
  });

  it('discard deletes exactly the chosen draft', async () => {
    await saveDraft({
      draftId: 'draft-x',
      storyId: null,
      threadId: THREAD_A,
      contributionType: 'comment',
      values: { body: 'x' },
    });
    await deleteDraft('draft-x');
    expect(await loadDraft('draft-x')).toBeUndefined();
  });

  it('expires drafts older than 30 days and keeps fresh ones', async () => {
    await saveDraft({
      draftId: 'draft-fresh',
      storyId: null,
      threadId: THREAD_A,
      contributionType: 'comment',
      values: { body: 'fresh' },
    });
    await saveDraft({
      draftId: 'draft-stale',
      storyId: null,
      threadId: THREAD_A,
      contributionType: 'comment',
      values: { body: 'stale' },
    });
    // Age the stale draft past the bound by sweeping from the future.
    const removed = await expireOldDrafts(Date.now() + DRAFT_MAX_AGE_MS + 1_000);
    expect(removed).toBe(2); // both are "old" from that vantage
    // A fresh save right before a NOW sweep survives.
    await saveDraft({
      draftId: 'draft-now',
      storyId: null,
      threadId: THREAD_A,
      contributionType: 'comment',
      values: { body: 'now' },
    });
    expect(await expireOldDrafts()).toBe(0);
    expect(await loadDraft('draft-now')).toBeDefined();
  });
});
