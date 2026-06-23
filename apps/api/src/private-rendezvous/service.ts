// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.6 — the server-blind rendezvous service (PRIVATE_SPEC §15.3, §21.5,
// §27.2).  Enforces the server-side bounds the §15.3 design requires regardless
// of client input:
//
//   • TTL bound — the client's `expires_at` is AAD-bound into the sealed
//     announcement/signal (the peer reconstructs the AEAD AAD from the returned
//     `expires_at`), so the server must store it VERBATIM — silently clamping it
//     would make every otherwise-valid peer fail to decrypt.  Instead the server
//     REJECTS a record whose TTL exceeds `maxTtlMs` (plus a small clock-skew
//     tolerance, since the client stamps `expires_at` off its own clock) or that
//     is already expired, so auto-expiry still cannot be defeated.
//   • Bounded poll (§15.3.1 no-existence-oracle) — `poll` ALWAYS returns a
//     bounded list (200), never a 404, so a well-formed-but-unknown blind id is
//     indistinguishable from a known-but-empty one.
//   • Aggregate-only metrics — counters carry NO room/account identity (§27.2).
//
// Signals (§15.4) are TRANSIENT (seconds-lived, consumed once); the durable
// `private_rendezvous_records` table persists only PRESENCE.  In the Postgres
// binding the signal mailbox stays in-memory (process-local — a multi-node
// deployment needs a shared transient store, the same tracked limitation as the
// WS-R LCAP signal mailbox).

import { createDbClient } from '@licio/db';
import { DrizzleRendezvousStore } from './drizzle-store.js';
import {
  type AnnounceRequest,
  InMemoryRendezvousStore,
  type RendezvousStore,
  type SignalRequest,
} from './stores.js';

export interface RendezvousServiceConfig {
  /** §15.3.2 — the maximum retention the server allows (bounds, never rewrites,
   *  the AAD-bound client TTL: an over-long record is rejected, not clamped). */
  readonly maxTtlMs: number;
  /** §15.3.1 — the bounded poll response size (never an existence oracle). */
  readonly maxRecordsPerPoll: number;
  /** Tolerance for the client stamping `expires_at` off its own (possibly-ahead)
   *  clock, so a normal max-TTL record is not rejected for minor skew. */
  readonly clockSkewToleranceMs: number;
}

/** Mirrors the §15.3.2 client bounds (`@licio/private-p2p` RENDEZVOUS_MAX_TTL_MS /
 *  RENDEZVOUS_MAX_RECORDS_PER_POLL); defined here so the server stays free of the
 *  client plane's package. */
export const DEFAULT_RENDEZVOUS_CONFIG: RendezvousServiceConfig = {
  maxTtlMs: 30 * 60 * 1000,
  maxRecordsPerPoll: 256,
  clockSkewToleranceMs: 5 * 60 * 1000,
};

/** A presence record as returned to a poller (the room blind id is the poll key). */
export interface WirePresenceRecord {
  readonly peer_blind_id: string;
  readonly encrypted_announcement: string;
  readonly expires_at: number;
}

/** A queued signal as returned to its recipient. */
export interface WireSignal {
  readonly room_blind_id: string;
  readonly sender_blind_id: string;
  readonly ciphertext: string;
  readonly expires_at: number;
}

/** Aggregate-only counters (NO room/account identity, §27.2). */
export interface RendezvousMetrics {
  announces: number;
  polls: number;
  signalsPosted: number;
  signalsDrained: number;
  swept: number;
}

export class RendezvousService {
  private readonly metricsState: RendezvousMetrics = {
    announces: 0,
    polls: 0,
    signalsPosted: 0,
    signalsDrained: 0,
    swept: 0,
  };

