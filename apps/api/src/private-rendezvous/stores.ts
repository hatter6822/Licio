// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.6 — the server-blind rendezvous store (PRIVATE_SPEC §15.3, §21.5, §27.2).
//
// The server stores ONLY opaque blind ids + ciphertext + a short TTL for a
// Private P2P room (§8.2): it can NOT map a record to a room, account, member, or
// CID (§15.3.1).  These server-local zod schemas validate the WIRE SHAPE +
// bound every field for DoS, but the announcement / signal ciphertext is treated
// as fully opaque (never decoded — the server holds no keys).  Knowledge of the
// `rendezvous_key` IS the rendezvous capability; the server performs no ACL.
//
// This is intentionally NOT an import of `@licio/private-p2p`: the server is
// blind and needs none of that package's crypto — only the bounded opaque shape.
import { z } from 'zod';

/** A blind id (HMAC output, base64url) or an opaque relay handle — bounded. */
const blindIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'expected a base64url blind id');

/** An opaque sealed announcement (the server never decodes it) — bounded ≤ 16 KiB. */
const announcementCiphertextSchema = z.string().min(1).max(16_384);

/** An opaque sealed signaling blob (SDP/ICE, E2E-encrypted) — bounded ≤ 64 KiB. */
const signalCiphertextSchema = z.string().min(1).max(65_536);

/** §15.3 announce: store a presence record under a room blind id. */
export const announceRequestSchema = z
  .object({
    room_blind_id: blindIdSchema,
    peer_blind_id: blindIdSchema,
    encrypted_announcement: announcementCiphertextSchema,
    /** Absolute ms expiry; AAD-bound in the sealed announcement, so the server
     *  stores it VERBATIM and instead REJECTS one beyond `now + maxTtlMs` (§15.3.2). */
    expires_at: z.number().int().positive(),
  })
  .strict();
export type AnnounceRequest = z.infer<typeof announceRequestSchema>;

/** §15.3 poll: read presence records for a room blind id. */
export const pollRequestSchema = z.object({ room_blind_id: blindIdSchema }).strict();

/** §15.4 signal: route an opaque E2E-encrypted signaling blob to a recipient. */
export const signalRequestSchema = z
  .object({
    room_blind_id: blindIdSchema,
    sender_blind_id: blindIdSchema,
    recipient_blind_id: blindIdSchema,
    ciphertext: signalCiphertextSchema,
    expires_at: z.number().int().positive(),
  })
  .strict();
export type SignalRequest = z.infer<typeof signalRequestSchema>;

/** §15.4 signal drain: fetch + delete the caller's queued signals. */
export const signalPollRequestSchema = z.object({ peer_blind_id: blindIdSchema }).strict();

/** A stored presence record (opaque to the server). */
export interface StoredRendezvousRecord {
  readonly roomBlindId: string;
  readonly peerBlindId: string;
  readonly encryptedAnnouncement: string;
  readonly expiresAt: number;
}

/** A stored, still-undelivered signaling blob (opaque to the server). */
export interface StoredSignal {
  readonly roomBlindId: string;
  readonly senderBlindId: string;
  readonly recipientBlindId: string;
  readonly ciphertext: string;
  readonly expiresAt: number;
}

/**
 * The durable boundary for the rendezvous service.  An in-memory adapter ships
 * here; a gated Postgres adapter over `private_rendezvous_records` lives in
 * `drizzle-store.ts`.  Everything is keyed by a blind id; nothing references a
 * room/account.
 */
export interface RendezvousStore {
  /** Upsert a presence record (a peer re-announce REPLACES its prior record). */
  announce(record: StoredRendezvousRecord): Promise<void>;
  /** Non-expired presence records for a room blind id, capped at `limit`. */
  poll(roomBlindId: string, nowMs: number, limit: number): Promise<StoredRendezvousRecord[]>;
  /** Queue an opaque signal for its recipient blind id. */
  putSignal(signal: StoredSignal): Promise<void>;
  /** Return + DELETE the caller's non-expired queued signals, capped at `limit`. */
  drainSignals(recipientBlindId: string, nowMs: number, limit: number): Promise<StoredSignal[]>;
  /** Delete every expired record/signal; returns the number removed. */
  sweepExpired(nowMs: number): Promise<number>;
}

/** Per-room presence cap + per-peer signal-queue cap (bounded memory, §27). */
export const MAX_RECORDS_PER_ROOM = 512;
export const MAX_SIGNALS_PER_PEER = 256;

/**
 * The in-memory rendezvous store (local/dev default).  Records are keyed by room
 * blind id (inner-keyed by peer blind id so a re-announce replaces); signals are
 * keyed by recipient blind id.  Both maps are capped + swept.
 */
export class InMemoryRendezvousStore implements RendezvousStore {
  private readonly records = new Map<string, Map<string, StoredRendezvousRecord>>();
  private readonly signals = new Map<string, StoredSignal[]>();

  announce(record: StoredRendezvousRecord): Promise<void> {
    let perRoom = this.records.get(record.roomBlindId);
    if (!perRoom) {
      perRoom = new Map();
      this.records.set(record.roomBlindId, perRoom);
    }
    perRoom.set(record.peerBlindId, record);
    // Cap per room: evict the soonest-expiring once over the limit.
    if (perRoom.size > MAX_RECORDS_PER_ROOM) {
      let oldestKey: string | undefined;
      let oldestExpiry = Number.POSITIVE_INFINITY;
      for (const [key, value] of perRoom) {
        if (value.expiresAt < oldestExpiry) {
          oldestExpiry = value.expiresAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) perRoom.delete(oldestKey);
    }
    return Promise.resolve();
  }

  poll(roomBlindId: string, nowMs: number, limit: number): Promise<StoredRendezvousRecord[]> {
    const perRoom = this.records.get(roomBlindId);
    if (!perRoom) return Promise.resolve([]);
    const live: StoredRendezvousRecord[] = [];
    for (const record of perRoom.values()) {
      if (record.expiresAt > nowMs) live.push(record);
    }
    return Promise.resolve(live.slice(0, limit));
  }

  putSignal(signal: StoredSignal): Promise<void> {
    const queue = this.signals.get(signal.recipientBlindId) ?? [];
    queue.push(signal);
    // Cap the queue: drop the oldest once over the limit.
    if (queue.length > MAX_SIGNALS_PER_PEER) queue.splice(0, queue.length - MAX_SIGNALS_PER_PEER);
    this.signals.set(signal.recipientBlindId, queue);
    return Promise.resolve();
  }

  drainSignals(recipientBlindId: string, nowMs: number, limit: number): Promise<StoredSignal[]> {
    const queue = this.signals.get(recipientBlindId);
    if (!queue) return Promise.resolve([]);
    this.signals.delete(recipientBlindId);
    return Promise.resolve(queue.filter((s) => s.expiresAt > nowMs).slice(0, limit));
  }

  sweepExpired(nowMs: number): Promise<number> {
    let removed = 0;
    for (const [roomBlindId, perRoom] of this.records) {
      for (const [peerBlindId, record] of perRoom) {
        if (record.expiresAt <= nowMs) {
          perRoom.delete(peerBlindId);
          removed += 1;
        }
      }
      if (perRoom.size === 0) this.records.delete(roomBlindId);
    }
    for (const [recipientBlindId, queue] of this.signals) {
      const live = queue.filter((s) => s.expiresAt > nowMs);
      removed += queue.length - live.length;
      if (live.length === 0) this.signals.delete(recipientBlindId);
      else this.signals.set(recipientBlindId, live);
    }
    return Promise.resolve(removed);
  }
}
