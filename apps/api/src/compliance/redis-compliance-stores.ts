// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Redis adapters for the WS-N hot-path stores (multi-instance):
//
//   • RedisVelocityStore — the atomic sliding-window reserve as ONE Lua
//     script: prune → exact-decimal volume sum → admit-or-reject → record.
//     Volume math is school addition over decimal STRINGS inside Lua (Lua
//     numbers are doubles — exact only to 2^53, which an 18-decimal asset
//     exceeds — so no numeric conversion ever touches an amount).  The
//     script runs atomically in Redis: two racing checks can never both
//     squeeze under a limit.
//   • RedisScreeningCacheStore — verdict cache with per-key TTL.
//   • RedisPolicyInvalidationBroadcaster — the WS-N.1.1e cross-instance
//     cache invalidation channel, zod-validated on BOTH sides of the wire
//     (the forum redis-broadcasters posture).
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type {
  PolicyInvalidationBroadcaster,
  ScreeningCacheStore,
  VelocityStore,
} from './stores.js';

// KEYS[1] = the window zset; member format `${nowMs}:${uuid}:${amount}`.
// ARGV = now_ms, window_ms, amount (decimal string), max_count,
//        max_volume (decimal string), member.
// Returns 1 (admitted + recorded) or 0 (exceeded; prune retained).
const RESERVE_LUA = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
if #members + 1 > tonumber(ARGV[4]) then return 0 end
local function strip(x)
  local y = string.gsub(x, '^0+', '')
  if y == '' then return '0' end
  return y
end
local function add(a, b)
  local res = ''
  local carry = 0
  local i = #a
  local j = #b
  while i > 0 or j > 0 or carry > 0 do
    local da = 0
    local db = 0
    if i > 0 then da = string.byte(a, i) - 48 end
    if j > 0 then db = string.byte(b, j) - 48 end
    local s = da + db + carry
    carry = math.floor(s / 10)
    res = string.char(48 + (s % 10)) .. res
    i = i - 1
    j = j - 1
  end
  return strip(res)
end
local function lte(a, b)
  a = strip(a)
  b = strip(b)
  if #a ~= #b then return #a < #b end
  return a <= b
end
local total = '0'
for _, m in ipairs(members) do
  local amt = string.match(m, ':(%d+)$')
  if amt then total = add(total, amt) end
end
total = add(total, ARGV[3])
if not lte(total, ARGV[5]) then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[6])
redis.call('PEXPIRE', KEYS[1], window)
return 1
`;

const AMOUNT_RE = /^\d{1,78}$/;

export class RedisVelocityStore implements VelocityStore {
  readonly #redis: Redis;
  readonly #uuid: () => string;
  #scriptSha: string | null = null;

  constructor(redis: Redis, uuid: () => string = () => crypto.randomUUID()) {
    this.#redis = redis;
    this.#uuid = uuid;
  }

  async #eval(keys: string[], argv: string[]): Promise<unknown> {
    if (this.#scriptSha === null) {
      this.#scriptSha = (await this.#redis.script('LOAD', RESERVE_LUA)) as string;
    }
    try {
      return await this.#redis.evalsha(this.#scriptSha, keys.length, ...keys, ...argv);
    } catch (error) {
      // A flushed script cache (failover) reloads once, then rethrows.
      if (error instanceof Error && error.message.includes('NOSCRIPT')) {
        this.#scriptSha = (await this.#redis.script('LOAD', RESERVE_LUA)) as string;
        return await this.#redis.evalsha(this.#scriptSha, keys.length, ...keys, ...argv);
      }
      throw error;
    }
  }

  async reserve(input: {
    key: string;
    nowMs: number;
    windowMs: number;
    amountMinorUnits: string;
    maxCount: number;
    maxVolumeMinorUnits: string;
  }): Promise<'ok' | 'exceeded'> {
    if (!AMOUNT_RE.test(input.amountMinorUnits)) return 'exceeded';
    const member = `${input.nowMs}:${this.#uuid()}:${input.amountMinorUnits}`;
    const admitted = await this.#eval(
      [`compliance:${input.key}`],
      [
        String(input.nowMs),
        String(input.windowMs),
        input.amountMinorUnits,
        String(input.maxCount),
        input.maxVolumeMinorUnits,
        member,
      ],
    );
    return admitted === 1 ? 'ok' : 'exceeded';
  }
}

export class RedisScreeningCacheStore implements ScreeningCacheStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async get(key: string): Promise<string | null> {
    return this.#redis.get(`compliance:${key}`);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.#redis.set(`compliance:${key}`, value, 'PX', Math.max(1, Math.floor(ttlMs)));
  }
}

const CHANNEL = 'compliance:policy:invalidate';
const invalidationMessageSchema = z
  .object({ region: z.string().min(1).max(64).nullable() })
  .strict();

/** Cross-instance policy-cache invalidation (WS-N.1.1e).  `subscriber` must
 *  be a DEDICATED connection (Redis subscribe mode). */
export class RedisPolicyInvalidationBroadcaster implements PolicyInvalidationBroadcaster {
  readonly #publisher: Redis;
  readonly #subscriber: Redis;
  readonly #handlers: Array<(region: string | null) => void> = [];
  #subscribed = false;

  constructor(publisher: Redis, subscriber: Redis) {
    this.#publisher = publisher;
    this.#subscriber = subscriber;
  }

  async publish(region: string | null): Promise<void> {
    await this.#publisher.publish(CHANNEL, JSON.stringify({ region }));
  }

  subscribe(handler: (region: string | null) => void): void {
    this.#handlers.push(handler);
    if (this.#subscribed) return;
    this.#subscribed = true;
    void this.#subscriber.subscribe(CHANNEL);
    this.#subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== CHANNEL) return;
      let parsed: { region: string | null };
      try {
        parsed = invalidationMessageSchema.parse(JSON.parse(raw));
      } catch {
        // A malformed message invalidates EVERYTHING (fail-closed: a stale
        // policy is worse than a cold cache).
        parsed = { region: null };
      }
      for (const h of this.#handlers) h(parsed.region);
    });
  }
}
