// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M gated Postgres adapters — the SAME surfaces as the in-memory stores in
// `stores.ts`, backed by the migration-0082 tables.  Unique-collision paths
// return null exactly like the in-memory emulation (23505 on the specific
// indexes), CAS transitions carry their expectation in the WHERE clause, and
// no adapter holds any in-memory state (check:prod-parity leg 3).

import {
  actionBudgets,
  type createDbClient,
  delegationRecords,
  governanceChallenges,
  governanceCharterVersions,
  paymentIntents,
  roomGovernanceProfiles,
  roomReadinessAttestations,
  roomTreasuries,
  treasuryGrants,
  treasuryReconciliationSnapshots,
  treasuryReservations,
} from '@licio/db';
import type { PauseFlags, PaymentIntentState } from '@licio/shared';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type {
  ActionBudgetRecord,
  ActionBudgetStore,
  AttestationRecord,
  AttestationStore,
  ChallengeRecord,
  ChallengeStore,
  CharterStore,
  CharterVersionRecord,
  DelegationRecordEntity,
  DelegationStore,
  GovernanceProfileRecord,
  GovernanceProfileStore,
  GrantMilestoneRecord,
  GrantRecord,
  GrantStore,
  PaymentIntentRecord,
  PaymentIntentStore,
  ReservationRecord,
  ReservationState,
  ReservationStore,
  SnapshotRecord,
  SnapshotStore,
  TreasuryRecord,
  TreasuryStore,
} from './stores.js';
import { projectGrantAggregates } from './stores.js';

type Db = ReturnType<typeof createDbClient>;

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value ? value.toISOString() : null);
const dateOrNull = (value: string | null | undefined): Date | null =>
  value == null ? null : new Date(value);
// Drizzle wraps driver errors (DrizzleQueryError → cause: PostgresError), so
// the SQLSTATE lives on the CAUSE chain — a direct `.code` check never fires
// and the raced insert would surface as a thrown 500 instead of the designed
// clean-loser null (the drizzle-debate-store house pattern).
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Governance profiles
// ---------------------------------------------------------------------------

