// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Redis integration tests for the WS-E Redis adapters (replay
// nonces, sliding-window rate limiting, real-time aggregation). Run ONLY when
// REDIS_URL is set (`docker compose up redis`); CI skips them.
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { attentionEvent, sourceOpenEvent } from '../../__tests__/ws-e-helpers.js';
import { IngestRateLimiter } from '../ingest-limiter.js';
import { realtimeWindowStart } from '../realtime.js';
import {
  RedisRealtimeAggregator,
  RedisReplayNonceStore,
  RedisSlidingWindowStore,
} from '../redis-event-stores.js';

const REDIS_URL = process.env['REDIS_URL'];

describe.skipIf(!REDIS_URL)('Redis event-pipeline adapters integration (WS-E)', () => {
  const redis = REDIS_URL ? new IORedis(REDIS_URL) : null;
  const prefix = `it${randomUUID().slice(0, 8)}:`;

  afterAll(async () => {
    if (!redis) return;
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  describe('replay nonces (WS-E.1.3b)', () => {
    it('admits a nonce exactly once and re-admits after TTL expiry', async () => {
      if (!redis) return;
      const store = new RedisReplayNonceStore(redis, `${prefix}nonce:`);
      const key = `user:${randomUUID()}`;
      expect(await store.putIfAbsent(key, 60_000)).toBe(true);
      expect(await store.putIfAbsent(key, 60_000)).toBe(false);
      const short = `short:${randomUUID()}`;
      expect(await store.putIfAbsent(short, 150)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await store.putIfAbsent(short, 150)).toBe(true); // expired
    });

    it('stays within the WS-E.1.3b latency budget (< 5ms average per check)', async () => {
      if (!redis) return;
      const store = new RedisReplayNonceStore(redis, `${prefix}noncebench:`);
      const rounds = 200;
      const startedAt = process.hrtime.bigint();
      for (let i = 0; i < rounds; i += 1) {
        await store.putIfAbsent(`bench:${i}`, 60_000);
      }
      const averageMs = Number(process.hrtime.bigint() - startedAt) / 1e6 / rounds;
      expect(averageMs).toBeLessThan(5);
    });
  });

  describe('sliding-window rate limiting (WS-E.1.3c)', () => {
    let store: RedisSlidingWindowStore;

    beforeEach(() => {
      if (!redis) return;
      store = new RedisSlidingWindowStore(redis, `${prefix}rate${randomUUID().slice(0, 6)}:`);
    });

    it('counts hits in the window and exposes the k-th oldest entry', async () => {
      if (!redis) return;
      const now = Date.now();
      expect(await store.hit('u:m', now, 60_000)).toBe(1);
      expect(await store.hit('u:m', now + 100, 60_000)).toBe(2);
      expect(await store.hit('u:m', now + 200, 60_000)).toBe(3);
      const oldest = await store.nthOldest('u:m', now + 300, 60_000, 0);
      expect(oldest).toBe(now);
      // All three earlier hits fall outside the window at now + 61s
      // (cutoff = now + 1s): they are pruned, leaving only the new hit.
      expect(await store.hit('u:m', now + 61_000, 60_000)).toBe(1);
    });

    it('drives the limiter end to end with exact Retry-After math', async () => {
      if (!redis) return;
      const limiter = new IngestRateLimiter(store, { perMinute: 2, perHour: 100 });
      const t0 = Date.now();
      expect((await limiter.hit('user', t0)).allowed).toBe(true);
      expect((await limiter.hit('user', t0 + 10)).allowed).toBe(true);
      const denied = await limiter.hit('user', t0 + 20);
      expect(denied.allowed).toBe(false);
      expect(denied.degraded).toBe(false);
      expect(denied.retryAfterSec).toBeGreaterThan(0);
      expect(denied.retryAfterSec).toBeLessThanOrEqual(61);
    });
  });

  describe('real-time aggregation (WS-E.3.2)', () => {
    it('maintains per-item counters + native HLL uniques with TTL’d keys', async () => {
      if (!redis) return;
      const aggregator = new RedisRealtimeAggregator(redis, `${prefix}rt:`);
      const userId = '33333333-3333-4333-8333-333333333333';
      const storyId = randomUUID();
      const event = attentionEvent(userId, { storyId });
      await aggregator.recordAttention(event, userId);
      await aggregator.recordAttention(
        attentionEvent(userId, { storyId, timestamp: event.timestamp }),
        userId,
      );
      await aggregator.recordSourceOpen(
        sourceOpenEvent(userId, { story_id: storyId, bounce: true, timestamp: event.timestamp }),
        userId,
      );
      await aggregator.recordContribution(storyId, userId, event.timestamp);

      const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
      const snapshot = await aggregator.snapshot(storyId, windowStart);
      expect(snapshot).toMatchObject({
        uniqueActors: 1, // PFCOUNT dedups the same actor
        attentionItems: 2,
        sourceOpens: 2,
        sourceBounces: 1,
        contributions: 1,
        eventCount: 4,
      });
      expect(await aggregator.itemsInWindow(windowStart)).toContain(storyId);

      // Every key carries a TTL — Redis can never become a long-term store.
      const keys = await redis.keys(`${prefix}rt:*`);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(await redis.pttl(key), `${key} must have a TTL`).toBeGreaterThan(0);
      }
      expect(await aggregator.snapshot(randomUUID(), windowStart)).toBeNull();
    });
  });
});
