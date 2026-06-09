// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../lib/api.js';
import { DB_NAME, resetDbConnection } from './db.js';
import * as queue from './queue.js';

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    createContribution: vi.fn(),
    createReport: vi.fn(),
    uploadAttentionAggregates: vi.fn(),
  };
});

const api = await import('../lib/api.js');
const { MAX_QUEUE_ATTEMPTS, processPendingQueue, requestBackgroundSync, SYNC_TAG } = await import(
  './sync.js'
);

const CONTRIBUTION_PAYLOAD = {
  thread_id: '11111111-1111-4111-8111-111111111111',
  branch: 'evidence',
  type: 'evidence',
  body: 'A source.',
  citations: [],
  local_draft_id: 'draft-1',
};

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
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Stub a Background-Sync-capable environment and return the register spy. */
function stubSyncEnv() {
  const register = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {
    serviceWorker: { ready: Promise.resolve({ sync: { register } }) },
  });
  vi.stubGlobal('window', { SyncManager: class {} });
  return register;
}

describe('requestBackgroundSync', () => {
  it('registers the queue sync tag when Background Sync is available', async () => {
    const register = stubSyncEnv();
    await requestBackgroundSync();
    expect(register).toHaveBeenCalledWith(SYNC_TAG);
  });

  it('is a no-op when Background Sync is unavailable', async () => {
    vi.stubGlobal('window', {}); // no SyncManager
    await expect(requestBackgroundSync()).resolves.toBeUndefined();
  });
});

describe('processPendingQueue', () => {
  it('sends a queued contribution and removes it on success', async () => {
    vi.mocked(api.createContribution).mockResolvedValue({} as never);
    await queue.enqueue('contribution', CONTRIBUTION_PAYLOAD, 'op-1');

    const result = await processPendingQueue();
    expect(result.sent).toBe(1);
    expect(await queue.count()).toBe(0);
  });

  it('parks a 4xx server rejection as terminal and preserves it for manual retry', async () => {
    vi.mocked(api.createContribution).mockRejectedValue(
      new ApiClientError('thread_locked', 'Thread is locked', 423),
    );
    await queue.enqueue('contribution', CONTRIBUTION_PAYLOAD, 'op-2');

    const onTerminalFailure = vi.fn();
    const result = await processPendingQueue({ onTerminalFailure });
    expect(result.failed).toBe(1);
    expect(onTerminalFailure).toHaveBeenCalledOnce();
    const op = await queue.get('op-2');
    expect(op?.status).toBe('failed');
    expect(await queue.count()).toBe(1); // never silently dropped
  });

  it('retries a transient failure and increments attempts', async () => {
    vi.mocked(api.createContribution).mockRejectedValue(
      new ApiClientError('http_503', 'Service unavailable', 503),
    );
    await queue.enqueue('contribution', CONTRIBUTION_PAYLOAD, 'op-3');

    const result = await processPendingQueue();
    expect(result.retried).toBe(1);
    const op = await queue.get('op-3');
    expect(op?.status).toBe('pending');
    expect(op?.attempts).toBe(1);
  });

  it('parks a transient failure as failed once retries are exhausted', async () => {
    vi.mocked(api.createReport).mockRejectedValue(new ApiClientError('http_500', 'boom', 500));
    await queue.enqueue(
      'report',
      {
        target_type: 'contribution',
        target_id: '11111111-1111-4111-8111-111111111111',
        reason: 'spam',
        local_operation_id: 'op-4',
      },
      'op-4',
    );
    // Drive attempts up to the threshold.
    for (let i = 0; i < MAX_QUEUE_ATTEMPTS; i += 1) {
      await processPendingQueue();
    }
    const op = await queue.get('op-4');
    expect(op?.status).toBe('failed');
    expect(op?.attempts).toBeGreaterThanOrEqual(MAX_QUEUE_ATTEMPTS - 1);
  });

  it('treats a corrupt payload as terminal (ZodError)', async () => {
    await queue.enqueue('contribution', { thread_id: 'not-a-uuid' }, 'op-5');
    const result = await processPendingQueue();
    expect(result.failed).toBe(1);
    expect(api.createContribution).not.toHaveBeenCalled();
    expect((await queue.get('op-5'))?.status).toBe('failed');
  });

  it('skips draft-sync operations (left pending until the endpoint is wired)', async () => {
    await queue.enqueue('draft-sync', { draftId: 'd1' }, 'op-6');
    const result = await processPendingQueue();
    expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect((await queue.get('op-6'))?.status).toBe('pending');
  });

  it('requests a background sync when work remains after a transient failure', async () => {
    const register = stubSyncEnv();
    vi.mocked(api.createContribution).mockRejectedValue(
      new ApiClientError('http_503', 'Service unavailable', 503),
    );
    await queue.enqueue('contribution', CONTRIBUTION_PAYLOAD, 'op-7');
    await processPendingQueue();
    // requestBackgroundSync is fire-and-forget; wait for the register microtask.
    await vi.waitFor(() => expect(register).toHaveBeenCalledWith(SYNC_TAG));
  });

  it('does not request a background sync when the queue is fully drained', async () => {
    const register = stubSyncEnv();
    vi.mocked(api.createContribution).mockResolvedValue({} as never);
    await queue.enqueue('contribution', CONTRIBUTION_PAYLOAD, 'op-8');
    await processPendingQueue();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(register).not.toHaveBeenCalled();
  });
});