function mapProfile(row: typeof roomGovernanceProfiles.$inferSelect): GovernanceProfileRecord {
  return {
    roomId: row.roomId,
    lawPackId: row.lawPackId,
    charterVersionId: row.charterVersionId,
    treasuryId: row.treasuryId,
    quorumPolicyRef: (row.quorumPolicyRef as Record<string, unknown> | null) ?? null,
    thresholdPolicyRef: (row.thresholdPolicyRef as Record<string, unknown> | null) ?? null,
    timelockPolicyRef: (row.timelockPolicyRef as Record<string, unknown> | null) ?? null,
    freezeState: row.freezeState,
    freezeReason: row.freezeReason,
    pauseFlags: row.pauseFlags as PauseFlags,
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleGovernanceProfileStore implements GovernanceProfileStore {
  constructor(private readonly db: Db) {}

  async get(roomId: string): Promise<GovernanceProfileRecord | null> {
    const rows = await this.db
      .select()
      .from(roomGovernanceProfiles)
      .where(eq(roomGovernanceProfiles.roomId, roomId))
      .limit(1);
    return rows[0] ? mapProfile(rows[0]) : null;
  }

  async upsert(record: GovernanceProfileRecord): Promise<GovernanceProfileRecord> {
    await this.db
      .insert(roomGovernanceProfiles)
      .values({
        roomId: record.roomId,
        lawPackId: record.lawPackId,
        charterVersionId: record.charterVersionId,
        treasuryId: record.treasuryId,
        quorumPolicyRef: record.quorumPolicyRef,
        thresholdPolicyRef: record.thresholdPolicyRef,
        timelockPolicyRef: record.timelockPolicyRef,
        freezeState: record.freezeState,
        freezeReason: record.freezeReason,
        pauseFlags: record.pauseFlags,
        updatedAt: new Date(record.updatedAt),
      })
      .onConflictDoUpdate({
        target: roomGovernanceProfiles.roomId,
        set: {
          lawPackId: record.lawPackId,
          charterVersionId: record.charterVersionId,
          treasuryId: record.treasuryId,
          quorumPolicyRef: record.quorumPolicyRef,
          thresholdPolicyRef: record.thresholdPolicyRef,
          timelockPolicyRef: record.timelockPolicyRef,
          freezeState: record.freezeState,
          freezeReason: record.freezeReason,
          pauseFlags: record.pauseFlags,
          updatedAt: new Date(record.updatedAt),
        },
      });
    return record;
  }

  async setCharterPointer(
    roomId: string,
    charterVersionId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(roomGovernanceProfiles)
      .set({ charterVersionId, updatedAt: new Date(updatedAt) })
      .where(eq(roomGovernanceProfiles.roomId, roomId))
      .returning({ roomId: roomGovernanceProfiles.roomId });
    return rows.length > 0;
  }

  async setTreasuryPointer(
    roomId: string,
    treasuryId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(roomGovernanceProfiles)
      .set({ treasuryId, updatedAt: new Date(updatedAt) })
      .where(eq(roomGovernanceProfiles.roomId, roomId))
      .returning({ roomId: roomGovernanceProfiles.roomId });
    return rows.length > 0;
  }

  async setProfilePauseFlags(
    roomId: string,
    flags: PauseFlags,
    updatedAt: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(roomGovernanceProfiles)
      .set({ pauseFlags: flags, updatedAt: new Date(updatedAt) })
      .where(eq(roomGovernanceProfiles.roomId, roomId))
      .returning({ roomId: roomGovernanceProfiles.roomId });
    return rows.length > 0;
  }

  async setLawPackRefs(
    roomId: string,
    refs: {
      lawPackId: string;
      quorumPolicyRef: Record<string, unknown>;
      thresholdPolicyRef: Record<string, unknown>;
      timelockPolicyRef: Record<string, unknown>;
    },
    updatedAt: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(roomGovernanceProfiles)
      .set({
        lawPackId: refs.lawPackId,
        quorumPolicyRef: refs.quorumPolicyRef,
        thresholdPolicyRef: refs.thresholdPolicyRef,
        timelockPolicyRef: refs.timelockPolicyRef,
        updatedAt: new Date(updatedAt),
      })
      .where(eq(roomGovernanceProfiles.roomId, roomId))
      .returning({ roomId: roomGovernanceProfiles.roomId });
    return rows.length > 0;
  }

  async listAll(): Promise<GovernanceProfileRecord[]> {
    const rows = await this.db.select().from(roomGovernanceProfiles);
    return rows.map(mapProfile);
  }

  async clear(): Promise<void> {
    await this.db.delete(roomGovernanceProfiles);
  }
}

// ---------------------------------------------------------------------------
// Charter versions (append-only; the trigger enforces immutability)
// ---------------------------------------------------------------------------

function mapCharter(row: typeof governanceCharterVersions.$inferSelect): CharterVersionRecord {
  return {
    charterVersionId: row.charterVersionId,
    roomId: row.roomId,
    version: row.version,
    sections: row.sections as CharterVersionRecord['sections'],
    contentHash: row.contentHash,
    createdByUserId: row.createdByUserId,
    createdAt: iso(row.createdAt),
  };
}

export class DrizzleCharterStore implements CharterStore {
  constructor(private readonly db: Db) {}

  async latestByRoom(roomId: string): Promise<CharterVersionRecord | null> {
    const rows = await this.db
      .select()
      .from(governanceCharterVersions)
      .where(eq(governanceCharterVersions.roomId, roomId))
      .orderBy(desc(governanceCharterVersions.version))
      .limit(1);
    return rows[0] ? mapCharter(rows[0]) : null;
  }

  async getById(charterVersionId: string): Promise<CharterVersionRecord | null> {
    const rows = await this.db
      .select()
      .from(governanceCharterVersions)
      .where(eq(governanceCharterVersions.charterVersionId, charterVersionId))
      .limit(1);
    return rows[0] ? mapCharter(rows[0]) : null;
  }

  async insert(record: CharterVersionRecord): Promise<CharterVersionRecord | null> {
    try {
      await this.db.insert(governanceCharterVersions).values({
        charterVersionId: record.charterVersionId,
        roomId: record.roomId,
        version: record.version,
        sections: record.sections,
        contentHash: record.contentHash,
        createdByUserId: record.createdByUserId,
        createdAt: new Date(record.createdAt),
      });
      return record;
    } catch (error) {
      if (isUniqueViolation(error)) return null; // (room, version) collision
      throw error;
    }
  }

  async listByRoom(roomId: string): Promise<CharterVersionRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceCharterVersions)
      .where(eq(governanceCharterVersions.roomId, roomId))
      .orderBy(desc(governanceCharterVersions.version));
    return rows.map(mapCharter);
  }

  /** Test/dev reset ONLY (interface parity with the in-memory store).  The
   *  append-only trigger rejects row DELETEs, so the sole reset path is
   *  TRUNCATE (which does not fire row-level triggers). */
  async clear(): Promise<void> {
    await this.db.execute(sql`truncate table ${governanceCharterVersions}`);
  }
}

// ---------------------------------------------------------------------------
// Room treasuries
// ---------------------------------------------------------------------------

function mapTreasury(row: typeof roomTreasuries.$inferSelect): TreasuryRecord {
  const limits = row.depositLimits as {
    perUserPerPeriod: string;
    perRoomPerPeriod: string;
    perDepositMax: string;
    periodSeconds: number;
  };
  return {
    treasuryId: row.treasuryId,
    roomId: row.roomId,
    deploymentId: row.deploymentId,
    treasuryAddress: row.treasuryAddress,
    acceptedAssets: row.acceptedAssets as string[],
    balanceSnapshot: (row.balanceSnapshot as Record<string, string> | null) ?? null,
    balancesReconciledAt: isoOrNull(row.balancesReconciledAt),
    depositLimits: limits,
    freezeState: row.freezeState,
    freezeReason: row.freezeReason,
    freezeCascade: row.freezeCascade,
    pauseFlags: row.pauseFlags as PauseFlags,
    reconciliationState: row.reconciliationState,
    createdAt: iso(row.createdAt),
  };
}

export class DrizzleTreasuryStore implements TreasuryStore {
  constructor(private readonly db: Db) {}

