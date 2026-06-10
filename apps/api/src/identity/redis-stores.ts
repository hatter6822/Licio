// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Redis adapters for the identity stores (WS-D).  These implement the
// SAME interfaces as the in-memory stores used in CI, so swapping them in is a
// one-line wiring change (the established TokenStore pattern).  They are exercised
// by the gated live-Redis integration test (`redis-stores.integration.test.ts`),
// not by unit tests, and are therefore excluded from the coverage threshold like
// `packages/db/src/client.ts` — the logic they bind to is already fully covered.
import type Redis from 'ioredis';
import type { EphemeralStore } from './ephemeral-store.js';
import type { SessionStore, StoredSession } from './sessions.js';

/** Redis-backed single-use ephemeral store (challenges, SIWE nonces, email OTPs). */
export class RedisEphemeralStore implements EphemeralStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'eph:') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.#redis.set(`${this.#prefix}${key}`, value, 'PX', Math.max(1, Math.ceil(ttlMs)));
  }

  async get(key: string): Promise<string | null> {
    return this.#redis.get(`${this.#prefix}${key}`);
  }

  async take(key: string): Promise<string | null> {
    // GETDEL is atomic single-use consumption (Redis ≥ 6.2).
    return this.#redis.getdel(`${this.#prefix}${key}`);
  }

  async delete(key: string): Promise<void> {
    await this.#redis.del(`${this.#prefix}${key}`);
  }

  async clear(): Promise<void> {
    const keys = await this.#redis.keys(`${this.#prefix}*`);
    if (keys.length > 0) await this.#redis.del(...keys);
  }
}

/**
 * Redis-backed session store.  The session record lives at `session:{tokenHash}`
 * with a PX TTL; a per-user set `session:user:{userId}` indexes a user's tokens so
 * the active-device list and bulk revocation are O(sessions-per-user).
 */
export class RedisSessionStore implements SessionStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'session:') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  #key(tokenHash: string): string {
    return `${this.#prefix}${tokenHash}`;
  }
  #userKey(userId: string): string {
    return `${this.#prefix}user:${userId}`;
  }

  async put(tokenHash: string, stored: StoredSession): Promise<void> {
    const ttlMs = Math.max(1, stored.expiresAt - Date.now());
    await this.#redis
      .multi()
      .set(this.#key(tokenHash), JSON.stringify(stored), 'PX', Math.ceil(ttlMs))
      .sadd(this.#userKey(stored.record.user_id), tokenHash)
      // Keep the index alive at least as long as the longest possible session.
      .pexpire(this.#userKey(stored.record.user_id), Math.ceil(ttlMs))
      .exec();
  }

  async get(tokenHash: string): Promise<StoredSession | null> {
    const raw = await this.#redis.get(this.#key(tokenHash));
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  }

  async delete(tokenHash: string): Promise<void> {
    const stored = await this.get(tokenHash);
    const pipeline = this.#redis.multi().del(this.#key(tokenHash));
    if (stored) pipeline.srem(this.#userKey(stored.record.user_id), tokenHash);
    await pipeline.exec();
  }

  async listForUser(userId: string): Promise<Array<{ tokenHash: string; stored: StoredSession }>> {
    const hashes = await this.#redis.smembers(this.#userKey(userId));
    const out: Array<{ tokenHash: string; stored: StoredSession }> = [];
    for (const tokenHash of hashes) {
      const stored = await this.get(tokenHash);
      if (stored) out.push({ tokenHash, stored });
      else await this.#redis.srem(this.#userKey(userId), tokenHash); // prune expired index entry
    }
    return out;
  }

  async clear(): Promise<void> {
    const keys = await this.#redis.keys(`${this.#prefix}*`);
    if (keys.length > 0) await this.#redis.del(...keys);
  }
}
