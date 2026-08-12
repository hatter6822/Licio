// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Redis adapters for the event pipeline (WS-E.1.3b/c, WS-E.3.2),
// mirroring identity/redis-stores.ts. Every key is namespaced and TTL'd:
//   evnonce:* — single-use replay nonces (SET NX PX; WS-E.1.3b);
//   evrate:*  — sliding-window rate-limit ZSETs (WS-E.1.3c);
//   rt:*      — real-time per-item counters + native HyperLogLog (WS-E.3.2).
// Real-time keys expire after REALTIME_TTL_MS, so Redis can never become a
// long-term attention store; everything here is rebuildable from Postgres.
//
// Covered by gated integration tests (REDIS_URL) rather than unit coverage —
// the same policy as the WS-D Redis adapters.
import { randomBytes } from 'node:crypto';
import type {
  AttentionAggregateEvent,
  ContentSavedAggregateEvent,
  SourceOpenedAggregateEvent,
} from '@licio/shared';
import type { Redis } from 'ioredis';
import type { SlidingWindowStore } from './ingest-limiter.js';
import {
  REALTIME_TTL_MS,
  type RealtimeAggregator,
  type RealtimeItemCounts,
  realtimeWindowStart,
} from './realtime.js';
import type { ReplayNonceStore } from './replay.js';

export class RedisReplayNonceStore implements ReplayNonceStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'evnonce:') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async putIfAbsent(key: string, ttlMs: number): Promise<boolean> {
    // SET NX PX is atomic: exactly one caller ever wins a given nonce.
    const result = await this.#redis.set(`${this.#prefix}${key}`, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async clear(): Promise<void> {
    const keys = await this.#redis.keys(`${this.#prefix}*`);
    if (keys.length > 0) await this.#redis.del(...keys);
  }
}

export class RedisSlidingWindowStore implements SlidingWindowStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'evrate:') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async hit(key: string, nowMs: number, windowMs: number): Promise<number> {
    const redisKey = `${this.#prefix}${key}`;
    const member = `${nowMs}-${randomBytes(6).toString('hex')}`;
    const results = await this.#redis
      .multi()
      .zremrangebyscore(redisKey, 0, nowMs - windowMs)
      .zadd(redisKey, nowMs, member)
      .zcard(redisKey)
      .pexpire(redisKey, windowMs)
      .exec();
    const count = results?.[2]?.[1];
    return typeof count === 'number' ? count : 0;
  }

  async nthOldest(key: string, nowMs: number, windowMs: number, k: number): Promise<number | null> {
    const redisKey = `${this.#prefix}${key}`;
    await this.#redis.zremrangebyscore(redisKey, 0, nowMs - windowMs);
    // The indices are passed as STRINGS, which is not stylistic: ioredis 6.0.0
    // types `zrange` as (start: string | Buffer | number, stop: string |
    // Buffer) — `number` is accepted for the start of the range and not for
    // its end. That asymmetry is an upstream codegen slip rather than an API
    // change; the sibling `zremrangebyscore` two lines up still takes
    // `number | string` on BOTH sides. Strings satisfy 5.x and 6.x alike and
    // are runtime-identical either way, since RESP serialises every argument
    // to a bulk string before it reaches Redis. Do not "tidy" these back to
    // bare numbers — that is precisely what fails to compile under 6.x.
    const entry = await this.#redis.zrange(redisKey, String(k), String(k), 'WITHSCORES');
    const score = entry[1];
    return score === undefined ? null : Number(score);
  }

  async clear(): Promise<void> {
    const keys = await this.#redis.keys(`${this.#prefix}*`);
    if (keys.length > 0) await this.#redis.del(...keys);
  }
}

/**
 * Redis-backed real-time aggregation (WS-E.3.2): per-item hashes for the
 * signal counters and NATIVE HyperLogLog (PFADD/PFCOUNT — the same algorithm
 * and ~0.81% standard error as events/hll.ts) for unique actors. Every key
 * carries the REALTIME_TTL so attention never persists beyond the window.
 */
export class RedisRealtimeAggregator implements RealtimeAggregator {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'rt:') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  #itemKey(windowStartMs: number, itemId: string): string {
    return `${this.#prefix}${windowStartMs}:${itemId}`;
  }

  #indexKey(windowStartMs: number): string {
    return `${this.#prefix}${windowStartMs}:items`;
  }

  async #bump(
    windowStartMs: number,
    itemId: string,
    actorKey: string,
    fields: Partial<
      Record<
        'attentionItems' | 'sourceOpens' | 'sourceBounces' | 'contextOpens' | 'contributions',
        number
      >
    >,
  ): Promise<void> {
    const itemKey = this.#itemKey(windowStartMs, itemId);
    const multi = this.#redis
      .multi()
      .pfadd(`${itemKey}:hll`, actorKey)
      .hincrby(itemKey, 'eventCount', 1)
      .sadd(this.#indexKey(windowStartMs), itemId)
      .pexpire(`${itemKey}:hll`, REALTIME_TTL_MS)
      .pexpire(this.#indexKey(windowStartMs), REALTIME_TTL_MS);
    for (const [field, by] of Object.entries(fields)) {
      if (by) multi.hincrby(itemKey, field, by);
    }
    multi.pexpire(itemKey, REALTIME_TTL_MS);
    await multi.exec();
  }

  async recordAttention(event: AttentionAggregateEvent, actorKey: string): Promise<void> {
    const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
    for (const item of event.items) {
      await this.#bump(windowStart, item.story_id, actorKey, {
        attentionItems: 1,
        ...(item.source_opened ? { sourceOpens: 1 } : {}),
        ...(item.context_opened ? { contextOpens: 1 } : {}),
      });
    }
  }

  async recordSourceOpen(event: SourceOpenedAggregateEvent, actorKey: string): Promise<void> {
    const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
    await this.#bump(windowStart, event.story_id, actorKey, {
      ...(event.bounce ? { sourceBounces: 1 } : { sourceOpens: 1 }),
    });
  }

  async recordContribution(itemId: string, actorKey: string, timestampIso: string): Promise<void> {
    const windowStart = realtimeWindowStart(Date.parse(timestampIso));
    await this.#bump(windowStart, itemId, actorKey, { contributions: 1 });
  }

  async recordSave(event: ContentSavedAggregateEvent, actorKey: string): Promise<void> {
    // eventCount + HLL only (no sub-counter): enough to feed the §5.3 save into
    // the volume trigger + uniques; the durable fold computes the score.
    const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
    await this.#bump(windowStart, event.story_id, actorKey, {});
  }

  async snapshot(itemId: string, windowStartMs: number): Promise<RealtimeItemCounts | null> {
    const itemKey = this.#itemKey(windowStartMs, itemId);
    const [hash, uniqueActors] = await Promise.all([
      this.#redis.hgetall(itemKey),
      this.#redis.pfcount(`${itemKey}:hll`),
    ]);
    if (Object.keys(hash).length === 0 && uniqueActors === 0) return null;
    const n = (field: string): number => Number(hash[field] ?? 0);
    return {
      uniqueActors,
      attentionItems: n('attentionItems'),
      sourceOpens: n('sourceOpens'),
      sourceBounces: n('sourceBounces'),
      contextOpens: n('contextOpens'),
      contributions: n('contributions'),
      eventCount: n('eventCount'),
    };
  }

  async itemsInWindow(windowStartMs: number): Promise<string[]> {
    return this.#redis.smembers(this.#indexKey(windowStartMs));
  }

  async clear(): Promise<void> {
    const keys = await this.#redis.keys(`${this.#prefix}*`);
    if (keys.length > 0) await this.#redis.del(...keys);
  }
}