  async getById(treasuryId: string): Promise<TreasuryRecord | null> {
    const rows = await this.db
      .select()
      .from(roomTreasuries)
      .where(eq(roomTreasuries.treasuryId, treasuryId))
      .limit(1);
    return rows[0] ? mapTreasury(rows[0]) : null;
  }

  async getByRoom(roomId: string): Promise<TreasuryRecord | null> {
    const rows = await this.db
      .select()
      .from(roomTreasuries)
      .where(eq(roomTreasuries.roomId, roomId))
      .limit(1);
    return rows[0] ? mapTreasury(rows[0]) : null;
  }

  async insert(record: TreasuryRecord): Promise<TreasuryRecord | null> {
    try {
      await this.db.insert(roomTreasuries).values({
        treasuryId: record.treasuryId,
        roomId: record.roomId,
        deploymentId: record.deploymentId,
        treasuryAddress: record.treasuryAddress,
        acceptedAssets: record.acceptedAssets,
        balanceSnapshot: record.balanceSnapshot,
        balancesReconciledAt: dateOrNull(record.balancesReconciledAt),
        depositLimits: record.depositLimits,
        freezeState: record.freezeState,
        freezeReason: record.freezeReason,
        freezeCascade: record.freezeCascade,
        pauseFlags: record.pauseFlags,
        reconciliationState: record.reconciliationState,
        createdAt: new Date(record.createdAt),
      });
      return record;
    } catch (error) {
      if (isUniqueViolation(error)) return null; // room or address collision
      throw error;
    }
  }

  async setFreeze(
    treasuryId: string,
    state: 'active' | 'frozen',
    reason: string | null,
    cascaded: boolean,
  ): Promise<boolean> {
    const rows = await this.db
      .update(roomTreasuries)
      .set({
        freezeState: state,
        freezeReason: reason,
        freezeCascade: state === 'frozen' ? cascaded : false,
      })
      .where(eq(roomTreasuries.treasuryId, treasuryId))
      .returning({ treasuryId: roomTreasuries.treasuryId });
    return rows.length > 0;
  }

  async setPauseFlags(treasuryId: string, flags: PauseFlags): Promise<boolean> {
    const rows = await this.db
      .update(roomTreasuries)
      .set({ pauseFlags: flags })
      .where(eq(roomTreasuries.treasuryId, treasuryId))
      .returning({ treasuryId: roomTreasuries.treasuryId });
    return rows.length > 0;
  }

  async setReconciliation(
    treasuryId: string,
    state: TreasuryRecord['reconciliationState'],
    balanceSnapshot: Record<string, string> | null,
    reconciledAt: string | null,
  ): Promise<boolean> {
    const rows = await this.db
      .update(roomTreasuries)
      .set({
        reconciliationState: state,
        ...(balanceSnapshot !== null
          ? { balanceSnapshot, balancesReconciledAt: dateOrNull(reconciledAt) }
          : {}),
      })
      .where(eq(roomTreasuries.treasuryId, treasuryId))
      .returning({ treasuryId: roomTreasuries.treasuryId });
    return rows.length > 0;
  }

  async listAll(): Promise<TreasuryRecord[]> {
    const rows = await this.db.select().from(roomTreasuries);
    return rows.map(mapTreasury);
  }

