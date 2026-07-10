// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Redis adapter for the WS-S §15.4 TRANSIENT signal mailbox — the multi-node
// binding the Postgres presence adapter composes: an SDP/ICE signal posted on
// one instance is drainable on every other, and a restart no longer destroys a
// mid-handshake exchange.  The store keeps the in-memory adapter's carefully
// reasoned semantics EXACTLY (PRIV-API-RENDEZVOUS-3/5/6/7): per-sender sub-cap
// (back-pressure, not eviction), ALWAYS-ADMIT with a UNIFORMLY RANDOM eviction
// once the per-recipient queue is full (identity- and timing-independent — a
// forged flood gains no deterministic power to evict or block a specific
// honest signal), and drain-consumes-all.  The enqueue runs as ONE Lua script
// so the read-modify-write is atomic across instances; the fairness randomness
// is supplied by the CALLER (Redis Lua's math.random is deterministic per
// invocation, which would make the eviction targetable).  Server-blindness is
// preserved: keys and payloads are opaque blind ids + ciphertext only.
import type IORedis from 'ioredis';
import { z } from 'zod';
import {
  MAX_SIGNALS_PER_PEER,
  MAX_SIGNALS_PER_SENDER,
  type RendezvousStore,
  type StoredSignal,
} from './stores.js';

/** The narrowed mailbox contract the Postgres presence adapter composes. */
export type SignalMailbox = Pick<RendezvousStore, 'putSignal' | 'drainSignals' | 'sweepExpired'>;

/** Shape guard for the Redis round-trip: a corrupted entry reads as absent. */
const storedSignalSchema = z
  .object({
    roomBlindId: z.string(),
    senderBlindId: z.string(),
    recipientBlindId: z.string(),
    ciphertext: z.string(),
    expiresAt: z.number(),
  })
  .strict();

const PUT_SIGNAL_LUA = `
local items = redis.call('LRANGE', KEYS[1], 0, -1)
local now = tonumber(ARGV[2])
local incoming = cjson.decode(ARGV[1])
local live = {}
local fromSender = 0
for i = 1, #items do
  local ok, s = pcall(cjson.decode, items[i])
  if ok and tonumber(s.expiresAt) and tonumber(s.expiresAt) > now then
    live[#live + 1] = items[i]
    if s.senderBlindId == incoming.senderBlindId then fromSender = fromSender + 1 end
  end
end
if fromSender >= tonumber(ARGV[4]) then return 0 end
if #live >= tonumber(ARGV[3]) then
  local idx = math.floor(tonumber(ARGV[5]) * #live) + 1
  if idx > #live then idx = #live end
  table.remove(live, idx)
end
live[#live + 1] = ARGV[1]
redis.call('DEL', KEYS[1])
redis.call('RPUSH', KEYS[1], unpack(live))
local maxExp = 0
for i = 1, #live do
  local ok, s = pcall(cjson.decode, live[i])
  if ok and tonumber(s.expiresAt) and tonumber(s.expiresAt) > maxExp then
    maxExp = tonumber(s.expiresAt)
  end
end
if maxExp > now then redis.call('PEXPIRE', KEYS[1], maxExp - now) end
return 1
`;

type RedisWithCommands = IORedis & {
  rdvPutSignal(
    key: string,
    signalJson: string,
    nowMs: number,
    maxPerPeer: number,
    maxPerSender: number,
    random: number,
  ): Promise<number>;
};

export class RedisSignalMailbox implements SignalMailbox {
  readonly #redis: RedisWithCommands;
  readonly #prefix: string;
  readonly #random: () => number;

  constructor(redis: IORedis, prefix = 'rdvsig:', random: () => number = Math.random) {
    const withCommands = redis as RedisWithCommands;
    if (typeof withCommands.rdvPutSignal !== 'function') {
      redis.defineCommand('rdvPutSignal', { numberOfKeys: 1, lua: PUT_SIGNAL_LUA });
    }
    this.#redis = withCommands;
    this.#prefix = prefix;
    this.#random = random;
  }

  #key(recipientBlindId: string): string {
    return `${this.#prefix}${recipientBlindId}`;
  }

  async putSignal(signal: StoredSignal): Promise<void> {
    await this.#redis.rdvPutSignal(
      this.#key(signal.recipientBlindId),
      JSON.stringify(signal),
      Date.now(),
      MAX_SIGNALS_PER_PEER,
      MAX_SIGNALS_PER_SENDER,
      this.#random(),
    );
  }

  async drainSignals(
    recipientBlindId: string,
    nowMs: number,
    limit: number,
  ): Promise<StoredSignal[]> {
    // Read + delete atomically (MULTI), so two draining replicas never both
    // deliver the same signal; the queue is CONSUMED in full and every live
    // signal is returned (the DoS bound is the per-peer INSERT cap — see the
    // in-memory adapter's RENDEZVOUS-2 note).
    const results = await this.#redis
      .multi()
      .lrange(this.#key(recipientBlindId), 0, -1)
      .del(this.#key(recipientBlindId))
      .exec();
    const raw = (results?.[0]?.[1] ?? []) as string[];
    const live: StoredSignal[] = [];
    for (const item of raw) {
      try {
        const parsed = storedSignalSchema.safeParse(JSON.parse(item));
        if (parsed.success && parsed.data.expiresAt > nowMs) live.push(parsed.data);
      } catch {
        // A corrupted entry is dropped, never a crash.
      }
    }
    return live.slice(0, Math.max(limit, MAX_SIGNALS_PER_PEER));
  }

  async sweepExpired(_nowMs: number): Promise<number> {
    // Redis expires whole queues natively (the PEXPIRE bound to the farthest
    // live expiry); per-item expiry is filtered at drain time.
    return 0;
  }
}
