// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server-blind WebRTC signaling rendezvous (OFFLINE_SPEC §16.3, §19.1, §26.4,
// WS-R.15.6a).  Two members establish a peer connection by exchanging SDP/ICE through
// the existing Licio HTTPS API, but this server is a DUMB store-and-forward mailbox: it
// routes an OPAQUE sealed blob to an opaque recipient peer key and NEVER decodes it.
// Structurally it cannot: the routing key rides the query string, the body is stored as
// raw bytes, and nothing here parses SDP/ICE or reads a peer network address (a §19.1
// static test asserts no `sdp`/`ice`/`candidate`/IP token appears in this file).  ICE
// candidates / peer IPs are a live-connection property of the direct browser↔browser
// channel only — they never reach this server.

import { readUvarint, type UvarintRead, writeUvarint } from '@licio/lcap';
// A deliberate lazy-use import cycle: the adapter imports this module's types +
// helpers, and this module constructs the adapter only inside getSignalMailbox()
// (call time, never module-eval) — safe under ESM live bindings.
import { RedisLcapSignalMailbox } from './redis-signal-mailbox.js';

/** A pending opaque blob queued for a recipient, with its enqueue time (for TTL). */
interface QueuedBlob {
  readonly blob: Uint8Array;
  readonly atMs: number;
}

export interface SignalMailboxConfig {
  /** Max bytes of one sealed blob (SDP/ICE are small; reject anything large). */
  readonly maxBlobBytes: number;
  /** Max pending blobs per recipient (drop-oldest beyond this). */
  readonly maxQueuePerPeer: number;
  /** How long an undelivered blob lives before it is swept (ms). */
  readonly ttlMs: number;
  /** Max distinct recipient mailboxes held at once (bounded memory). */
  readonly maxPeers: number;
}

export const DEFAULT_SIGNAL_CONFIG: SignalMailboxConfig = {
  maxBlobBytes: 32 * 1024,
  maxQueuePerPeer: 32,
  ttlMs: 60_000,
  maxPeers: 10_000,
};

// An opaque peer key: a bounded, URL-safe token (a device-key hash, never an address).
const PEER_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export type PostResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 413 | 429 };

/** The mailbox contract the routes consume.  Methods may be sync (the
 *  in-memory adapter) or async (the Redis adapter) — callers always await. */
export interface SignalMailboxPort {
  post(to: string | undefined, blob: Uint8Array, nowMs: number): PostResult | Promise<PostResult>;
  drain(
    peer: string | undefined,
    nowMs: number,
  ): readonly Uint8Array[] | Promise<readonly Uint8Array[]>;
  size(): number | Promise<number>;
}

export class SignalMailbox implements SignalMailboxPort {
  private readonly queues = new Map<string, QueuedBlob[]>();
  constructor(private readonly config: SignalMailboxConfig = DEFAULT_SIGNAL_CONFIG) {}

  /** True for a well-formed opaque routing key. */
  static validKey(key: string | undefined): key is string {
    return typeof key === 'string' && PEER_KEY.test(key);
  }

  private sweep(nowMs: number): void {
    for (const [key, queue] of this.queues) {
      const live = queue.filter((q) => nowMs - q.atMs < this.config.ttlMs);
      if (live.length === 0) this.queues.delete(key);
      else this.queues.set(key, live);
    }
  }

  /** Enqueue an opaque sealed blob for recipient `to`; the server never decodes it. */
  post(to: string | undefined, blob: Uint8Array, nowMs: number): PostResult {
    if (!SignalMailbox.validKey(to)) return { ok: false, status: 400 };
    if (blob.length === 0) return { ok: false, status: 400 };
    if (blob.length > this.config.maxBlobBytes) return { ok: false, status: 413 };
    this.sweep(nowMs);
    if (!this.queues.has(to) && this.queues.size >= this.config.maxPeers) {
      return { ok: false, status: 429 }; // mailbox capacity reached; back off
    }
    const queue = this.queues.get(to) ?? [];
    queue.push({ blob, atMs: nowMs });
    // Bound the per-peer queue: a slow recipient never lets a sender exhaust memory.
    while (queue.length > this.config.maxQueuePerPeer) queue.shift();
    this.queues.set(to, queue);
    return { ok: true };
  }

  /** Drain (and clear) the live blobs queued for `peer`, newest discipline preserved. */
  drain(peer: string | undefined, nowMs: number): readonly Uint8Array[] {
    if (!SignalMailbox.validKey(peer)) return [];
    this.sweep(nowMs);
    const queue = this.queues.get(peer);
    if (!queue) return [];
    this.queues.delete(peer);
    return queue.filter((q) => nowMs - q.atMs < this.config.ttlMs).map((q) => q.blob);
  }

  /** Current distinct-recipient count (a health gauge; no content). */
  size(): number {
    return this.queues.size;
  }
}

/**
 * Frame opaque blobs into one response body: `uvarint(count) || (uvarint(len) || blob)*`.
 * The server moves bytes only; it never inspects a blob's content.
 */
export function frameBlobs(blobs: readonly Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [writeUvarint(blobs.length)];
  for (const blob of blobs) {
    parts.push(writeUvarint(blob.length), blob);
  }
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Inverse of {@link frameBlobs} (the client drains its pending blobs with this).  Parses
 * an UNTRUSTED network response, so it fails closed: a truncated or malformed frame stops
 * the parse and returns the well-formed prefix rather than throwing, and the loop is
 * bounded by the buffer length (each iteration consumes ≥1 byte) so a forged `count` can
 * never spin or over-allocate.
 */
export function unframeBlobs(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let pos = 0;
  let count: UvarintRead;
  try {
    count = readUvarint(bytes, pos);
  } catch {
    return out; // not even a count → nothing to parse
  }
  pos += count.bytesRead;
  for (let i = 0; i < count.value && pos < bytes.length; i++) {
    let len: UvarintRead;
    try {
      len = readUvarint(bytes, pos);
    } catch {
      break; // truncated length prefix
    }
    pos += len.bytesRead;
    if (len.value > bytes.length - pos) break; // declared payload overruns the buffer
    out.push(bytes.slice(pos, pos + len.value));
    pos += len.value;
  }
  return out;
}

/** The process-wide signaling mailbox: the shared Redis adapter when REDIS_URL
 *  is configured (production always — a blob posted on one instance is
 *  drainable on every other), else the in-memory adapter (single-process
 *  dev/test).  Lazy, like the sibling LCAP singletons. */
let singleton: SignalMailboxPort | null = null;
export function getSignalMailbox(): SignalMailboxPort {
  if (!singleton) {
    const redisUrl = process.env['REDIS_URL'];
    singleton = redisUrl ? new RedisLcapSignalMailbox(redisUrl) : new SignalMailbox();
  }
  return singleton;
}

/** Replace the singleton (tests / an explicit binding). */
export function setSignalMailbox(next: SignalMailboxPort | null): void {
  singleton = next;
}