  async clear(): Promise<void> {
    await this.db.delete(roomTreasuries);
  }
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

function mapReservation(row: typeof treasuryReservations.$inferSelect): ReservationRecord {
  return {
    reservationId: row.reservationId,
    treasuryId: row.treasuryId,
    proposalId: row.proposalId,
    category: row.category,
    asset: row.asset,
    amount: row.amount,
    state: row.state,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleReservationStore implements ReservationStore {
  constructor(private readonly db: Db) {}

  async getByProposal(proposalId: string): Promise<ReservationRecord | null> {
    const rows = await this.db
      .select()
      .from(treasuryReservations)
      .where(eq(treasuryReservations.proposalId, proposalId))
      .limit(1);
    return rows[0] ? mapReservation(rows[0]) : null;
  }

  async insert(record: ReservationRecord): Promise<ReservationRecord | null> {
    try {
      await this.db.insert(treasuryReservations).values({
        reservationId: record.reservationId,
        treasuryId: record.treasuryId,
        proposalId: record.proposalId,
        category: record.category,
        asset: record.asset,
        amount: record.amount,
        state: record.state,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      });
      return record;
    } catch (error) {
      if (isUniqueViolation(error)) return null; // one per proposal
      throw error;
    }
  }

  async transition(
    reservationId: string,
    from: ReservationState,
    to: ReservationState,
    updatedAt: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(treasuryReservations)
      .set({ state: to, updatedAt: new Date(updatedAt) })
      .where(
        and(
          eq(treasuryReservations.reservationId, reservationId),
          eq(treasuryReservations.state, from),
        ),
      )
      .returning({ reservationId: treasuryReservations.reservationId });
    return rows.length > 0;
  }

  async listActiveByTreasury(treasuryId: string, category: string): Promise<ReservationRecord[]> {
    const rows = await this.db
      .select()
      .from(treasuryReservations)
      .where(
        and(
          eq(treasuryReservations.treasuryId, treasuryId),
          eq(treasuryReservations.category, category),
          eq(treasuryReservations.state, 'reserved'),
        ),
      );
    return rows.map(mapReservation);
  }

  async listActiveByTreasuryAsset(treasuryId: string, asset: string): Promise<ReservationRecord[]> {
    const rows = await this.db
      .select()
      .from(treasuryReservations)
      .where(
        and(
          eq(treasuryReservations.treasuryId, treasuryId),
          eq(treasuryReservations.asset, asset),
          eq(treasuryReservations.state, 'reserved'),
        ),
      );
    return rows.map(mapReservation);
  }

  async listConsumedByTreasury(treasuryId: string, category: string): Promise<ReservationRecord[]> {
    const rows = await this.db
      .select()
      .from(treasuryReservations)
      .where(
        and(
          eq(treasuryReservations.treasuryId, treasuryId),
          eq(treasuryReservations.category, category),
          eq(treasuryReservations.state, 'consumed'),
        ),
      );
    return rows.map(mapReservation);
  }

  async clear(): Promise<void> {
    await this.db.delete(treasuryReservations);
  }
}

// ---------------------------------------------------------------------------
// Payment intents
// ---------------------------------------------------------------------------

function mapIntent(row: typeof paymentIntents.$inferSelect): PaymentIntentRecord {
  return {
    paymentIntentId: row.paymentIntentId,
    userId: row.userId,
    roomId: row.roomId,
    treasuryId: row.treasuryId,
    targetType: row.targetType,
    targetId: row.targetId,
    asset: row.asset,
    amount: row.amount,
    jurisdictionState: row.jurisdictionState,
    complianceState: row.complianceState,
    executionState: row.executionState,
    retryCount: row.retryCount,
    quoteRef: (row.quoteRef as Record<string, unknown> | null) ?? null,
    actionRecordId: row.actionRecordId,
    receiptId: row.receiptId,
    idempotencyKey: row.idempotencyKey,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzlePaymentIntentStore implements PaymentIntentStore {
  constructor(private readonly db: Db) {}

  async getById(paymentIntentId: string): Promise<PaymentIntentRecord | null> {
    const rows = await this.db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.paymentIntentId, paymentIntentId))
      .limit(1);
    return rows[0] ? mapIntent(rows[0]) : null;
  }

  async findByIdempotencyKey(
    userId: string | null,
    roomId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntentRecord | null> {
    const rows = await this.db
      .select()
      .from(paymentIntents)
      .where(
        and(
          userId === null
            ? and(
                isNull(paymentIntents.userId),
                // The room-owned scope covers the PAYOUT classes only (0086):
                // an ERASED member deposit also carries a null user.
                inArray(paymentIntents.targetType, ['grant_payout', 'steward_compensation']),
              )
            : eq(paymentIntents.userId, userId),
          eq(paymentIntents.roomId, roomId),
          eq(paymentIntents.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? mapIntent(rows[0]) : null;
  }

  async findByActionRecordId(actionRecordId: string): Promise<PaymentIntentRecord | null> {
    const rows = await this.db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.actionRecordId, actionRecordId))
      .limit(1);
    return rows[0] ? mapIntent(rows[0]) : null;
  }

  async insert(record: PaymentIntentRecord): Promise<PaymentIntentRecord> {
    try {
      await this.db.insert(paymentIntents).values({
        paymentIntentId: record.paymentIntentId,
        userId: record.userId,
        roomId: record.roomId,
        treasuryId: record.treasuryId,
        targetType: record.targetType,
        targetId: record.targetId,
        asset: record.asset,
        amount: record.amount,
        jurisdictionState: record.jurisdictionState,
        complianceState: record.complianceState,
        executionState: record.executionState,
        retryCount: record.retryCount,
        quoteRef: record.quoteRef,
        actionRecordId: record.actionRecordId,
        receiptId: record.receiptId,
        idempotencyKey: record.idempotencyKey,
        expiresAt: new Date(record.expiresAt),
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      });
      return record;
    } catch (error) {
      // Both idempotency scopes collide here: (user, room, key) via the
      // member unique index, (room, key) via the room-owned partial index
      // (migration 0083) — either way the EXISTING row is the answer.
      if (isUniqueViolation(error)) {
        const existing = await this.findByIdempotencyKey(
          record.userId,
          record.roomId,
          record.idempotencyKey,
        );
        if (existing !== null) return existing;
      }
      throw error;
    }
  }

  async transition(
    paymentIntentId: string,
    from: PaymentIntentState,
    to: PaymentIntentState,
    patch: Parameters<PaymentIntentStore['transition']>[3],
    updatedAt: string,
  ): Promise<PaymentIntentRecord | null> {
    const rows = await this.db
      .update(paymentIntents)
      .set({
        executionState: to,
        updatedAt: new Date(updatedAt),
        ...(patch.jurisdictionState !== undefined
          ? { jurisdictionState: patch.jurisdictionState }
          : {}),
        ...(patch.complianceState !== undefined ? { complianceState: patch.complianceState } : {}),
        ...(patch.retryCount !== undefined ? { retryCount: patch.retryCount } : {}),
        ...(patch.quoteRef !== undefined ? { quoteRef: patch.quoteRef } : {}),
        ...(patch.actionRecordId !== undefined ? { actionRecordId: patch.actionRecordId } : {}),
        ...(patch.receiptId !== undefined ? { receiptId: patch.receiptId } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt: new Date(patch.expiresAt) } : {}),
      })
      .where(
        and(
          eq(paymentIntents.paymentIntentId, paymentIntentId),
          eq(paymentIntents.executionState, from),
        ),
      )
      .returning();
    return rows[0] ? mapIntent(rows[0]) : null;
  }

  async listByRoom(roomId: string, limit: number): Promise<PaymentIntentRecord[]> {
    const rows = await this.db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.roomId, roomId))
      .orderBy(desc(paymentIntents.createdAt))
      .limit(limit);
    return rows.map(mapIntent);
  }

  async listByTreasuryPage(
    treasuryId: string,
    afterId: string | null,
    limit: number,
  ): Promise<PaymentIntentRecord[]> {
    const rows = await this.db
      .select()
      .from(paymentIntents)
      .where(
        afterId === null
          ? eq(paymentIntents.treasuryId, treasuryId)
          : and(
              eq(paymentIntents.treasuryId, treasuryId),
              gt(paymentIntents.paymentIntentId, afterId),
            ),
      )
      .orderBy(asc(paymentIntents.paymentIntentId))
      .limit(limit);
    return rows.map(mapIntent);
  }

  async listDepositsInPeriod(roomId: string, sinceIso: string): Promise<PaymentIntentRecord[]> {
    const rows = await this.db
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.roomId, roomId),
          inArray(paymentIntents.targetType, ['treasury_deposit', 'bounty_contribution']),
          gte(paymentIntents.createdAt, new Date(sinceIso)),
        ),
      );
    return rows.map(mapIntent);
  }

  async listExpired(nowIso: string, limit: number): Promise<PaymentIntentRecord[]> {
    const rows = await this.db
      .select()
      .from(paymentIntents)
      .where(
        and(
          inArray(paymentIntents.executionState, ['created', 'preflighted', 'quoted', 'signed']),
          lte(paymentIntents.expiresAt, new Date(nowIso)),
        ),
      )
      .limit(limit);
    return rows.map(mapIntent);
  }

  async listByStates(
    states: readonly PaymentIntentState[],
    limit: number,
    afterId: string | null = null,
  ): Promise<PaymentIntentRecord[]> {
    const rows = await this.db
      .select()
      .from(paymentIntents)
      .where(
        and(
          inArray(paymentIntents.executionState, [...states]),
          afterId === null ? undefined : gt(paymentIntents.paymentIntentId, afterId),
        ),
      )
      .orderBy(asc(paymentIntents.paymentIntentId))
      .limit(limit);
    return rows.map(mapIntent);
  }

  async clear(): Promise<void> {
    await this.db.delete(paymentIntents);
  }
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

