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

// NOTE (PRIV-API-RENDEZVOUS-1): the SERVER-side Tier-2 cap was REMOVED.  Verifying a per-announcer
// BBS proof server-side requires the server to hold the per-(room, epoch) issuer key, which is a
// stable cross-bucket linking handle that breaks §15.3 unlinkability.  The cap is now enforced
// PEER-SIDE only (sealed inside the announcement, opened by a member), so the announce wire carries
// NO cap and the server runs the §27 Tier-1 sample-poll.

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
  /** Store a presence record, deduped by its sealed-announcement CONTENT (an identical re-announce is
   *  idempotent; a DISTINCT announcement coexists — it never replaces another by the forgeable
   *  `peer_blind_id`, PRIV-API-RENDEZVOUS-4). */
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
 * Per-SENDER sub-cap within one recipient's queue: one `sender_blind_id` may occupy at most
 * this many of the `MAX_SIGNALS_PER_PEER` slots, so a single flooder cannot fill a victim's
 * queue and starve the connection-bootstrapping offer of another peer.  256/32 = 8 distinct
 * senders before the queue is full; a legitimate offer→answer→ICE exchange is well under 32.
 */
export const MAX_SIGNALS_PER_SENDER = 32;

/**
 * A UNIFORM random sample of `k` items from `items` (caller ensures `k < items.length`),
 * via a partial Fisher–Yates shuffle: O(k), and each item is equally likely to be selected.
 * `random` returns [0, 1); the index is clamped so an injected RNG that returns exactly 1
 * cannot read past the array.  This is load-balancing/fairness randomness, NOT security
 * randomness — predicting the sample yields no attacker advantage.
 */
