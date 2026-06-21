// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.2 part 2 — the gated Postgres adapter for the `LcapServerStore` boundary,
// behind the SAME interface the in-memory adapter satisfies.  All access is through
// Drizzle's parameterized query builder (no string-SQL injection surface); bytea ⇄
// Uint8Array converts at the boundary; idempotent writes use ON CONFLICT DO NOTHING
// (a record is accepted exactly once; the first device-(key,seq) claimant wins);
// and the per-room `seq` is the current room row count (matching the in-memory
// acceptance-log leaf index).  Covered by the gated store-contract integration test
// (DATABASE_URL) over the real migration chain — the project's standard policy.

import {
  type DbExecutor,
  lcapAcceptance,
  lcapDeviceSeq,
  lcapForkEvidence,
  lcapObjects,
} from '@licio/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ForkEvidence, LcapContentKind, LcapServerStore, StoredObject } from './store.js';

export class DrizzleLcapServerStore implements LcapServerStore {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async hasObject(cid: string): Promise<boolean> {
    const rows = await this.#db
      .select({ cid: lcapObjects.cid })
      .from(lcapObjects)
      .where(eq(lcapObjects.cid, cid))
      .limit(1);
    return rows.length > 0;
  }

  async getObject(cid: string): Promise<StoredObject | undefined> {
    const rows = await this.#db
      .select({ kind: lcapObjects.kind, bytes: lcapObjects.bytes })
      .from(lcapObjects)
      .where(eq(lcapObjects.cid, cid))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    // A fresh Uint8Array so the result never aliases the driver's buffer.
    return { kind: row.kind as LcapContentKind, bytes: new Uint8Array(row.bytes) };
  }

  async storeObject(cid: string, kind: LcapContentKind, bytes: Uint8Array): Promise<void> {
    await this.#db
      .insert(lcapObjects)
      .values({ cid, kind, bytes: Buffer.from(bytes) })
      .onConflictDoNothing();
  }

  async isAccepted(cid: string): Promise<boolean> {
    const rows = await this.#db
      .select({ cid: lcapAcceptance.cid })
      .from(lcapAcceptance)
      .where(eq(lcapAcceptance.cid, cid))
      .limit(1);
    return rows.length > 0;
  }

  async appendAcceptance(roomId: string, cid: string): Promise<number> {
    const seq = await this.roomSize(roomId);
    await this.#db.insert(lcapAcceptance).values({ roomId, seq, cid }).onConflictDoNothing();
    return seq;
  }

  async roomSeqOf(roomId: string, cid: string): Promise<number | undefined> {
    const rows = await this.#db
      .select({ seq: lcapAcceptance.seq })
      .from(lcapAcceptance)
      .where(and(eq(lcapAcceptance.roomId, roomId), eq(lcapAcceptance.cid, cid)))
      .limit(1);
    return rows[0]?.seq;
  }

  async roomSize(roomId: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(lcapAcceptance)
      .where(eq(lcapAcceptance.roomId, roomId));
    return rows[0]?.count ?? 0;
  }

  async getDeviceClaimant(deviceKeyId: string, deviceSeq: number): Promise<string | undefined> {
    const rows = await this.#db
      .select({ cid: lcapDeviceSeq.cid })
      .from(lcapDeviceSeq)
      .where(
        and(eq(lcapDeviceSeq.deviceKeyId, deviceKeyId), eq(lcapDeviceSeq.deviceSeq, deviceSeq)),
      )
      .limit(1);
    return rows[0]?.cid;
  }

  async setDeviceClaimant(deviceKeyId: string, deviceSeq: number, cid: string): Promise<void> {
    // The first claimant of a (key, seq) wins; a later distinct CID is fork evidence.
    await this.#db
      .insert(lcapDeviceSeq)
      .values({ deviceKeyId, deviceSeq, cid })
      .onConflictDoNothing();
  }

  async appendForkEvidence(evidence: ForkEvidence): Promise<void> {
    await this.#db.insert(lcapForkEvidence).values({
      authorDeviceKeyId: evidence.authorDeviceKeyId,
      deviceSeq: evidence.deviceSeq,
      existingCid: evidence.existingCid,
      conflictingCid: evidence.conflictingCid,
    });
  }

  async listForkEvidence(): Promise<readonly ForkEvidence[]> {
    return this.#db
      .select({
        authorDeviceKeyId: lcapForkEvidence.authorDeviceKeyId,
        deviceSeq: lcapForkEvidence.deviceSeq,
        existingCid: lcapForkEvidence.existingCid,
        conflictingCid: lcapForkEvidence.conflictingCid,
      })
      .from(lcapForkEvidence)
      .orderBy(asc(lcapForkEvidence.id));
  }
}