function mapGrant(row: typeof treasuryGrants.$inferSelect): GrantRecord {
  return {
    grantId: row.grantId,
    roomId: row.roomId,
    treasuryId: row.treasuryId,
    proposalId: row.proposalId,
    recipientRef: row.recipientRef,
    purpose: row.purpose,
    amount: row.amount,
    asset: row.asset,
    milestones: row.milestones as GrantRecord['milestones'],
    milestoneState: row.milestoneState,
    reviewState: row.reviewState,
    payoutState: row.payoutState,
    auditSummary: row.auditSummary,
    createdAt: iso(row.createdAt),
  };
}

export class DrizzleGrantStore implements GrantStore {
  constructor(private readonly db: Db) {}

  async getById(grantId: string): Promise<GrantRecord | null> {
    const rows = await this.db
      .select()
      .from(treasuryGrants)
      .where(eq(treasuryGrants.grantId, grantId))
      .limit(1);
    return rows[0] ? mapGrant(rows[0]) : null;
  }

  async getByProposal(proposalId: string): Promise<GrantRecord | null> {
    const rows = await this.db
      .select()
      .from(treasuryGrants)
      .where(eq(treasuryGrants.proposalId, proposalId))
      .limit(1);
    return rows[0] ? mapGrant(rows[0]) : null;
  }

  async insert(record: GrantRecord): Promise<GrantRecord | null> {
    try {
      await this.db.insert(treasuryGrants).values({
        grantId: record.grantId,
        roomId: record.roomId,
        treasuryId: record.treasuryId,
        proposalId: record.proposalId,
        recipientRef: record.recipientRef,
        purpose: record.purpose,
        amount: record.amount,
        asset: record.asset,
        milestones: record.milestones,
        milestoneState: record.milestoneState,
        reviewState: record.reviewState,
        payoutState: record.payoutState,
        auditSummary: record.auditSummary,
        createdAt: new Date(record.createdAt),
      });
      return record;
    } catch (error) {
      if (isUniqueViolation(error)) return null; // one per proposal
      throw error;
    }
  }

  async update(record: GrantRecord): Promise<GrantRecord | null> {
    const rows = await this.db
      .update(treasuryGrants)
      .set({
        milestones: record.milestones,
        milestoneState: record.milestoneState,
        reviewState: record.reviewState,
        payoutState: record.payoutState,
        auditSummary: record.auditSummary,
      })
      .where(eq(treasuryGrants.grantId, record.grantId))
      .returning();
    return rows[0] ? mapGrant(rows[0]) : null;
  }

