// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L gated Redis adapter: the SHARED wallet abuse limiter (WS-L.2.5d).  The
// default in-memory `WalletAbuseLimiter` is PER-PROCESS, so on a multi-instance
// deployment a user could multiply `linkAttemptsPerHour` /
// `unlinkRequestsPerDay` by spreading requests across pods.  Production swaps
// this Redis sliding-window limiter in when REDIS_URL is configured, giving one
// global counter for `/wallet/nonce`, `/wallet/link`, and `/wallet/unlink`.

import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { WalletAbuseLimiterPort } from './stores.js';

export class RedisWalletAbuseLimiter implements WalletAbuseLimiterPort {
  readonly #redis: Redis;
  readonly #now: () => number;
  readonly #prefix: string;

  constructor(redis: Redis, now: () => number = Date.now, prefix = 'knomabuse:') {
    this.#redis = redis;
    this.#now = now;
    this.#prefix = prefix;
  }

  async hit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const redisKey = `${this.#prefix}${key}`;
    const now = this.#now();
    const member = `${now}-${randomBytes(6).toString('hex')}`;
    // Prune the window, add this attempt, count, and expire — all in one MULTI.
    const results = await this.#redis
      .multi()
      .zremrangebyscore(redisKey, 0, now - windowMs)
      .zadd(redisKey, now, member)
      .zcard(redisKey)
      .pexpire(redisKey, windowMs)
      .exec();
    const raw = results?.[2]?.[1];
    const total = typeof raw === 'number' ? raw : 0;
    if (total > limit) {
      // Over the limit: remove the rejected attempt so it does not pollute the
      // window (matches the in-memory check-before-add semantics).
      await this.#redis.zrem(redisKey, member);
      return false;
    }
    return true;
  }
}
