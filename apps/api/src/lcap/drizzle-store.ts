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
  lcapCapabilityUsage,
  lcapDeviceSeq,
  lcapForkEvidence,
  lcapObjects,
  lcapRecordClosure,
} from '@licio/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import type {
  AcceptContributionResult,
  CapabilityQuotaLimits,
  ForkEvidence,
  LcapContentKind,
  LcapServerStore,
  RecordEdgeRelation,
  StoredObject,
} from './store.js';

/** A Postgres unique/PK violation (SQLSTATE 23505) — used to retry a seq/cid race. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

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
    // Idempotent: an already-accepted cid keeps its original seq (the globally-UNIQUE cid).
    const existing = await this.roomSeqOf(roomId, cid);
    if (existing !== undefined) return existing;
    // Allocate the next per-room seq ATOMICALLY: insert at the current count and, on a
    // (room_id, seq) collision with a concurrent accept, retry at the new count.  The PK
    // (room_id, seq) guarantees no two records share a seq, and `.returning()` after
    // ON CONFLICT DO NOTHING is non-empty ONLY when THIS row was actually inserted — so we
    // never return a phantom seq for a record absent from the log (the prior bug).
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const seq = await this.roomSize(roomId);
      const inserted = await this.#db
        .insert(lcapAcceptance)
        .values({ roomId, seq, cid })
        .onConflictDoNothing()
        .returning({ seq: lcapAcceptance.seq });
      if (inserted[0] !== undefined) return inserted[0].seq;
      // Nothing inserted → either this cid raced in (return its real seq) or a concurrent
      // accept took `seq` (retry at the new count).
      const now = await this.roomSeqOf(roomId, cid);
      if (now !== undefined) return now;
    }
    throw new Error('appendAcceptance: exhausted room-sequence allocation retries');
  }

  async acceptContribution(
    roomId: string,
    cid: string,
    eventBytes: number,
    mediaBytes: number,
    quota: CapabilityQuotaLimits,
  ): Promise<AcceptContributionResult> {
    // The whole accept is one transaction so the quota check + the room-log append + the
    // budget debit commit together (or not at all).  A (room_id, seq) PK collision with a
    // concurrent same-room accept (possibly under a different capability, so not serialized
    // by the usage-row lock below) aborts the tx; the outer loop retries.
    for (let attempt = 0; attempt < 10_000; attempt++) {
      try {
        return await this.#db.transaction(async (tx): Promise<AcceptContributionResult> => {
          // Idempotency: an already-accepted cid keeps its seq and is NOT re-debited.
          const existing = await tx
            .select({ seq: lcapAcceptance.seq })
            .from(lcapAcceptance)
            .where(eq(lcapAcceptance.cid, cid))
            .limit(1);
          if (existing[0] !== undefined) return { ok: true, seq: existing[0].seq };

          // Ensure the usage row exists, then LOCK it (`FOR UPDATE`) so the check + debit for
          // THIS capability is serialized — two concurrent accepts cannot both pass the check.
          await tx
            .insert(lcapCapabilityUsage)
            .values({ capabilityId: quota.capabilityId })
            .onConflictDoNothing();
          const usageRows = await tx
            .select({
              eventCount: lcapCapabilityUsage.eventCount,
              totalBytes: lcapCapabilityUsage.totalBytes,
              mediaBytes: lcapCapabilityUsage.mediaBytes,
            })
            .from(lcapCapabilityUsage)
            .where(eq(lcapCapabilityUsage.capabilityId, quota.capabilityId))
            .for('update');
          const events = usageRows[0]?.eventCount ?? 0;
          const totalBytes = usageRows[0]?.totalBytes ?? 0;
          const usedMediaBytes = usageRows[0]?.mediaBytes ?? 0;
          if (events + 1 > quota.maxEvents) return { ok: false, reason: 'offline_event_quota' };
          if (totalBytes + eventBytes > quota.maxTotalBytes) {
            return { ok: false, reason: 'total_payload_quota' };
          }
          if (usedMediaBytes + mediaBytes > quota.maxMediaBytes) {
            return { ok: false, reason: 'media_payload_quota' };
          }

          // Allocate the next per-room seq + append (PK guards uniqueness) and debit the
          // budget — all in this transaction, so the debit happens iff the append commits.
          const countRows = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(lcapAcceptance)
            .where(eq(lcapAcceptance.roomId, roomId));
          const seq = countRows[0]?.count ?? 0;
          await tx.insert(lcapAcceptance).values({ roomId, seq, cid });
          await tx
            .update(lcapCapabilityUsage)
            .set({
              eventCount: events + 1,
              totalBytes: totalBytes + eventBytes,
              mediaBytes: usedMediaBytes + mediaBytes,
            })
            .where(eq(lcapCapabilityUsage.capabilityId, quota.capabilityId));
          return { ok: true, seq };
        });
      } catch (err) {
        // A seq/cid race aborts the tx — retry; the idempotency check then short-circuits a
        // concurrent same-cid accept and the seq is re-allocated at the new room count.
        if (isUniqueViolation(err) && attempt < 9_999) continue;
        throw err;
      }
    }
    throw new Error('acceptContribution: exhausted accept retries');
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

  async listRooms(): Promise<readonly string[]> {
    const rows = await this.#db
      .selectDistinct({ roomId: lcapAcceptance.roomId })
      .from(lcapAcceptance)
      .orderBy(asc(lcapAcceptance.roomId));
    return rows.map((r) => r.roomId);
  }

  async roomLog(roomId: string): Promise<readonly string[]> {
    const rows = await this.#db
      .select({ cid: lcapAcceptance.cid })
      .from(lcapAcceptance)
      .where(eq(lcapAcceptance.roomId, roomId))
      .orderBy(asc(lcapAcceptance.seq));
    return rows.map((r) => r.cid);
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

  async claimDeviceSeq(deviceKeyId: string, deviceSeq: number, cid: string): Promise<string> {
    // Atomic first-claimant-wins: ON CONFLICT DO UPDATE to a NO-OP (keep the existing cid)
    // so RETURNING yields the CURRENT claimant — the new cid on a fresh insert, or the prior
    // winner on a conflict.  The conflicting INSERT takes a row lock, serializing concurrent
    // claims, so a return value other than `cid` is an authoritative device fork.
    const rows = await this.#db
      .insert(lcapDeviceSeq)
      .values({ deviceKeyId, deviceSeq, cid })
      .onConflictDoUpdate({
        target: [lcapDeviceSeq.deviceKeyId, lcapDeviceSeq.deviceSeq],
        set: { cid: sql`${lcapDeviceSeq.cid}` }, // no-op: keep the first claimant
      })
      .returning({ cid: lcapDeviceSeq.cid });
    return rows[0]?.cid ?? cid;
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

  async indexRecordEdge(
    recordCid: string,
    relatedCid: string,
    relation: RecordEdgeRelation,
  ): Promise<void> {
    await this.#db
      .insert(lcapRecordClosure)
      .values({ recordCid, relatedCid, relation })
      .onConflictDoNothing();
  }

  async recordEdges(recordCid: string, relation: RecordEdgeRelation): Promise<readonly string[]> {
    const rows = await this.#db
      .select({ relatedCid: lcapRecordClosure.relatedCid })
      .from(lcapRecordClosure)
      .where(
        and(eq(lcapRecordClosure.recordCid, recordCid), eq(lcapRecordClosure.relation, relation)),
      )
      .orderBy(asc(lcapRecordClosure.relatedCid));
    return rows.map((r) => r.relatedCid);
  }
}
