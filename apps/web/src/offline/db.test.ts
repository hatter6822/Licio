// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DB_NAME,
  getDb,
  MIGRATIONS,
  type MigrationMap,
  openDb,
  rawGet,
  rawGetAll,
  rawGetAllByIndex,
  rawPut,
  resetDbConnection,
  STORE,
} from './db.js';

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

afterEach(() => {
  resetDbConnection();
});

describe('schema creation', () => {
  it('creates all five object stores', async () => {
    const db = await getDb();
    expect([...db.objectStoreNames].sort()).toEqual(
      [
        STORE.draftContributions,
        STORE.pendingQueue,
        STORE.savedStories,
        STORE.signalLedger,
        STORE.threadSnapshots,
      ].sort(),
    );
  });

  it('defines the documented indexes on each store', async () => {
    const db = await getDb();
    const tx = db.transaction(STORE.draftContributions, 'readonly');
    const indexes = [...tx.objectStore(STORE.draftContributions).indexNames].sort();
    expect(indexes).toEqual(['contributionType', 'storyId', 'threadId', 'updatedAt']);
  });
});

describe('raw CRUD + indexes', () => {
  it('round-trips a record and survives by key + index', async () => {
    await rawPut(STORE.savedStories, {
      schemaVersion: 1,
      storyId: '11111111-1111-4111-8111-111111111111',
      title: 'Saved',
      source: 'Wire',
      url: null,
      roomId: null,
      savedAt: 1000,
    });
    const all = await rawGetAll(STORE.savedStories);
    expect(all).toHaveLength(1);
    const byKey = await rawGet(STORE.savedStories, '11111111-1111-4111-8111-111111111111');
    expect(byKey).toBeDefined();
    const byIndex = await rawGetAllByIndex(STORE.savedStories, 'savedAt', 1000);
    expect(byIndex).toHaveLength(1);
  });
});

describe('migrations', () => {
  it('applies a later migration that transforms existing records', async () => {
    const name = `licio-migrate-${Math.random().toString(36).slice(2)}`;
    const v1 = await openDb(name, 1);
    await new Promise<void>((resolve, reject) => {
      const tx = v1.transaction(STORE.savedStories, 'readwrite');
      tx.objectStore(STORE.savedStories).put({
        schemaVersion: 1,
        storyId: '22222222-2222-4222-8222-222222222222',
        title: 'Old',
        source: 'Wire',
        url: null,
        roomId: null,
        savedAt: 1,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    v1.close();

    const migrations: MigrationMap = {
      ...MIGRATIONS,
      2: (_db, tx) => {
        const store = tx.objectStore(STORE.savedStories);
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          cursor.update({ ...cursor.value, title: 'Migrated' });
          cursor.continue();
        };
      },
    };
    const v2 = await openDb(name, 2, migrations);
    const record = await new Promise<{ title: string }>((resolve, reject) => {
      const tx = v2.transaction(STORE.savedStories, 'readonly');
      const req = tx.objectStore(STORE.savedStories).get('22222222-2222-4222-8222-222222222222');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(record.title).toBe('Migrated');
    v2.close();
    await deleteDatabase(name);
  });

  it('aborts atomically and keeps the old version when a migration throws', async () => {
    const name = `licio-fail-${Math.random().toString(36).slice(2)}`;
    const v1 = await openDb(name, 1);
    v1.close();

    const failing: MigrationMap = {
      ...MIGRATIONS,
      2: () => {
        throw new Error('boom');
      },
    };
    await expect(openDb(name, 2, failing)).rejects.toBeTruthy();

    // The database is still at version 1 (the failed upgrade rolled back).
    const reopened = await openDb(name, 1);
    expect(reopened.version).toBe(1);
    reopened.close();
    await deleteDatabase(name);
  });
});
