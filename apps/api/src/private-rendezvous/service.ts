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
//     bounded list (256), never a 404, so a well-formed-but-unknown blind id is
//     indistinguishable from a known-but-empty one.
//   • Aggregate-only metrics — counters carry NO room/account identity (§27.2).
//
// Signals (§15.4) are TRANSIENT (seconds-lived, consumed once); the durable
// `private_rendezvous_records` table persists only PRESENCE.  In the Postgres
// binding the signal mailbox rides the shared Redis adapter when REDIS_URL is
// configured (production always — multi-node safe, native TTL), else the
// process-local in-memory mailbox (single-process dev).

import { createDbClient } from '@licio/db';
import { RENDEZVOUS_MAX_RECORDS_PER_POLL } from '@licio/shared';
import IORedis from 'ioredis';
import { DrizzleRendezvousStore } from './drizzle-store.js';
import { RedisSignalMailbox } from './redis-signal-mailbox.js';
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

/** The §15.3.1/§15.3.2 server bounds.  `apps/api` does not depend on
 *  `@licio/private-p2p` at all (PRIV-API-RENDEZVOUS-1), so the TTL ceiling is
 *  AUTHORITATIVE here.  The poll cap is NOT: it is a two-party WIRE limit the
 *  peer validates against too, so it comes from `@licio/shared`, the only
 *  package both planes may reach. */
export const DEFAULT_RENDEZVOUS_CONFIG: RendezvousServiceConfig = {
  maxTtlMs: 30 * 60 * 1000,
  maxRecordsPerPoll: RENDEZVOUS_MAX_RECORDS_PER_POLL,
  clockSkewToleranceMs: 5 * 60 * 1000,
};

/** The outcome of an announce: stored as a §27 Tier-1 presence slot, or rejected for an
 *  out-of-bound TTL.  (PRIV-API-RENDEZVOUS-1: the server-side Tier-2 cap was removed — the cap is
 *  enforced PEER-SIDE only, sealed inside the announcement, so the server never verifies a proof.) */
export interface AnnounceResult {
  readonly stored: boolean;
  readonly reason?: 'ttl';
}

/**
 * A presence record as returned to a poller.  `room_blind_id` is echoed back (it equals the poll
 * key the caller supplied) because the client REBUILDS the §15.3 announcement AEAD AAD from it to
 * open the sealed `encrypted_announcement` (`openRendezvousAnnouncement` binds room+peer+expiry):
 * omitting it makes the canonical `BlindRendezvousRecord` schema reject every polled record and the
 * peer unable to decrypt — so the wire mirrors the canonical full record, not a stripped subset.
 */
export interface WirePresenceRecord {
  readonly room_blind_id: string;
  readonly peer_blind_id: string;
  readonly encrypted_announcement: string;
  readonly expires_at: number;
}

/**
 * A queued signal as returned to its recipient.  `recipient_blind_id` is echoed back (it equals the
 * drain key the caller supplied) because the client REBUILDS the §15.4 signal AEAD AAD from it to
 * open the sealed `ciphertext` (`openSignal` binds room+sender+recipient+expiry): omitting it makes
 * the canonical `EncryptedSignal` schema reject the signal and the peer unable to decrypt.
 */
export interface WireSignal {
  readonly room_blind_id: string;
  readonly sender_blind_id: string;
  readonly recipient_blind_id: string;
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

  /** Store a presence record with its AAD-bound TTL verbatim, rejecting (not rewriting) one that is
   *  already expired or exceeds the server retention bound.  The per-device derived `peer_blind_id`
   *  already gives one §27 slot per device per bucket (a re-announce REPLACES it); the per-announcer
   *  cap is enforced PEER-SIDE (sealed inside the announcement), so the server stores opaquely and
   *  runs the Tier-1 sample-poll (PRIV-API-RENDEZVOUS-1). */
  async announce(req: AnnounceRequest): Promise<AnnounceResult> {
    if (!this.withinTtlBound(req.expires_at)) return { stored: false, reason: 'ttl' };
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
        // Echo the room blind id (the poll key) so the client can rebuild the §15.3 AEAD AAD.
        room_blind_id: roomBlindId,
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
        // Echo the recipient blind id (the drain key) so the client can rebuild the §15.4 AEAD AAD.
        recipient_blind_id: s.recipientBlindId,
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
  if (!dbUrl) return new InMemoryRendezvousStore();
  // Production (both URLs are boot-required there): presence in Postgres, the
  // §15.4 transient signal mailbox in Redis — so a signal posted on one
  // instance is drainable on every other and survives a restart within its
  // TTL.  Without Redis (a bare dev boot with only Postgres) the mailbox
  // stays process-local.
  const redisUrl = process.env['REDIS_URL'];
  return new DrizzleRendezvousStore(
    createDbClient(dbUrl),
    redisUrl
      ? new RedisSignalMailbox(new IORedis(redisUrl, { maxRetriesPerRequest: 3 }))
      : undefined,
  );
}

let service: RendezvousService | undefined;

/** The process-wide rendezvous service (created lazily; Postgres when configured).  The server runs
 *  the §27 Tier-1 sample-poll only — the per-announcer cap is enforced PEER-SIDE (PRIV-API-RENDEZVOUS-1). */
export function getRendezvousService(): RendezvousService {
  if (!service) {
    service = new RendezvousService(buildStore(), DEFAULT_RENDEZVOUS_CONFIG, () => Date.now());
  }
  return service;
}

/** Replace the singleton (tests / an explicit binding). */
export function setRendezvousService(next: RendezvousService): void {
  service = next;
}
