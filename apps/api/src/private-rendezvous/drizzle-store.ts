// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.6 — the gated Postgres adapter for the rendezvous PRESENCE store, behind
// the same `RendezvousStore` interface the in-memory adapter satisfies.  Only the
// §8.2-allowed opaque columns of `private_rendezvous_records` are written (blind
// ids + ciphertext + expiry); there is NO room/account reference (§15.3.1).  All
// access is Drizzle's parameterized builder (no string-SQL).  A re-announce is a
// delete-then-insert (the table has no (room,peer) unique constraint by design —
// it stores no stable identity).  Covered by the gated store-contract test.
//
// Signals (§15.4) are TRANSIENT and never persisted — they ride an in-memory
// mailbox even here (process-local, the same limitation as the WS-R LCAP signal
// mailbox; a multi-node deployment needs a shared transient store).

import { type DbExecutor, privateRendezvousRecords } from '@licio/db';
import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import {
  InMemoryRendezvousStore,
  MAX_RECORDS_PER_ROOM,
  type RendezvousStore,
  type StoredRendezvousRecord,
  type StoredSignal,
} from './stores.js';

export class DrizzleRendezvousStore implements RendezvousStore {
  /** Signals are transient (consumed once) — never written to Postgres. */
  private readonly signalMailbox = new InMemoryRendezvousStore();

  constructor(private readonly db: DbExecutor) {}

  async announce(record: StoredRendezvousRecord): Promise<void> {
    // Re-announce REPLACES the peer's prior record (no stable identity column,
    // §15.3.1).  The delete-then-insert must be atomic: two concurrent re-announces
    // for the same (room, peer) could both delete before either inserts, leaving
    // duplicate live rows a retrying client uses to consume multiple poll slots.
    // A transaction-scoped advisory lock keyed on (room, peer) serializes them
    // without adding a unique constraint (auto-released on commit/rollback).
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${record.roomBlindId}), hashtext(${record.peerBlindId}))`,
      );
      await tx
        .delete(privateRendezvousRecords)
        .where(
          and(
            eq(privateRendezvousRecords.roomBlindId, record.roomBlindId),
            eq(privateRendezvousRecords.peerBlindId, record.peerBlindId),
          ),
        );
      await tx.insert(privateRendezvousRecords).values({
        roomBlindId: record.roomBlindId,
        peerBlindId: record.peerBlindId,
        encryptedAnnouncement: record.encryptedAnnouncement,
        expiresAt: new Date(record.expiresAt),
      });
      await this.enforcePerRoomCap(tx, record.roomBlindId);
    });
  }

  /**
   * Bound the live rows for a room blind id (§27 anti-flood): keep the
   * `MAX_RECORDS_PER_ROOM` latest-expiring records and delete the rest, so a flood
   * under one room blind id cannot crowd real peers out of a `poll(limit)` window.
   * Mirrors the in-memory store's soonest-expiring eviction.  Single-statement
   * (delete-where-in-subquery) on the supplied executor (the announce transaction).
   */
  private async enforcePerRoomCap(db: DbExecutor, roomBlindId: string): Promise<void> {
    const overflow = db
      .select({ id: privateRendezvousRecords.rendezvousId })
      .from(privateRendezvousRecords)
      .where(eq(privateRendezvousRecords.roomBlindId, roomBlindId))
      .orderBy(desc(privateRendezvousRecords.expiresAt))
      .offset(MAX_RECORDS_PER_ROOM);
    await db
      .delete(privateRendezvousRecords)
      .where(inArray(privateRendezvousRecords.rendezvousId, overflow));
  }

  async poll(roomBlindId: string, nowMs: number, limit: number): Promise<StoredRendezvousRecord[]> {
    const rows = await this.db
      .select({
        peerBlindId: privateRendezvousRecords.peerBlindId,
        encryptedAnnouncement: privateRendezvousRecords.encryptedAnnouncement,
        expiresAt: privateRendezvousRecords.expiresAt,
      })
      .from(privateRendezvousRecords)
      .where(
        and(
          eq(privateRendezvousRecords.roomBlindId, roomBlindId),
          // drizzle's `gt` binds the Date as a proper param (a raw `sql` template
          // rejects a Date under postgres@3.x); mirrors the `lte` in cleanup().
          gt(privateRendezvousRecords.expiresAt, new Date(nowMs)),
        ),
      )
      .limit(limit);
    return rows.map((r) => ({
      roomBlindId,
      peerBlindId: r.peerBlindId,
      encryptedAnnouncement: r.encryptedAnnouncement,
      expiresAt: r.expiresAt.getTime(),
    }));
  }

  putSignal(signal: StoredSignal): Promise<void> {
    return this.signalMailbox.putSignal(signal);
  }

  drainSignals(recipientBlindId: string, nowMs: number, limit: number): Promise<StoredSignal[]> {
    return this.signalMailbox.drainSignals(recipientBlindId, nowMs, limit);
  }

  async sweepExpired(nowMs: number): Promise<number> {
    const deleted = await this.db
      .delete(privateRendezvousRecords)
      .where(lte(privateRendezvousRecords.expiresAt, new Date(nowMs)))
      .returning({ id: privateRendezvousRecords.rendezvousId });
    const signalsSwept = await this.signalMailbox.sweepExpired(nowMs);
    return deleted.length + signalsSwept;
  }
}
