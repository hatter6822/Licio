// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../lib/api.js';
import { type AggregateInput, buildAggregate } from '../signals/aggregate.js';
import { noteAttentionRateLimited, resetAttentionCooldown } from '../signals/attention-cooldown.js';
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
const {
  MAX_QUEUE_ATTEMPTS,
  processPendingQueue,
  requestBackgroundSync,
  resetAttentionRetry,
  SYNC_TAG,
} = await import('./sync.js');

const CONTRIBUTION_PAYLOAD = {
  thread_id: '11111111-1111-4111-8111-111111111111',
  type: 'comment',
  body: 'A source.',
  citations: [{ url: 'https://example.org/source' }],
  client_draft_id: 'draft-1',
};

const STORY_A = '11111111-1111-4111-8111-111111111111';
const STORY_B = '22222222-2222-4222-8222-222222222222';
const STORY_C = '33333333-3333-4333-8333-333333333333';

/** A valid §22.1 attention-batch payload for one story (one aggregate). */
function attentionPayload(storyId: string): { aggregates: unknown[] } {
  const input: AggregateInput = {
    storyId,
    identifier: 'user-1',
    privacyLevel: 'standard',
    sessionBucketLabel: '2026-06-09T13:00:00.000Z',
    cappedDwellMs: 45_000,
    sourceOpened: true,
    contextOpened: false,
    distinctReplyDepthLevels: 1,
    returnCount: 0,
    now: Date.UTC(2026, 5, 9, 13, 30),
  };
  return { aggregates: [buildAggregate(input)] };
}

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
  resetAttentionCooldown();
  resetAttentionRetry();
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
        target_type: 'content',
        target_id: '11111111-1111-4111-8111-111111111111',
        content_kind: 'contribution',
        reason_code: 'MOD_SPAM_001',
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

  describe('attention coalescing + backoff (WS-C.4.4)', () => {
    it('coalesces every queued attention batch into ONE upload', async () => {
      vi.mocked(api.uploadAttentionAggregates).mockResolvedValue({ accepted: 3 } as never);
      await queue.enqueue('attention-aggregate', attentionPayload(STORY_A), 'a-1');
      await queue.enqueue('attention-aggregate', attentionPayload(STORY_B), 'a-2');
      await queue.enqueue('attention-aggregate', attentionPayload(STORY_C), 'a-3');

      const result = await processPendingQueue();

      // One request carrying all three aggregates — not a burst of three that
      // would re-trip the per-account rate limit that filled this queue.
      expect(api.uploadAttentionAggregates).toHaveBeenCalledOnce();
      expect(vi.mocked(api.uploadAttentionAggregates).mock.calls[0]?.[0]).toHaveLength(3);
      expect(result.sent).toBe(3);
      expect(await queue.count()).toBe(0);
    });

    it('leaves attention batches pending (no upload, no attempt burn) while cooling down', async () => {
      noteAttentionRateLimited(30, Date.now());
      await queue.enqueue('attention-aggregate', attentionPayload(STORY_A), 'a-4');

      const result = await processPendingQueue();

      expect(api.uploadAttentionAggregates).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
      const op = await queue.get('a-4');
      expect(op?.status).toBe('pending');
      expect(op?.attempts).toBe(0); // backoff is not a failed attempt
    });

    it('retries a transient attention failure without dropping the idempotent batch', async () => {
      vi.mocked(api.uploadAttentionAggregates).mockRejectedValue(
        new ApiClientError('rate_limited', 'slow down', 429),
      );
      await queue.enqueue('attention-aggregate', attentionPayload(STORY_A), 'a-5');

      const result = await processPendingQueue();

      expect(result.retried).toBe(1);
      const op = await queue.get('a-5');
      expect(op?.status).toBe('pending');
      expect(op?.attempts).toBe(1);
    });

    it('parks a corrupt attention payload as terminal while coalescing the valid ones', async () => {
      vi.mocked(api.uploadAttentionAggregates).mockResolvedValue({ accepted: 1 } as never);
      await queue.enqueue('attention-aggregate', { aggregates: [{ bad: true }] }, 'a-6');
      await queue.enqueue('attention-aggregate', attentionPayload(STORY_A), 'a-7');

      const result = await processPendingQueue();

      expect(result.failed).toBe(1);
      expect(result.sent).toBe(1);
      expect((await queue.get('a-6'))?.status).toBe('failed');
      expect(await queue.get('a-7')).toBeUndefined(); // sent + removed
      expect(vi.mocked(api.uploadAttentionAggregates).mock.calls[0]?.[0]).toHaveLength(1);
    });

    it('isolates a terminal batch rejection so a poisoned op never fails valid ones', async () => {
      // One queued op belongs to a prior user (server 403s any batch containing
      // it); coalescing must not drop the other user's valid hints with it.
      vi.mocked(api.uploadAttentionAggregates).mockImplementation(async (aggs) => {
        if (aggs.some((a) => a.story_id === STORY_B)) {
          throw new ApiClientError('forbidden', 'owner mismatch', 403);
        }
        return { accepted: aggs.length };
      });
      await queue.enqueue('attention-aggregate', attentionPayload(STORY_A), 'a-good');
      await queue.enqueue('attention-aggregate', attentionPayload(STORY_B), 'a-bad');

      const result = await processPendingQueue();

      // Coalesced attempt 403s → falls back to per-op: the good one sends, the
      // poisoned one parks. (1 coalesced + 2 isolated calls.)
      expect(result.sent).toBe(1);
      expect(result.failed).toBe(1);
      expect(await queue.get('a-good')).toBeUndefined();
      expect((await queue.get('a-bad'))?.status).toBe('failed');
    });

    it('schedules a retry at the Retry-After deadline when it defers under cooldown', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      noteAttentionRateLimited(50, Date.now()); // ~50 s window
      await queue.enqueue('attention-aggregate', attentionPayload(STORY_A), 'a-defer');

      await processPendingQueue();

      expect(api.uploadAttentionAggregates).not.toHaveBeenCalled();
      // A retry is scheduled for roughly the remaining window (no other lifecycle
      // event would otherwise drain the backlog on an online/visible client).
      expect(setTimeoutSpy.mock.calls.some(([, delay]) => (delay ?? 0) >= 40_000)).toBe(true);
      resetAttentionRetry();
      setTimeoutSpy.mockRestore();
    });
  });
});
