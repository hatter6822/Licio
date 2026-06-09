// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, resetDbConnection } from './db.js';
import { probeStorageIntegrity, requestPersistentStorage, snapshotStorage } from './eviction.js';
import * as queue from './queue.js';

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
  localStorage.clear();
  await deleteDatabase(DB_NAME);
});

describe('probeStorageIntegrity', () => {
  it('reports first-run when no snapshot exists yet', async () => {
    const result = await probeStorageIntegrity();
    expect(result.verdict).toBe('first-run');
  });

  it('reports ok when counts are unchanged since the snapshot', async () => {
    await queue.enqueue('contribution', { a: 1 }, 'op-1');
    await snapshotStorage();
    const result = await probeStorageIntegrity();
    expect(result.verdict).toBe('ok');
    expect(result.lostPending).toBe(false);
  });

  it('detects eviction when the pending queue lost data while hidden', async () => {
    await queue.enqueue('contribution', { a: 1 }, 'op-1');
    await queue.enqueue('report', { b: 2 }, 'op-2');
    await snapshotStorage(); // snapshot: pending = 2

    // Simulate eviction: the queue is wiped while the app is backgrounded.
    await queue.remove('op-1');
    await queue.remove('op-2');

    const result = await probeStorageIntegrity();
    expect(result.verdict).toBe('evicted');
    expect(result.lostPending).toBe(true);
  });

  it('re-baselines after an eviction so it is not re-reported', async () => {
    await queue.enqueue('contribution', { a: 1 }, 'op-1');
    await snapshotStorage();
    await queue.remove('op-1');

    expect((await probeStorageIntegrity()).verdict).toBe('evicted');
    expect((await probeStorageIntegrity()).verdict).toBe('ok');
  });
});

describe('requestPersistentStorage', () => {
  it('returns false when the Storage API is unavailable', async () => {
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it('returns the grant result when persist() is available', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', { storage: { persist } });
    await expect(requestPersistentStorage()).resolves.toBe(true);
    vi.unstubAllGlobals();
  });
});