  async applyMilestoneTransition(
    grantId: string,
    milestoneId: string,
    fromState: GrantMilestoneRecord['state'],
    toState: GrantMilestoneRecord['state'],
    paymentIntentId: string | null,
  ): Promise<GrantRecord | null> {
    // Row-locked read-modify-write: the transaction serializes concurrent
    // milestone updates so neither snapshot can clobber the other's tranche.
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(treasuryGrants)
        .where(eq(treasuryGrants.grantId, grantId))
        .for('update')
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      const grant = mapGrant(row);
      const milestone = grant.milestones.find((m) => m.milestoneId === milestoneId);
      if (milestone === undefined || milestone.state !== fromState) return null;
      milestone.state = toState;
      if (paymentIntentId !== null) milestone.paymentIntentId = paymentIntentId;
      const aggregates = projectGrantAggregates(grant.milestones, grant.payoutState);
      const updated = await tx
        .update(treasuryGrants)
        .set({
          milestones: grant.milestones,
          milestoneState: aggregates.milestoneState,
          payoutState: aggregates.payoutState,
        })
        .where(eq(treasuryGrants.grantId, grantId))
        .returning();
      return updated[0] ? mapGrant(updated[0]) : null;
    });
  }

  async listUnsettledByTreasury(
    treasuryId: string,
    limit: number,
    afterId: string | null = null,
  ): Promise<GrantRecord[]> {
    const rows = await this.db
      .select()
      .from(treasuryGrants)
      .where(
        and(
          eq(treasuryGrants.treasuryId, treasuryId),
          notInArray(treasuryGrants.payoutState, ['paid', 'clawed_back']),
          afterId === null ? undefined : gt(treasuryGrants.grantId, afterId),
        ),
      )
      .orderBy(asc(treasuryGrants.grantId))
      .limit(limit);
    return rows.map(mapGrant);
  }

  async listByRoom(roomId: string, limit: number): Promise<GrantRecord[]> {
    const rows = await this.db
      .select()
      .from(treasuryGrants)
      .where(eq(treasuryGrants.roomId, roomId))
      .orderBy(desc(treasuryGrants.createdAt))
      .limit(limit);
    return rows.map(mapGrant);
  }

  async clear(): Promise<void> {
    await this.db.delete(treasuryGrants);
  }
}

// ---------------------------------------------------------------------------
// Action budgets (optimistic concurrency via updated_at expectation)
// ---------------------------------------------------------------------------