  constructor(
    private readonly store: RendezvousStore,
    private readonly config: RendezvousServiceConfig = DEFAULT_RENDEZVOUS_CONFIG,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Store a presence record with its AAD-bound TTL verbatim, rejecting (not
   *  rewriting) one that is already expired or exceeds the server retention bound. */
  async announce(req: AnnounceRequest): Promise<{ stored: boolean }> {
    if (!this.withinTtlBound(req.expires_at)) return { stored: false };
    await this.store.announce({
      roomBlindId: req.room_blind_id,
      peerBlindId: req.peer_blind_id,
      encryptedAnnouncement: req.encrypted_announcement,
      expiresAt: req.expires_at,
    });
    this.metricsState.announces += 1;
    return { stored: true };
  }

  /** A TTL is accepted iff it is still in the future and within the server bound
   *  (`maxTtlMs` + a clock-skew tolerance).  The value is never rewritten — it is
   *  AAD-bound into the sealed payload, so clamping would break peer decryption. */
  private withinTtlBound(expiresAt: number): boolean {
    const now = this.now();
    return (
      expiresAt > now && expiresAt <= now + this.config.maxTtlMs + this.config.clockSkewToleranceMs
    );
  }

  /**
   * Return the non-expired presence records for a room blind id, bounded by
   * `maxRecordsPerPoll`.  ALWAYS a list (never 404) — the §15.3.1 no-existence-
   * oracle property: an unknown blind id yields the same `{ records: [] }` shape
   * as a known-but-empty one.
   */
  async poll(roomBlindId: string): Promise<{ records: WirePresenceRecord[] }> {
    this.metricsState.polls += 1;
    const records = await this.store.poll(roomBlindId, this.now(), this.config.maxRecordsPerPoll);
    return {
      records: records.map((r) => ({
        peer_blind_id: r.peerBlindId,
        encrypted_announcement: r.encryptedAnnouncement,
        expires_at: r.expiresAt,
      })),
    };
  }

  /** Queue an opaque signal for its recipient, storing its AAD-bound TTL verbatim
   *  and rejecting (not rewriting) one expired or beyond the server bound. */
  async signal(req: SignalRequest): Promise<{ stored: boolean }> {
    if (!this.withinTtlBound(req.expires_at)) return { stored: false };
    await this.store.putSignal({
      roomBlindId: req.room_blind_id,
      senderBlindId: req.sender_blind_id,
      recipientBlindId: req.recipient_blind_id,
      ciphertext: req.ciphertext,
      expiresAt: req.expires_at,
    });
    this.metricsState.signalsPosted += 1;
    return { stored: true };
  }

  /** Drain (return + delete) the caller's non-expired queued signals. */
  async drainSignals(peerBlindId: string): Promise<{ signals: WireSignal[] }> {
    this.metricsState.signalsDrained += 1;
    const signals = await this.store.drainSignals(
      peerBlindId,
      this.now(),
      this.config.maxRecordsPerPoll,
    );
    return {
      signals: signals.map((s) => ({
        room_blind_id: s.roomBlindId,
        sender_blind_id: s.senderBlindId,
        ciphertext: s.ciphertext,
        expires_at: s.expiresAt,
      })),
    };
  }

  /** Delete every expired record/signal (the lease-guarded sweep calls this). */
  async sweep(): Promise<number> {
    const removed = await this.store.sweepExpired(this.now());
    this.metricsState.swept += removed;
    return removed;
  }

  /** A snapshot of the aggregate-only counters (no room identity). */
  metrics(): RendezvousMetrics {
    return { ...this.metricsState };
  }
}

function buildStore(): RendezvousStore {
  const dbUrl = process.env['DATABASE_URL'];
  return dbUrl ? new DrizzleRendezvousStore(createDbClient(dbUrl)) : new InMemoryRendezvousStore();
}

let service: RendezvousService | undefined;

/** The process-wide rendezvous service (created lazily; Postgres when configured). */
export function getRendezvousService(): RendezvousService {
  if (!service) service = new RendezvousService(buildStore());
  return service;
}

/** Replace the singleton (tests / an explicit binding). */
export function setRendezvousService(next: RendezvousService): void {
  service = next;
}