export function sampleUniform<T>(items: readonly T[], k: number, random: () => number): T[] {
  const arr = [...items];
  const n = arr.length;
  for (let i = 0; i < k; i++) {
    const j = i + Math.min(n - i - 1, Math.floor(random() * (n - i)));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr.slice(0, k);
}

/**
 * The in-memory rendezvous store (local/dev default).  Records are keyed by room
 * blind id (inner-keyed by the sealed announcement CONTENT so a distinct announcement
 * coexists rather than replacing another by the forgeable peer blind id,
 * PRIV-API-RENDEZVOUS-4); signals are keyed by recipient blind id.  Both maps are
 * capped + swept.
 */
export class InMemoryRendezvousStore implements RendezvousStore {
  private readonly records = new Map<string, Map<string, StoredRendezvousRecord>>();
  private readonly signals = new Map<string, StoredSignal[]>();

  /**
   * `random` (default `Math.random`) drives the §27 sample-poll; injectable so tests are
   * deterministic.  It is fairness randomness, not security randomness.
   */
  constructor(private readonly random: () => number = Math.random) {}

  announce(record: StoredRendezvousRecord): Promise<void> {
    let perRoom = this.records.get(record.roomBlindId);
    if (!perRoom) {
      perRoom = new Map();
      this.records.set(record.roomBlindId, perRoom);
    }
    // Key by the SEALED ANNOUNCEMENT CONTENT, NOT the peer blind id (PRIV-API-RENDEZVOUS-4).  After
    // the server-side cap removal (PRIV-API-RENDEZVOUS-1) the `peer_blind_id` is derivable by ANY
    // member from the room key + a device id, so keying the slot on it let a hostile member announce
    // into an honest device's slot and OVERWRITE its presence with a mismatched record — pollers then
    // dial the spoof, fail the handshake, and never see the (absent) honest record.  Content-keying
    // makes a distinct (spoof or re-announced) announcement COEXIST rather than replace: an identical
    // re-announce is idempotent, the honest record survives, and the §27 sample-poll + the peer-side
    // membership handshake filter the spoofs.
    perRoom.set(record.encryptedAnnouncement, record);
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
    // §27 SAMPLE-POLL (Tier-1 flood dilution): when more live records exist than the poll
    // window, return a UNIFORM RANDOM SAMPLE rather than the insertion-order front — so an
    // insider flood under one room_blind_id cannot DETERMINISTICALLY crowd an honest peer out
    // of every poll (each honest record appears with probability `limit/live` per poll; the
    // client's repeated polls then discover it).  A genuine per-announcer cap is infeasible
    // under server-blindness without an anonymous-credential layer (the documented closure
    // target); this is the cheap mitigation that preserves §15.3.1 (no identity is learned).
    if (live.length <= limit) return Promise.resolve(live);
    return Promise.resolve(sampleUniform(live, limit, this.random));
  }

  putSignal(signal: StoredSignal): Promise<void> {
    const queue = this.signals.get(signal.recipientBlindId) ?? [];
    // Per-SENDER bound: one sender_blind_id cannot occupy more than MAX_SIGNALS_PER_SENDER of the
    // recipient's queue.  NOTE (PRIV-API-RENDEZVOUS-3): `sender_blind_id` is UNAUTHENTICATED (no
    // Tier-2), so this bounds an ACCIDENTAL single-sender flood only — a deliberate flooder simply
    // varies the id.  The FAIR eviction below is what keeps a fresh peer's bootstrap offer insertable
    // against such a many-id flood.
    let fromSender = 0;
    for (const s of queue) if (s.senderBlindId === signal.senderBlindId) fromSender += 1;
    if (fromSender >= MAX_SIGNALS_PER_SENDER) return Promise.resolve(); // back-pressure the sender
    if (queue.length >= MAX_SIGNALS_PER_PEER) {
      // FAIR eviction (PRIV-API-RENDEZVOUS-3/5): instead of drop-newest, make room by evicting the
      // OLDEST signal from the sender holding STRICTLY MORE slots than THIS sender will hold AFTER
      // inserting (`fromSender + 1`) — so an under-represented sender displaces an over-represented
      // flooder, but a SINGLETON can NEVER evict another SINGLETON.  The threshold MUST be
      // `fromSender + 1`, not `fromSender`: `sender_blind_id` is unauthenticated (no Tier-2), so a
      // flooder fills the queue with one-signal forged ids; with a `fromSender` (=0 for a fresh id)
      // threshold each new forged singleton would evict an EXISTING one-slot sender — and the FIRST
      // such victim is the honest bootstrap offer queued earliest, starving the WebRTC dial despite
      // the per-sender cap (PRIV-API-RENDEZVOUS-5).  Requiring a victim STRICTLY heavier than this
      // sender's post-insert count protects every already-queued singleton: when no sender is
      // over-represented (all at parity), the NEW signal is drop-newest, never an honest one.
      const counts = new Map<string, number>();
      for (const s of queue) counts.set(s.senderBlindId, (counts.get(s.senderBlindId) ?? 0) + 1);
      let victim: string | undefined;
      let victimCount = fromSender + 1;
      for (const [sender, count] of counts) {
        if (count > victimCount) {
          victimCount = count;
          victim = sender;
        }
      }
      if (victim === undefined) return Promise.resolve(); // no over-represented sender ⇒ drop-newest
      const evictIdx = queue.findIndex((s) => s.senderBlindId === victim);
      if (evictIdx < 0) return Promise.resolve(); // unreachable; fail safe
      queue.splice(evictIdx, 1);
    }
    queue.push(signal);
    this.signals.set(signal.recipientBlindId, queue);
    return Promise.resolve();
  }

  drainSignals(recipientBlindId: string, nowMs: number, limit: number): Promise<StoredSignal[]> {
    const queue = this.signals.get(recipientBlindId);
    if (!queue) return Promise.resolve([]);
    this.signals.delete(recipientBlindId);
    // The queue is CONSUMED in full (deleted above), so EVERY live signal must be returned —
    // slicing to `limit` here silently DROPPED the connection-bootstrapping signals past the cap
    // (RENDEZVOUS-2: a live offer/answer/ICE frame lost ⇒ a stalled WebRTC dial).  The DoS bound is
    // the per-peer INSERT cap (MAX_SIGNALS_PER_PEER), not this drain limit; keep `limit` as a
    // defensive ceiling held ≥ that cap so the two constants can never diverge into a silent loss.
    const live = queue.filter((s) => s.expiresAt > nowMs);
    return Promise.resolve(live.slice(0, Math.max(limit, MAX_SIGNALS_PER_PEER)));
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