function mapBudget(row: typeof actionBudgets.$inferSelect): ActionBudgetRecord {
  return {
    budgetId: row.budgetId,
    roomId: row.roomId,
    actorKey: row.actorKey,
    availableUnits: row.availableUnits,
    lastRefillAt: iso(row.lastRefillAt),
    rateLimitState: (row.rateLimitState as Record<string, unknown> | null) ?? null,
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleActionBudgetStore implements ActionBudgetStore {
  constructor(private readonly db: Db) {}

  async get(roomId: string, actorKey: string): Promise<ActionBudgetRecord | null> {
    const rows = await this.db
      .select()
      .from(actionBudgets)
      .where(and(eq(actionBudgets.roomId, roomId), eq(actionBudgets.actorKey, actorKey)))
      .limit(1);
    return rows[0] ? mapBudget(rows[0]) : null;
  }

  async put(
    record: ActionBudgetRecord,
    expectedUpdatedAt: string | null,
  ): Promise<ActionBudgetRecord | null> {
    if (expectedUpdatedAt === null) {
      try {
        await this.db.insert(actionBudgets).values({
          budgetId: record.budgetId,
          roomId: record.roomId,
          actorKey: record.actorKey,
          availableUnits: record.availableUnits,
          lastRefillAt: new Date(record.lastRefillAt),
          rateLimitState: record.rateLimitState,
          updatedAt: new Date(record.updatedAt),
        });
        return record;
      } catch (error) {
        if (isUniqueViolation(error)) return null; // insert-only collision
        throw error;
      }
    }
    const rows = await this.db
      .update(actionBudgets)
      .set({
        availableUnits: record.availableUnits,
        lastRefillAt: new Date(record.lastRefillAt),
        rateLimitState: record.rateLimitState,
        updatedAt: new Date(record.updatedAt),
      })
      .where(
        and(
          eq(actionBudgets.roomId, record.roomId),
          eq(actionBudgets.actorKey, record.actorKey),
          eq(actionBudgets.updatedAt, new Date(expectedUpdatedAt)),
        ),
      )
      .returning({ budgetId: actionBudgets.budgetId });
    return rows.length > 0 ? record : null;
  }

  async clear(): Promise<void> {
    await this.db.delete(actionBudgets);
  }
}

// ---------------------------------------------------------------------------
// Delegations
// ---------------------------------------------------------------------------

function mapDelegation(row: typeof delegationRecords.$inferSelect): DelegationRecordEntity {
  return {
    delegationId: row.delegationId,
    roomId: row.roomId,
    delegatorUserId: row.delegatorUserId,
    delegateUserId: row.delegateUserId,
    scope: row.scope as DelegationRecordEntity['scope'],
    scopeKey: row.scopeKey,
    state: row.state,
    createdAt: iso(row.createdAt),
    revokedAt: isoOrNull(row.revokedAt),
  };
}

export class DrizzleDelegationStore implements DelegationStore {
  constructor(private readonly db: Db) {}

  async getById(delegationId: string): Promise<DelegationRecordEntity | null> {
    const rows = await this.db
      .select()
      .from(delegationRecords)
      .where(eq(delegationRecords.delegationId, delegationId))
      .limit(1);
    return rows[0] ? mapDelegation(rows[0]) : null;
  }

  async insert(record: DelegationRecordEntity): Promise<DelegationRecordEntity | null> {
    try {
      await this.db.insert(delegationRecords).values({
        delegationId: record.delegationId,
        roomId: record.roomId,
        delegatorUserId: record.delegatorUserId,
        delegateUserId: record.delegateUserId,
        scope: record.scope,
        scopeKey: record.scopeKey,
        state: record.state,
        createdAt: new Date(record.createdAt),
        revokedAt: dateOrNull(record.revokedAt),
      });
      return record;
    } catch (error) {
      if (isUniqueViolation(error)) return null; // one active per scope
      throw error;
    }
  }

  async revoke(delegationId: string, revokedAt: string): Promise<DelegationRecordEntity | null> {
    const rows = await this.db
      .update(delegationRecords)
      .set({ state: 'revoked', revokedAt: new Date(revokedAt) })
      .where(
        and(
          eq(delegationRecords.delegationId, delegationId),
          eq(delegationRecords.state, 'active'),
        ),
      )
      .returning();
    return rows[0] ? mapDelegation(rows[0]) : null;
  }

  async listActiveByDelegate(
    roomId: string,
    delegateUserId: string,
  ): Promise<DelegationRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(delegationRecords)
      .where(
        and(
          eq(delegationRecords.roomId, roomId),
          eq(delegationRecords.delegateUserId, delegateUserId),
          eq(delegationRecords.state, 'active'),
        ),
      );
    return rows.map(mapDelegation);
  }

  async listActiveByDelegator(
    roomId: string,
    delegatorUserId: string,
  ): Promise<DelegationRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(delegationRecords)
      .where(
        and(
          eq(delegationRecords.roomId, roomId),
          eq(delegationRecords.delegatorUserId, delegatorUserId),
          eq(delegationRecords.state, 'active'),
        ),
      );
    return rows.map(mapDelegation);
  }

  async listByRoom(roomId: string, limit: number): Promise<DelegationRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(delegationRecords)
      .where(eq(delegationRecords.roomId, roomId))
      .orderBy(desc(delegationRecords.createdAt))
      .limit(limit);
    return rows.map(mapDelegation);
  }

  async clear(): Promise<void> {
    await this.db.delete(delegationRecords);
  }
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

function mapChallenge(row: typeof governanceChallenges.$inferSelect): ChallengeRecord {
  return {
    challengeId: row.challengeId,
    proposalId: row.proposalId,
    challengerUserId: row.challengerUserId,
    challengeType: row.challengeType,
    description: row.description,
    evidenceRefs: row.evidenceRefs as string[],
    state: row.state,
    resolutionNote: row.resolutionNote,
    resolvedByUserId: row.resolvedByUserId,
    createdAt: iso(row.createdAt),
    resolvedAt: isoOrNull(row.resolvedAt),
  };
}

export class DrizzleChallengeStore implements ChallengeStore {
  constructor(private readonly db: Db) {}

  async getById(challengeId: string): Promise<ChallengeRecord | null> {
    const rows = await this.db
      .select()
      .from(governanceChallenges)
      .where(eq(governanceChallenges.challengeId, challengeId))
      .limit(1);
    return rows[0] ? mapChallenge(rows[0]) : null;
  }

  async insert(record: ChallengeRecord): Promise<ChallengeRecord> {
    await this.db.insert(governanceChallenges).values({
      challengeId: record.challengeId,
      proposalId: record.proposalId,
      challengerUserId: record.challengerUserId,
      challengeType: record.challengeType,
      description: record.description,
      evidenceRefs: record.evidenceRefs,
      state: record.state,
      resolutionNote: record.resolutionNote,
      resolvedByUserId: record.resolvedByUserId,
      createdAt: new Date(record.createdAt),
      resolvedAt: dateOrNull(record.resolvedAt),
    });
    return record;
  }

  async transition(
    challengeId: string,
    from: ChallengeRecord['state'],
    to: ChallengeRecord['state'],
    resolution: { note: string | null; resolvedByUserId: string | null; resolvedAt: string },
  ): Promise<ChallengeRecord | null> {
    const rows = await this.db
      .update(governanceChallenges)
      .set({
        state: to,
        resolutionNote: resolution.note,
        resolvedByUserId: resolution.resolvedByUserId,
        resolvedAt: to === 'escalated' ? null : new Date(resolution.resolvedAt),
      })
      .where(
        and(
          eq(governanceChallenges.challengeId, challengeId),
          eq(governanceChallenges.state, from),
        ),
      )
      .returning();
    return rows[0] ? mapChallenge(rows[0]) : null;
  }

