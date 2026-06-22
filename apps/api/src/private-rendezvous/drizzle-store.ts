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
import { and, eq, lte, sql } from 'drizzle-orm';
import {
  InMemoryRendezvousStore,
  type RendezvousStore,
  type StoredRendezvousRecord,
  type StoredSignal,
} from './stores.js';

export class DrizzleRendezvousStore implements RendezvousStore {
  /** Signals are transient (consumed once) — never written to Postgres. */
  private readonly signalMailbox = new InMemoryRendezvousStore();

  constructor(private readonly db: DbExecutor) {}

  async announce(record: StoredRendezvousRecord): Promise<void> {
    // Re-announce replaces the peer's prior record (no stable identity column).
    await this.db
      .delete(privateRendezvousRecords)
      .where(
        and(
          eq(privateRendezvousRecords.roomBlindId, record.roomBlindId),
          eq(privateRendezvousRecords.peerBlindId, record.peerBlindId),
        ),
      );
    await this.db.insert(privateRendezvousRecords).values({
      roomBlindId: record.roomBlindId,
      peerBlindId: record.peerBlindId,
      encryptedAnnouncement: record.encryptedAnnouncement,
      expiresAt: new Date(record.expiresAt),
    });
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
          sql`${privateRendezvousRecords.expiresAt} > ${new Date(nowMs)}`,
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
