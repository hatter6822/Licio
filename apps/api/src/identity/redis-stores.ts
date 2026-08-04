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

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    // `SET … PX ttl NX` writes ONLY if the key is absent — atomic in Redis, so
    // exactly one of N concurrent callers gets the slot.
    const result = await this.#redis.set(
      `${this.#prefix}${key}`,
      value,
      'PX',
      Math.max(1, Math.ceil(ttlMs)),
      'NX',
    );
    return result !== null;
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    // INCR is atomic, but arming the expiry needs to happen in the SAME
    // atomic step and only on creation — a script rather than two round
    // trips, so a crash between them cannot leave the counter immortal and a
    // later caller cannot push the window forward.
    const result = await this.#redis.eval(
      "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return n",
      1,
      `${this.#prefix}${key}`,
      String(Math.max(1, Math.ceil(ttlMs))),
    );
    return typeof result === 'number' ? result : Number(result ?? 0);
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
 * A stored session as it comes back off the wire, or `null` when it cannot be
 * read.
 *
 * Validated at the trust boundary (zod on every boundary): a corrupt or tampered
 * row is treated as no session — fail closed to unauthenticated, never a crash
 * loop or a malformed record downstream.
 *
 * `version` defaults to 0 so a row written before the field existed still takes
 * part in the compare-and-set rather than being unwritable.  Dropping it here
 * would be worse than not having it: every CAS would compare against 0, so the
 * first write would always win and the second would always be refused.
 */
function parseStoredSession(raw: string): StoredSession | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const candidate = parsed as { record?: unknown; expiresAt?: unknown; version?: unknown };
    const record = sessionRecordSchema.parse(candidate.record);
    if (typeof candidate.expiresAt !== 'number' || !Number.isFinite(candidate.expiresAt)) {
      return null;
    }
    const version =
      typeof candidate.version === 'number' && Number.isFinite(candidate.version)
        ? candidate.version
        : 0;
    return { record, expiresAt: candidate.expiresAt, version };
  } catch {
    return null;
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
    const parsed = parseStoredSession(raw);
    if (parsed === null) {
      await this.#redis.del(this.#key(tokenHash));
      return null;
    }
    return parsed;
  }

  async delete(tokenHash: string): Promise<void> {
    const stored = await this.get(tokenHash);
    const pipeline = this.#redis.multi().del(this.#key(tokenHash));
    if (stored) pipeline.srem(this.#userKey(stored.record.user_id), tokenHash);
    await pipeline.exec();
  }

  async putIfVersion(
    tokenHash: string,
    expectedVersion: number,
    stored: StoredSession,
  ): Promise<boolean> {
    // ONE script, because this is three things that must agree: the key still
    // exists, it is still at the version the caller read, and the per-user
    // index outlives the session it indexes.
    //
    // `SET … XX` alone did the first only. It let a caller REVERT a change made
    // since its read (a throttled activity slide put `mfa_verified: false` back
    // over a landed MFA grant), and it extended the session's own TTL past the
    // index's — after which `listForUser` could not see a live session, so it
    // was invisible to the device list AND to bulk revocation, which is a
    // session that cannot be signed out.
    const written = await this.#redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 0 end
       local ok, current = pcall(cjson.decode, raw)
       local version = 0
       if ok and type(current) == 'table' and type(current.version) == 'number' then
         version = current.version
       end
       if version ~= tonumber(ARGV[2]) then return 0 end
       redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
       redis.call('SADD', KEYS[2], ARGV[4])
       redis.call('PEXPIRE', KEYS[2], ARGV[3], 'NX')
       redis.call('PEXPIRE', KEYS[2], ARGV[3], 'GT')
       return 1`,
      2,
      this.#key(tokenHash),
      this.#userKey(stored.record.user_id),
      JSON.stringify({ ...stored, version: expectedVersion + 1 }),
      String(expectedVersion),
      String(Math.max(1, Math.ceil(stored.expiresAt - Date.now()))),
      tokenHash,
    );
    return Number(written) === 1;
  }

  async rotate(oldHash: string, newHash: string): Promise<StoredSession | null> {
    // The record is read first only to learn WHICH user index to touch and what
    // version to expect; the script re-checks that version, so a row that
    // changed in between aborts the rotation rather than moving a stale copy.
    const current = await this.get(oldHash);
    if (current === null) return null;
    const moved = { ...current, version: current.version + 1 };

    // ONE script from there: the old token is gone and the new one exists, or
    // neither is true.  As GETDEL-then-SET this could stop half way — the old
    // key deleted, the successor never written — leaving the holder with NO
    // session.  On the recovery path the continuation is settled BEFORE the
    // rotation, so a spent last code was not resumable either: the lockout the
    // continuation exists to prevent, one step further along.
    //
    // The index membership MOVES with the session (SREM old, SADD new) and its
    // TTL is extended, never shortened — a session missing from that index is
    // one the device list cannot show and bulk revocation cannot sign out.
    const rotated = await this.#redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 0 end
       local ok, parsed = pcall(cjson.decode, raw)
       local version = 0
       if ok and type(parsed) == 'table' and type(parsed.version) == 'number' then
         version = parsed.version
       end
       if version ~= tonumber(ARGV[1]) then return 0 end
       local ttl = redis.call('PTTL', KEYS[1])
       if (not ttl) or ttl < 0 then ttl = tonumber(ARGV[3]) end
       redis.call('SET', KEYS[2], ARGV[2], 'PX', ttl)
       redis.call('DEL', KEYS[1])
       redis.call('SREM', KEYS[3], ARGV[4])
       redis.call('SADD', KEYS[3], ARGV[5])
       redis.call('PEXPIRE', KEYS[3], ttl, 'NX')
       redis.call('PEXPIRE', KEYS[3], ttl, 'GT')
       return 1`,
      3,
      this.#key(oldHash),
      this.#key(newHash),
      this.#userKey(current.record.user_id),
      String(current.version),
      JSON.stringify(moved),
      String(Math.max(1, Math.ceil(moved.expiresAt - Date.now()))),
      oldHash,
      newHash,
    );
    return Number(rotated) === 1 ? moved : null;
  }

  async take(tokenHash: string): Promise<StoredSession | null> {
    // GETDEL is ONE atomic command: exactly one concurrent caller gets the
    // value and the rest get nil.  Composing GET with DEL would not be — both
    // callers would read the session and both would go on to mint a successor,
    // which is precisely what this exists to stop (see `rotateSession`).
    const raw = await this.#redis.getdel(this.#key(tokenHash));
    if (!raw) return null;
    try {
      const parsed = parseStoredSession(raw);
      if (parsed === null) throw new Error('unreadable session');
      await this.#redis.srem(this.#userKey(parsed.record.user_id), tokenHash);
      return parsed;
    } catch {
      // Corrupt row: the key is already gone, which is the same fail-closed
      // outcome `get` reaches by deleting it.  The user index entry is pruned
      // by `listForUser` when it next finds the key missing.
      return null;
    }
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
