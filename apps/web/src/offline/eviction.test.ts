// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, rawClear, resetDbConnection, STORE } from './db.js';
import {
  initEvictionDetection,
  probeStorageIntegrity,
  requestPersistentStorage,
  snapshotStorage,
} from './eviction.js';
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

    // REAL eviction: records vanish WITHOUT a confirmed ack (raw store wipe),
    // unlike queue.remove() which is a legitimate acknowledged removal.
    await rawClear(STORE.pendingQueue);

    const result = await probeStorageIntegrity();
    expect(result.verdict).toBe('evicted');
    expect(result.lostPending).toBe(true);
  });

  it('does not flag a legitimate acked drain (e.g. background sync) as eviction', async () => {
    await queue.enqueue('contribution', { a: 1 }, 'op-1');
    await queue.enqueue('report', { b: 2 }, 'op-2');
    await snapshotStorage(); // snapshot: pending = 2

    // The queue drains via confirmed acks (could be a background-sync flush while
    // hidden) — pending drops to 0 but every removal was acknowledged.
    await queue.remove('op-1');
    await queue.remove('op-2');

    const result = await probeStorageIntegrity();
    expect(result.verdict).toBe('ok');
    expect(result.lostPending).toBe(false);
  });

  it('re-baselines after an eviction so it is not re-reported', async () => {
    await queue.enqueue('contribution', { a: 1 }, 'op-1');
    await snapshotStorage();
    await rawClear(STORE.pendingQueue);

    expect((await probeStorageIntegrity()).verdict).toBe('evicted');
    expect((await probeStorageIntegrity()).verdict).toBe('ok');
  });
});

describe('initEvictionDetection', () => {
  it('coalesces the bfcache pageshow+visibilitychange pair into a single onEvicted', async () => {
    await queue.enqueue('contribution', { a: 1 }, 'op-1');
    await snapshotStorage(); // snapshot: pending = 1
    await rawClear(STORE.pendingQueue); // real eviction

    const onEvicted = vi.fn();
    const teardown = initEvictionDetection({ onEvicted });

    // A bfcache restore fires BOTH events; the two overlapping probes must
    // share one in-flight probe so eviction is reported exactly once.
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));

    // Let the coalesced probe resolve. The probe is an async IndexedDB read, so
    // under parallel load it can take more than one macrotask — wait for the
    // callback rather than a fixed tick (the fixed tick was a load-sensitive
    // flake). `waitFor` also holds the coalescing guarantee: a second probe
    // would drive the count to 2 and it would never settle on 1.
    await vi.waitFor(() => expect(onEvicted).toHaveBeenCalledTimes(1));
    teardown();
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
