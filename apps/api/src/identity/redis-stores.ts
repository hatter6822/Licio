// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Redis adapters for the identity stores (WS-D).  These implement the
// SAME interfaces as the in-memory stores used in CI, so swapping them in is a
// one-line wiring change (the established TokenStore pattern).  They are exercised
// by the gated live-Redis integration test (`redis-stores.integration.test.ts`),
// not by unit tests, and are therefore excluded from the coverage threshold like
// `packages/db/src/client.ts` — the logic they bind to is already fully covered.
import { randomBytes } from 'node:crypto';
import { sessionRecordSchema } from '@licio/shared';
import type Redis from 'ioredis';
import type { EphemeralStore } from './ephemeral-store.js';
import type { AuthRateLimitStore } from './rate-limit-auth.js';
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

  async setIfExists(key: string, value: string, ttlMs: number): Promise<boolean> {
    // `SET … PX ttl XX` writes ONLY if the key still exists — atomic in Redis. If a
    // concurrent GETDEL already consumed it, this returns null (no write), so a
    // failed-attempt update can never resurrect a consumed single-use record.
    const result = await this.#redis.set(
      `${this.#prefix}${key}`,
      value,
      'PX',
      Math.max(1, Math.ceil(ttlMs)),
      'XX',
    );
    return result !== null;
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
    const ttlMs = String(Math.max(1, Math.ceil(stored.expiresAt - Date.now())));
    const userKey = this.#userKey(stored.record.user_id);
    // The per-user index carries MAX(member TTLs): writing a short-lived session
    // after a long-lived one must never SHORTEN the index expiry, or the long
    // session would vanish from the device list / bulk revocation.  Redis ≥ 7:
    // PEXPIRE…NX arms a TTL on a fresh (persistent) key — GT alone would skip it,
    // because "no TTL" compares as infinite — then PEXPIRE…GT only ever extends.
    await this.#redis
      .multi()
      .set(this.#key(tokenHash), JSON.stringify(stored), 'PX', Number(ttlMs))
      .sadd(userKey, tokenHash)
      .call('PEXPIRE', userKey, ttlMs, 'NX')
      .call('PEXPIRE', userKey, ttlMs, 'GT')
      .exec();
  }

  async get(tokenHash: string): Promise<StoredSession | null> {
    const raw = await this.#redis.get(this.#key(tokenHash));
    if (!raw) return null;
    // Validate at the trust boundary (zod on every boundary): a corrupt or
    // tampered row is DELETED and treated as no session — fail closed to
    // unauthenticated, never a crash loop or a malformed record downstream.
    try {
      const parsed: unknown = JSON.parse(raw);
      const candidate = parsed as { record?: unknown; expiresAt?: unknown };
      const record = sessionRecordSchema.parse(candidate.record);
      if (typeof candidate.expiresAt !== 'number' || !Number.isFinite(candidate.expiresAt)) {
        throw new Error('bad expiresAt');
      }
      return { record, expiresAt: candidate.expiresAt };
    } catch {
      await this.#redis.del(this.#key(tokenHash));
      return null;
    }
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

/**
 * Redis-backed progressive auth rate-limit store.  Failure windows are Redis
 * sorted sets pruned to the sliding window (ZREMRANGEBYSCORE + ZCARD); locks are
 * short-lived keys.  Keys hold only NON-reversible account refs and the global
 * backstop key — never an IP (the application does not read client addresses,
 * §19.1) and never a plaintext email (§19.5).
 */
export class RedisAuthRateLimitStore implements AuthRateLimitStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'authrl:') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async recordFailure(key: string, now: number, windowMs: number): Promise<number> {
    const k = `${this.#prefix}${key}`;
    const member = `${now}-${randomBytes(6).toString('hex')}`;
    const results = await this.#redis
      .multi()
      .zremrangebyscore(k, 0, now - windowMs)
      .zadd(k, now, member)
      .zcard(k)
      .pexpire(k, windowMs)
      .exec();
    // ZCARD is the third command; its reply is [err, count].
    const count = results?.[2]?.[1];
    return typeof count === 'number' ? count : Number(count ?? 0);
  }

  async reset(key: string): Promise<void> {
    await this.#redis.del(`${this.#prefix}${key}`);
  }

  async setLock(key: string, untilMs: number): Promise<void> {
    const k = `${this.#prefix}${key}`;
    if (untilMs <= Date.now()) {
      await this.#redis.del(k);
      return;
    }
    await this.#redis.set(k, String(untilMs), 'PXAT', untilMs);
  }

  async getLock(key: string, now: number): Promise<number | null> {
    const raw = await this.#redis.get(`${this.#prefix}${key}`);
    if (raw === null) return null;
    const until = Number(raw);
    if (until <= now) {
      await this.#redis.del(`${this.#prefix}${key}`);
      return null;
    }
    return until - now;
  }

  async clear(): Promise<void> {
    const keys = await this.#redis.keys(`${this.#prefix}*`);
    if (keys.length > 0) await this.#redis.del(...keys);
  }
}