  async listByProposal(proposalId: string): Promise<ChallengeRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceChallenges)
      .where(eq(governanceChallenges.proposalId, proposalId))
      .orderBy(governanceChallenges.createdAt);
    return rows.map(mapChallenge);
  }

  async countOpenByProposal(proposalId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(governanceChallenges)
      .where(
        and(
          eq(governanceChallenges.proposalId, proposalId),
          inArray(governanceChallenges.state, ['open', 'escalated']),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.db.delete(governanceChallenges);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation snapshots (append-only) + attestations
// ---------------------------------------------------------------------------

function mapSnapshot(row: typeof treasuryReconciliationSnapshots.$inferSelect): SnapshotRecord {
  return {
    snapshotId: row.snapshotId,
    treasuryId: row.treasuryId,
    asset: row.asset,
    productLedgerBalance: row.productLedgerBalance,
    receiptsBalance: row.receiptsBalance,
    onchainObservedBalance: row.onchainObservedBalance,
    gap: row.gap,
    explanation: (row.explanation as Record<string, unknown> | null) ?? null,
    result: row.result,
    observedAt: iso(row.observedAt),
  };
}

export class DrizzleSnapshotStore implements SnapshotStore {
  constructor(private readonly db: Db) {}

  async append(record: SnapshotRecord): Promise<SnapshotRecord> {
    await this.db.insert(treasuryReconciliationSnapshots).values({
      snapshotId: record.snapshotId,
      treasuryId: record.treasuryId,
      asset: record.asset,
      productLedgerBalance: record.productLedgerBalance,
      receiptsBalance: record.receiptsBalance,
      onchainObservedBalance: record.onchainObservedBalance,
      gap: record.gap,
      explanation: record.explanation,
      result: record.result,
      observedAt: new Date(record.observedAt),
    });
    return record;
  }

  async latestByTreasuryAsset(treasuryId: string, asset: string): Promise<SnapshotRecord | null> {
    const rows = await this.db
      .select()
      .from(treasuryReconciliationSnapshots)
      .where(
        and(
          eq(treasuryReconciliationSnapshots.treasuryId, treasuryId),
          eq(treasuryReconciliationSnapshots.asset, asset),
        ),
      )
      .orderBy(desc(treasuryReconciliationSnapshots.observedAt))
      .limit(1);
    return rows[0] ? mapSnapshot(rows[0]) : null;
  }

  async listByTreasury(treasuryId: string, limit: number): Promise<SnapshotRecord[]> {
    const rows = await this.db
      .select()
      .from(treasuryReconciliationSnapshots)
      .where(eq(treasuryReconciliationSnapshots.treasuryId, treasuryId))
      .orderBy(desc(treasuryReconciliationSnapshots.observedAt))
      .limit(limit);
    return rows.map(mapSnapshot);
  }

  /** Test/dev reset ONLY (interface parity with the in-memory store).  The
   *  append-only trigger rejects row DELETEs, so the sole reset path is
   *  TRUNCATE (which does not fire row-level triggers). */
  async clear(): Promise<void> {
    await this.db.execute(sql`truncate table ${treasuryReconciliationSnapshots}`);
  }
}

export class DrizzleAttestationStore implements AttestationStore {
  constructor(private readonly db: Db) {}

  async get(roomId: string, item: AttestationRecord['item']): Promise<AttestationRecord | null> {
    const rows = await this.db
      .select()
      .from(roomReadinessAttestations)
      .where(
        and(eq(roomReadinessAttestations.roomId, roomId), eq(roomReadinessAttestations.item, item)),
      )
      .limit(1);
    const row = rows[0];
    return row
      ? {
          roomId: row.roomId,
          item: row.item as AttestationRecord['item'],
          attestedByUserId: row.attestedByUserId,
          note: row.note,
          createdAt: iso(row.createdAt),
        }
      : null;
  }

  async upsert(record: AttestationRecord): Promise<AttestationRecord> {
    await this.db
      .insert(roomReadinessAttestations)
      .values({
        roomId: record.roomId,
        item: record.item,
        attestedByUserId: record.attestedByUserId,
        note: record.note,
        createdAt: new Date(record.createdAt),
      })
      .onConflictDoUpdate({
        target: [roomReadinessAttestations.roomId, roomReadinessAttestations.item],
        set: {
          attestedByUserId: record.attestedByUserId,
          note: record.note,
          createdAt: new Date(record.createdAt),
        },
      });
    return record;
  }

  async clear(): Promise<void> {
    await this.db.delete(roomReadinessAttestations);
  }
}

/** Build every WS-M Postgres adapter over one client (the production boot). */
export function createDrizzleTreasuryStores(db: Db) {
  return {
    profiles: new DrizzleGovernanceProfileStore(db),
    charters: new DrizzleCharterStore(db),
    treasuries: new DrizzleTreasuryStore(db),
    reservations: new DrizzleReservationStore(db),
    intents: new DrizzlePaymentIntentStore(db),
    grants: new DrizzleGrantStore(db),
    budgets: new DrizzleActionBudgetStore(db),
    delegations: new DrizzleDelegationStore(db),
    challenges: new DrizzleChallengeStore(db),
    snapshots: new DrizzleSnapshotStore(db),
    attestations: new DrizzleAttestationStore(db),
  };
}
