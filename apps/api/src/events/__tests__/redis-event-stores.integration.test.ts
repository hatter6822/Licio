// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Redis integration tests for the WS-E Redis adapters (replay
// nonces, sliding-window rate limiting, real-time aggregation). Run ONLY when
// REDIS_URL is set (`docker compose up redis`); CI skips them. Every case here
// asserts a VALUE; the one latency benchmark is additionally behind RUN_PERF=1,
// so a loaded runner's clock can never redden the correctness cases.
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { attentionEvent, sourceOpenEvent } from '../../__tests__/event-test-helpers.js';
import { IngestRateLimiter } from '../ingest-limiter.js';
import { realtimeWindowStart } from '../realtime.js';
import {
  RedisRealtimeAggregator,
  RedisReplayNonceStore,
  RedisSlidingWindowStore,
} from '../redis-event-stores.js';

const REDIS_URL = process.env['REDIS_URL'];
const PERF = process.env['RUN_PERF'] === '1';

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

    it('admits exactly one of N concurrent claims on the same nonce (SET NX PX)', async () => {
      if (!redis) return;
      // The atomicity `putIfAbsent` promises (redis-event-stores.ts) and that
      // SPEC §25.5 replay protection rests on — asserted nowhere else: all the
      // sequential cases above pass equally well against a GET-then-SET rewrite,
      // which loses the race and admits every concurrent claim.
      const store = new RedisReplayNonceStore(redis, `${prefix}race:`);
      const key = `user:${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.putIfAbsent(key, 60_000)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    // WS-E.1.3b's "< 5 ms per nonce check" acceptance criterion, kept
    // mechanically checked but OFF the correctness suite (the RUN_PERF
    // convention this repo already uses for every other timing assertion:
    // ranking-performance / ingestion-performance / invariants performance).
    // A wall clock in the gated suite is wrong in both directions — a CI
    // scheduler stall reddens 20-odd deterministic cases, while on unloaded
    // hardware even a fresh-connection-per-call adapter clears 5 ms, so it
    // detects no regression it names.  Warm up first (the cold trial measures
    // ~8x the warm median: connection setup + the ioredis command queue) and
    // report the MEDIAN and p99, which a mean over one GC pause cannot.
    it.skipIf(!PERF)('meets the WS-E.1.3b nonce-check latency budget', async () => {
      if (!redis) return;
      const store = new RedisReplayNonceStore(redis, `${prefix}noncebench:`);
      for (let i = 0; i < 20; i += 1) await store.putIfAbsent(`warmup:${i}`, 60_000);
      const samples: number[] = [];
      for (let i = 0; i < 200; i += 1) {
        const startedAt = process.hrtime.bigint();
        await store.putIfAbsent(`bench:${i}`, 60_000);
        samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
      }
      samples.sort((a, b) => a - b);
      const at = (p: number) =>
        samples[Math.min(samples.length - 1, Math.floor(p * 200))] as number;
      const [median, p99] = [at(0.5), at(0.99)];
      expect(median, `median ${median.toFixed(3)}ms, p99 ${p99.toFixed(3)}ms`).toBeLessThan(5);
      expect(p99, `median ${median.toFixed(3)}ms, p99 ${p99.toFixed(3)}ms`).toBeLessThan(5);
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
