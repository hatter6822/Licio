// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB_NAME, rawPut, resetDbConnection, STORE } from './db.js';
import type { SavedStoryRecord } from './schemas.js';
import {
  drainRejectionDeltas,
  getRejectionCount,
  resetRejectionCounts,
  savedStories,
} from './store.js';

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

const RECORD: SavedStoryRecord = {
  schemaVersion: 2,
  storyId: '11111111-1111-4111-8111-111111111111',
  title: 'Saved',
  source: 'Wire',
  url: null,
  roomId: null,
  savedAt: 1000,
};

beforeEach(async () => {
  resetDbConnection();
  resetRejectionCounts();
  await deleteDatabase(DB_NAME);
});

describe('integrity store writes', () => {
  it('validates and stores a well-formed record', async () => {
    await savedStories.put(RECORD);
    expect(await savedStories.get(RECORD.storyId)).toEqual(RECORD);
    expect(await savedStories.count()).toBe(1);
  });

  it('rejects an invalid record on write', async () => {
    await expect(
      savedStories.put({ ...RECORD, savedAt: -5 } as SavedStoryRecord),
    ).rejects.toBeTruthy();
  });
});

describe('integrity store reads (quarantine on invalid)', () => {
  it('excludes a record that fails read validation and counts it, leaving it in place', async () => {
    await savedStories.put(RECORD);
    // Insert a corrupt record directly, bypassing write validation.
    await rawPut(STORE.savedStories, {
      schemaVersion: 2,
      storyId: '22222222-2222-4222-8222-222222222222',
      title: 'Corrupt',
      // missing `source`, `savedAt`, etc.
    });

    const valid = await savedStories.getAll();
    expect(valid).toHaveLength(1);
    expect(valid[0]?.storyId).toBe(RECORD.storyId);
    expect(getRejectionCount(STORE.savedStories)).toBe(1);

    // Quarantined (not deleted): the raw record is still present for recovery.
    expect(await savedStories.count()).toBe(2);
  });

  it('returns undefined (not the raw value) for an invalid single read', async () => {
    await rawPut(STORE.savedStories, { storyId: 'x', bogus: true });
    expect(await savedStories.get('x')).toBeUndefined();
  });

  it('drains exactly one delta per new rejection (delta semantics)', async () => {
    // Corrupt a record, then read it through the store to trigger a quarantine.
    await rawPut(STORE.savedStories, {
      schemaVersion: 2,
      storyId: '44444444-4444-4444-8444-444444444444',
      title: 'Corrupt',
    });
    await savedStories.getAll();

    const first = drainRejectionDeltas();
    expect(first).toEqual([{ store: STORE.savedStories, count: 1 }]);

    // A subsequent drain with no new rejection returns nothing (no re-report).
    expect(drainRejectionDeltas()).toEqual([]);
  });

  it('queries by index, validating each result', async () => {
    await savedStories.put(RECORD);
    await savedStories.put({
      ...RECORD,
      storyId: '33333333-3333-4333-8333-333333333333',
      savedAt: 2000,
    });
    const recent = await savedStories.getAllByIndex('savedAt', IDBKeyRange.lowerBound(1500));
    expect(recent).toHaveLength(1);
    expect(recent[0]?.savedAt).toBe(2000);
  });
});
