// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB_NAME, resetDbConnection } from './db.js';
import {
  count,
  enqueue,
  get,
  list,
  listByStatus,
  listPending,
  markFailed,
  markForRetry,
  markInFlight,
  remove,
} from './queue.js';

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

describe('pending queue', () => {
  it('enqueues operations and lists them oldest-first', async () => {
    const first = await enqueue('contribution', { a: 1 }, 'op-a');
    const second = await enqueue('report', { b: 2 }, 'op-b');
    const all = await list();
    expect(all.map((o) => o.operationId)).toEqual([first, second]);
    expect(all[0]?.status).toBe('pending');
    expect(all[0]?.attempts).toBe(0);
    expect(await count()).toBe(2);
  });

  it('transitions through in-flight and removes only on success', async () => {
    await enqueue('contribution', { a: 1 }, 'op-1');
    await markInFlight('op-1');
    expect((await get('op-1'))?.status).toBe('in-flight');
    await remove('op-1');
    expect(await get('op-1')).toBeUndefined();
    expect(await count()).toBe(0);
  });

  it('markForRetry increments attempts and returns to pending', async () => {
    await enqueue('attention-aggregate', { x: 1 }, 'op-2');
    await markInFlight('op-2');
    await markForRetry('op-2', 'network error');
    const op = await get('op-2');
    expect(op?.status).toBe('pending');
    expect(op?.attempts).toBe(1);
    expect(op?.lastError).toBe('network error');
    expect(await listPending()).toHaveLength(1);
  });

  it('markFailed keeps the record for manual retry (never silently lost)', async () => {
    await enqueue('report', { y: 1 }, 'op-3');
    await markFailed('op-3', 'thread locked');
    const failed = await listByStatus('failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.lastError).toBe('thread locked');
    expect(await count()).toBe(1);
  });

  it('is a no-op when updating an unknown operation', async () => {
    await expect(markInFlight('missing')).resolves.toBeUndefined();
    expect(await count()).toBe(0);
  });
});
