// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Redis adapter for the WS-R.15.6a server-blind signaling mailbox — the
// multi-node binding: an opaque sealed blob posted on one instance is
// drainable on every other, and a restart no longer destroys a mid-handshake
// exchange within its TTL.  The server-blindness posture is identical to the
// in-memory mailbox (and the §19.1 static scan covers this file too): the
// routing key is an opaque bounded token, the payload is opaque bytes moved
// verbatim (base64 in transit through Redis), and nothing here parses or
// inspects a blob's content.
//
// Semantics mirror the in-memory `SignalMailbox`: per-recipient drop-oldest
// queue bound (LTRIM-native), per-blob TTL filtered at drain, and a bounded
// distinct-recipient registry (a capacity backstop — slightly racy across
// instances by design; the TTL prunes it continuously).
import IORedis from 'ioredis';
import {
  DEFAULT_SIGNAL_CONFIG,
  type PostResult,
  SignalMailbox,
  type SignalMailboxConfig,
  type SignalMailboxPort,
} from './signaling.js';

interface QueuedEntry {
  /** The opaque blob, base64 (never decoded beyond transport re-encoding). */
  b: string;
  atMs: number;
}

export class RedisLcapSignalMailbox implements SignalMailboxPort {
  readonly #redis: IORedis;
  readonly #config: SignalMailboxConfig;
  readonly #prefix: string;

  constructor(
    redis: IORedis | string,
    config: SignalMailboxConfig = DEFAULT_SIGNAL_CONFIG,
    prefix = 'lcapsig:',
  ) {
    this.#redis =
      typeof redis === 'string'
        ? new IORedis(redis, { lazyConnect: true, maxRetriesPerRequest: 3 })
        : redis;
    this.#config = config;
    this.#prefix = prefix;
  }

  #queueKey(peer: string): string {
    return `${this.#prefix}q:${peer}`;
  }

  #registryKey(): string {
    return `${this.#prefix}peers`;
  }

  async post(to: string | undefined, blob: Uint8Array, nowMs: number): Promise<PostResult> {
    if (!SignalMailbox.validKey(to)) return { ok: false, status: 400 };
    if (blob.length === 0) return { ok: false, status: 400 };
    if (blob.length > this.#config.maxBlobBytes) return { ok: false, status: 413 };
    const registry = this.#registryKey();
    const queueKey = this.#queueKey(to);
    // Bounded distinct-recipient registry: prune stale entries, then refuse a
    // NEW mailbox once the bound is reached (existing mailboxes keep working).
    await this.#redis.zremrangebyscore(registry, 0, nowMs - this.#config.ttlMs);
    const exists = (await this.#redis.exists(queueKey)) === 1;
    if (!exists && (await this.#redis.zcard(registry)) >= this.#config.maxPeers) {
      return { ok: false, status: 429 };
    }
    const entry: QueuedEntry = { b: Buffer.from(blob).toString('base64'), atMs: nowMs };
    await this.#redis
      .multi()
      .rpush(queueKey, JSON.stringify(entry))
      .ltrim(queueKey, -this.#config.maxQueuePerPeer, -1) // drop-oldest bound
      .pexpire(queueKey, this.#config.ttlMs)
      .zadd(registry, nowMs, to)
      .exec();
    return { ok: true };
  }

  async drain(peer: string | undefined, nowMs: number): Promise<readonly Uint8Array[]> {
    if (!SignalMailbox.validKey(peer)) return [];
    const queueKey = this.#queueKey(peer);
    // Read + delete atomically, so two draining replicas never both deliver
    // the same blob.
    const results = await this.#redis
      .multi()
      .lrange(queueKey, 0, -1)
      .del(queueKey)
      .zrem(this.#registryKey(), peer)
      .exec();
    const raw = (results?.[0]?.[1] ?? []) as string[];
    const out: Uint8Array[] = [];
    for (const item of raw) {
      try {
        const entry = JSON.parse(item) as QueuedEntry;
        if (
          typeof entry.b === 'string' &&
          typeof entry.atMs === 'number' &&
          nowMs - entry.atMs < this.#config.ttlMs
        ) {
          out.push(new Uint8Array(Buffer.from(entry.b, 'base64')));
        }
      } catch {
        // A corrupted entry is dropped, never a crash.
      }
    }
    return out;
  }

  async size(): Promise<number> {
    await this.#redis.zremrangebyscore(this.#registryKey(), 0, Date.now() - this.#config.ttlMs);
    return this.#redis.zcard(this.#registryKey());
  }
}
