// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Redis adapter for the PHI session-topic-sequence store (WS-H.6.1a).  Session
// sequences are SESSION-SCOPED ephemera with a 6h idle TTL — Redis is their
// durable-enough home in production (never Postgres, by design): a user's
// attention events landing on different instances now append to ONE shared
// sequence, and the batch holonomy tier sees every instance's sessions instead
// of one pod's fragment.  Privacy: a sequence holds coarse topic-cluster ids +
// bucketed action kinds only (no story ids, no content, no identity beyond the
// opaque session key the caller derives).
import type IORedis from 'ioredis';
import { z } from 'zod';
import { SESSION_SEQUENCE_TTL_MS, type SessionTopicSequenceStore } from './stores.js';

/** Shape guard for the Redis round-trip: a corrupted entry reads as absent.
 *  Matches the REAL `TopicTransition` (phi/loops.ts) — the previous guard
 *  validated a nonexistent `actionKind` and let the actual `kind`/`engagement`
 *  fields through unchecked via `.passthrough()`, so it guarded nothing. */
const transitionSchema = z
  .object({
    topicClusterId: z.string(),
    atMs: z.number(),
    kind: z.enum(['read', 'open_source', 'open_context']).optional(),
    engagement: z.number().optional(),
  })
  .strict();

type TopicTransition = Parameters<SessionTopicSequenceStore['append']>[1];

export class RedisSessionTopicSequenceStore implements SessionTopicSequenceStore {
  readonly #redis: IORedis;
  readonly #prefix: string;

  constructor(redis: IORedis, prefix = 'phi:seq:') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  #key(sessionKey: string): string {
    return `${this.#prefix}${sessionKey}`;
  }

  #parse(raw: string[]): TopicTransition[] {
    const out: TopicTransition[] = [];
    for (const item of raw) {
      try {
        const parsed = transitionSchema.safeParse(JSON.parse(item));
        if (parsed.success) out.push(parsed.data as TopicTransition);
      } catch {
        // A corrupted entry is dropped, never a crash (the sequence degrades).
      }
    }
    return out;
  }

  async append(
    sessionKey: string,
    transition: TopicTransition,
    _nowMs: number,
    cap: number,
  ): Promise<void> {
    const key = this.#key(sessionKey);
    // Append, keep the LAST `cap` transitions, refresh the idle TTL — one
    // atomic pipeline (partial application would only under- or over-trim by
    // one entry, never corrupt).
    await this.#redis
      .multi()
      .rpush(key, JSON.stringify(transition))
      .ltrim(key, -cap, -1)
      .pexpire(key, SESSION_SEQUENCE_TTL_MS)
      .exec();
  }

  async get(sessionKey: string, _nowMs: number): Promise<TopicTransition[]> {
    // Redis TTL IS the idle expiry: an expired key reads empty natively.
    return this.#parse(await this.#redis.lrange(this.#key(sessionKey), 0, -1));
  }

  async listLive(
    _nowMs: number,
  ): Promise<Array<{ sessionKey: string; sequence: TopicTransition[] }>> {
    // The batch holonomy tier runs hourly on ONE lease-holding instance, so a
    // SCAN sweep is acceptable here (never on a request path).
    const out: Array<{ sessionKey: string; sequence: TopicTransition[] }> = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.#redis.scan(
        cursor,
        'MATCH',
        `${this.#prefix}*`,
        'COUNT',
        200,
      );
      cursor = next;
      for (const key of keys) {
        const sequence = this.#parse(await this.#redis.lrange(key, 0, -1));
        if (sequence.length > 0) out.push({ sessionKey: key.slice(this.#prefix.length), sequence });
      }
    } while (cursor !== '0');
    return out;
  }

  async sweepExpired(_nowMs: number): Promise<number> {
    // Redis expires idle sequences natively (the PEXPIRE on every append);
    // there is nothing to sweep by hand.
    return 0;
  }

  async clear(): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.#redis.scan(
        cursor,
        'MATCH',
        `${this.#prefix}*`,
        'COUNT',
        200,
      );
      cursor = next;
      if (keys.length > 0) await this.#redis.del(...keys);
    } while (cursor !== '0');
  }
}
