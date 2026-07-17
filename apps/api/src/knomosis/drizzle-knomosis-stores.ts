// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L gated Postgres adapters — the SAME interfaces as `stores.ts`, bound to
// the isolated `wallet`/`knomosis` schemas (migration 0059).  Swapped in at
// boot when DATABASE_URL is configured.  Address hashes cross the boundary as
// hex strings and persist as bytea; monetary amounts and gateway cursors are
// decimal strings end-to-end (numeric(78,0)/bigint — never a JS double).

import {
  comprehensionResults,
  type createDbClient,
  governanceAuditLogs,
  governanceProposals,
  governanceProposalVotes,
  governanceSignatures,
  knomosisActionNonces,
  knomosisActionRecords,
  knomosisDeployments,
  knomosisGatewayCursor,
  knomosisReceipts,
  onChainEvents,
  reconciliationResults,
  simTreasuries,
  simTreasuryEntries,
  walletAccounts,
  walletActorMappings,
} from '@licio/db';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { isUniqueViolation } from '../lib/pg-errors.js';
import type { ActionNonceStore } from './services.js';
import type {
  AuditLogCursor,
  ComprehensionResultRecord,
  ComprehensionStore,
  FinancialWalletRecord,
  FinancialWalletStore,
  GovernanceAuditRecord,
  GovernanceAuditStore,
  GovernanceProposalRecord,
  GovernanceProposalStore,
  GovernanceSignatureRecord,
  GovernanceSignatureStore,
  KnomosisActionRecordEntity,
  KnomosisActionStore,
  KnomosisDeploymentRecord,
  KnomosisDeploymentStore,
  KnomosisReceiptRecord,
  KnomosisReceiptStore,
  OnChainEventRecord,
  OnChainEventStore,
  ProposalVoteRecord,
  ProposalVoteStore,
  ReconciliationResultRecord,
  ReconciliationStore,
  SimTreasuryEntryRecord,
  SimTreasuryRecord,
  SimTreasuryStore,
  WalletActorMappingRecord,
  WalletActorMappingStore,
} from './stores.js';
import {
  DEAD_ACTION_STATES,
  READINESS_QUALIFYING_AUDIT_ACTIONS,
  selectGatewayBoundAction,
  TERMINAL_SUBMISSION_STATES,
} from './stores.js';

type Db = ReturnType<typeof createDbClient>;

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const dateOrNull = (s: string | null): Date | null => (s === null ? null : new Date(s));

// ---------------------------------------------------------------------------
// Wallets (wallet.wallet_accounts)
// ---------------------------------------------------------------------------

function mapWallet(row: typeof walletAccounts.$inferSelect): FinancialWalletRecord {
  return {
    walletAccountId: row.walletAccountId,
    userId: row.userId,
    addressHashHex: row.addressHash.toString('hex'),
    addressTruncated: row.addressTruncated,
    chainId: row.chainId,
    walletType: row.walletType,
    unlinkState: row.unlinkState,
    riskState: row.riskState,
    label: row.label,
    linkedAt: iso(row.linkedAt),
    lastUsedAt: isoOrNull(row.lastUsedAt),
    unlinkRequestedAt: isoOrNull(row.unlinkRequestedAt),
    unlinkFinalizeAfter: isoOrNull(row.unlinkFinalizeAfter),
    unlinkedAt: isoOrNull(row.unlinkedAt),
  };
}

export class DrizzleFinancialWalletStore implements FinancialWalletStore {
  constructor(private readonly db: Db) {}

  #insertValues(record: FinancialWalletRecord) {
    return {
      walletAccountId: record.walletAccountId,
      userId: record.userId,
      addressHash: Buffer.from(record.addressHashHex, 'hex'),
      addressTruncated: record.addressTruncated,
      chainId: record.chainId,
      walletType: record.walletType,
      unlinkState: record.unlinkState,
      riskState: record.riskState,
      label: record.label,
      linkedAt: new Date(record.linkedAt),
      lastUsedAt: dateOrNull(record.lastUsedAt),
      unlinkRequestedAt: dateOrNull(record.unlinkRequestedAt),
      unlinkFinalizeAfter: dateOrNull(record.unlinkFinalizeAfter),
      unlinkedAt: dateOrNull(record.unlinkedAt),
    };
  }

  async insert(record: FinancialWalletRecord): Promise<FinancialWalletRecord> {
    await this.db.insert(walletAccounts).values(this.#insertValues(record));
    return record;
  }

  async insertIfUnderCap(
    record: FinancialWalletRecord,
    maxActive: number,
  ): Promise<
    { wallet: FinancialWalletRecord; created: boolean } | 'cap_exceeded' | 'address_taken'
  > {
    return this.db.transaction(async (tx) => {
      // ADDRESS-level advisory lock (namespace 2080): the DB unique index is
      // per-`(address_hash, chain_id)`, so it does NOT stop two DIFFERENT accounts
      // linking the SAME address on DIFFERENT chains concurrently.  Serialize on the
      // address so the cross-user ownership check + insert are atomic — one address
      // maps to ONE account across every chain (WS-L.2.5a).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${record.addressHashHex}), 2080)`);
      const addressBytes = Buffer.from(record.addressHashHex, 'hex');
      // Cross-user gate: another account owns this address ONLY while it has a LIVE
      // (non-finalized) row.  A finalized tombstone is a released address, so exclude
      // it — a new key-proving owner may link the released address (WS-L.2.5a).
      const owner = await tx
        .select({ userId: walletAccounts.userId })
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.addressHash, addressBytes),
            ne(walletAccounts.unlinkState, 'finalized'),
          ),
        )
        .limit(1);
      if (owner[0] !== undefined && owner[0].userId !== record.userId) {
        return 'address_taken' as const;
      }
      // IDEMPOTENT relink: re-read the caller's OWN live `(address, chain)` row UNDER
      // the lock.  A concurrent same-user link may have committed it after the outer
      // pre-check saw none; return it instead of hitting the partial unique constraint
      // or miscounting it toward the cap.  Scoped to this user + non-finalized so a
      // DIFFERENT account's released tombstone is never returned (WS-L.2.5a).
      const existing = await tx
        .select()
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.addressHash, addressBytes),
            eq(walletAccounts.chainId, record.chainId),
            eq(walletAccounts.userId, record.userId),
            ne(walletAccounts.unlinkState, 'finalized'),
          ),
        )
        .limit(1);
      if (existing[0] !== undefined) {
        return { wallet: mapWallet(existing[0]), created: false };
      }
      // A per-user transaction-scoped advisory lock SERIALIZES concurrent links
      // for this user, so the active-count check and the insert are atomic across
      // pods — the DB otherwise enforces only address uniqueness, not the cap
      // (WS-L.2.5a).  Namespaced by a constant second key so it cannot collide
      // with other advisory locks.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${record.userId}), 2079)`);
      const counted = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.userId, record.userId),
            ne(walletAccounts.unlinkState, 'finalized'),
          ),
        );
      if ((counted[0]?.n ?? 0) >= maxActive) return 'cap_exceeded' as const;
      await tx.insert(walletAccounts).values(this.#insertValues(record));
      return { wallet: record, created: true };
    });
  }

  async getById(walletAccountId: string): Promise<FinancialWalletRecord | null> {
    const rows = await this.db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.walletAccountId, walletAccountId))
      .limit(1);
    return rows[0] ? mapWallet(rows[0]) : null;
  }

  async getByAddressHash(addressHashHex: string): Promise<FinancialWalletRecord | null> {
    const rows = await this.db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.addressHash, Buffer.from(addressHashHex, 'hex')))
      .limit(1);
    return rows[0] ? mapWallet(rows[0]) : null;
  }

  async getActiveOwnerByAddressHash(addressHashHex: string): Promise<FinancialWalletRecord | null> {
    const rows = await this.db
      .select()
      .from(walletAccounts)
      .where(
        and(
          eq(walletAccounts.addressHash, Buffer.from(addressHashHex, 'hex')),
          ne(walletAccounts.unlinkState, 'finalized'),
        ),
      )
      .limit(1);
    return rows[0] ? mapWallet(rows[0]) : null;
  }

  async getByAddressHashAndChain(
    addressHashHex: string,
    chainId: number,
    userId: string,
  ): Promise<FinancialWalletRecord | null> {
    const rows = await this.db
      .select()
      .from(walletAccounts)
      .where(
        and(
          eq(walletAccounts.addressHash, Buffer.from(addressHashHex, 'hex')),
          eq(walletAccounts.chainId, chainId),
          eq(walletAccounts.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ? mapWallet(rows[0]) : null;
  }

  async listByUser(userId: string, includeUnlinked: boolean): Promise<FinancialWalletRecord[]> {
    const rows = await this.db
      .select()
      .from(walletAccounts)
      .where(
        includeUnlinked
          ? eq(walletAccounts.userId, userId)
          : and(eq(walletAccounts.userId, userId), ne(walletAccounts.unlinkState, 'finalized')),
      )
      .orderBy(asc(walletAccounts.linkedAt));
    return rows.map(mapWallet);
  }

  #updateSet(record: FinancialWalletRecord) {
    return {
      unlinkState: record.unlinkState,
      riskState: record.riskState,
      label: record.label,
      linkedAt: new Date(record.linkedAt),
      lastUsedAt: dateOrNull(record.lastUsedAt),
      unlinkRequestedAt: dateOrNull(record.unlinkRequestedAt),
      unlinkFinalizeAfter: dateOrNull(record.unlinkFinalizeAfter),
      unlinkedAt: dateOrNull(record.unlinkedAt),
    };
  }

  async update(record: FinancialWalletRecord): Promise<FinancialWalletRecord> {
    await this.db
      .update(walletAccounts)
      .set(this.#updateSet(record))
      .where(eq(walletAccounts.walletAccountId, record.walletAccountId));
    return record;
  }

  async updateRiskState(
    walletAccountId: string,
    riskState: FinancialWalletRecord['riskState'],
    expected?: FinancialWalletRecord['riskState'],
  ): Promise<void> {
    // Column-scoped UPDATE: sets ONLY risk_state, so a concurrent unlink mutation
    // is never clobbered by a stale full-record snapshot (WS-L.2.5c-1).  When
    // `expected` is supplied the predicate makes it a CAS — the link-time `clear`
    // promotes `pending`→`normal` without clobbering a racing escalation.
    await this.db
      .update(walletAccounts)
      .set({ riskState })
      .where(
        expected === undefined
          ? eq(walletAccounts.walletAccountId, walletAccountId)
          : and(
              eq(walletAccounts.walletAccountId, walletAccountId),
              eq(walletAccounts.riskState, expected),
            ),
      );
  }

  async updateLabel(walletAccountId: string, label: string | null): Promise<void> {
    // Column-scoped UPDATE: sets ONLY label, so a concurrent unlink/risk mutation is
    // never clobbered by a stale full-record snapshot (WS-L.2.5c).
    await this.db
      .update(walletAccounts)
      .set({ label })
      .where(eq(walletAccounts.walletAccountId, walletAccountId));
  }

  async reactivateIfUnderCap(
    record: FinancialWalletRecord,
    maxActive: number,
  ): Promise<FinancialWalletRecord | 'cap_exceeded' | 'address_taken'> {
    return this.db.transaction(async (tx) => {
      // ADDRESS lock FIRST (namespace 2080) — the SAME lock, in the SAME order, as
      // insertIfUnderCap — so flipping a finalized row back to active serializes
      // against a concurrent cross-chain NEW-link of the same address.  The partial
      // `(address_hash, chain_id)` unique index alone can't stop two accounts holding
      // live rows for the same address on DIFFERENT chains (WS-L.2.5a).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${record.addressHashHex}), 2080)`);
      // Another account must not own a LIVE (non-finalized) row for the address.  The
      // row being reactivated is still finalized here, so it is not a live owner.
      const liveOwner = await tx
        .select({ userId: walletAccounts.userId })
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.addressHash, Buffer.from(record.addressHashHex, 'hex')),
            ne(walletAccounts.unlinkState, 'finalized'),
          ),
        )
        .limit(1);
      if (liveOwner[0] !== undefined && liveOwner[0].userId !== record.userId) {
        return 'address_taken' as const;
      }
      // SAME per-user advisory lock as insertIfUnderCap (namespace 2079), so a
      // relink and a new-link for one user serialize against the shared cap.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${record.userId}), 2079)`);
      const counted = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.userId, record.userId),
            ne(walletAccounts.unlinkState, 'finalized'),
          ),
        );
      if ((counted[0]?.n ?? 0) >= maxActive) return 'cap_exceeded' as const;
      await tx
        .update(walletAccounts)
        .set(this.#updateSet(record))
        .where(eq(walletAccounts.walletAccountId, record.walletAccountId));
      return record;
    });
  }

  async listPendingFinalization(nowIso: string): Promise<FinancialWalletRecord[]> {
    const rows = await this.db
      .select()
      .from(walletAccounts)
      .where(
        and(
          eq(walletAccounts.unlinkState, 'pending_unlink'),
          lte(walletAccounts.unlinkFinalizeAfter, new Date(nowIso)),
        ),
      );
    return rows.map(mapWallet);
  }

  async finalizeIfStillPending(
    walletAccountId: string,
    expectedFinalizeAfter: string | null,
    unlinkedAtIso: string,
  ): Promise<boolean> {
    // CAS: finalize ONLY if the row is still pending with the SAME finalize
    // timestamp — a re-link that cancelled the unlink flips the state and clears
    // the timestamp, so it matches 0 rows and is never clobbered (WS-L.2.5b).
    const rows = await this.db
      .update(walletAccounts)
      .set({ unlinkState: 'finalized', unlinkedAt: new Date(unlinkedAtIso) })
      .where(
        and(
          eq(walletAccounts.walletAccountId, walletAccountId),
          eq(walletAccounts.unlinkState, 'pending_unlink'),
          expectedFinalizeAfter === null
            ? sql`${walletAccounts.unlinkFinalizeAfter} IS NULL`
            : eq(walletAccounts.unlinkFinalizeAfter, new Date(expectedFinalizeAfter)),
        ),
      )
      .returning({ walletAccountId: walletAccounts.walletAccountId });
    return rows.length > 0;
  }

  async cancelPendingUnlink(walletAccountId: string): Promise<FinancialWalletRecord | null> {
    // Column-scoped UPDATE predicated on `pending_unlink`: flip it back to active +
    // clear the cooling-off fields, touching NOTHING else — a full snapshot would
    // clobber a `high` risk a compliance escalation persisted between the caller's
    // read and this write (the same clobber updateRiskState/updateLabel avoid).  The
    // `.returning()` gives the FRESH row, so the caller sees a concurrent escalation.
    const rows = await this.db
      .update(walletAccounts)
      .set({ unlinkState: 'active', unlinkRequestedAt: null, unlinkFinalizeAfter: null })
      .where(
        and(
          eq(walletAccounts.walletAccountId, walletAccountId),
          eq(walletAccounts.unlinkState, 'pending_unlink'),
        ),
      )
      .returning();
    // Matched: the fresh, just-reactivated row.  No match ⇒ the row was already
    // active (idempotent) or finalized by a racing sweep — return its current state.
    return rows[0] !== undefined ? mapWallet(rows[0]) : this.getById(walletAccountId);
  }

  async purgeByUser(userId: string): Promise<number> {
    const rows = await this.db
      .delete(walletAccounts)
      .where(eq(walletAccounts.userId, userId))
      .returning({ userId: walletAccounts.userId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.db.delete(walletAccounts);
  }
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

function mapDeployment(row: typeof knomosisDeployments.$inferSelect): KnomosisDeploymentRecord {
  return {
    deploymentId: row.deploymentId,
    environment: row.environment,
    chainId: row.chainId,
    l1BridgeAddress: row.l1BridgeAddress,
    runtimeEndpointRef: row.runtimeEndpointRef,
    contractManifestHash: row.contractManifestHash,
    pinnedKnomosisCommit: row.pinnedKnomosisCommit,
    status: row.status,
    createdAt: iso(row.createdAt),
  };
}

export class DrizzleKnomosisDeploymentStore implements KnomosisDeploymentStore {
  constructor(private readonly db: Db) {}

  async upsert(record: KnomosisDeploymentRecord): Promise<KnomosisDeploymentRecord> {
    await this.db
      .insert(knomosisDeployments)
      .values({
        deploymentId: record.deploymentId,
        environment: record.environment,
        chainId: record.chainId,
        l1BridgeAddress: record.l1BridgeAddress,
        runtimeEndpointRef: record.runtimeEndpointRef,
        contractManifestHash: record.contractManifestHash,
        pinnedKnomosisCommit: record.pinnedKnomosisCommit,
        status: record.status,
        createdAt: new Date(record.createdAt),
      })
      .onConflictDoUpdate({
        target: knomosisDeployments.deploymentId,
        set: {
          environment: record.environment,
          chainId: record.chainId,
          l1BridgeAddress: record.l1BridgeAddress,
          runtimeEndpointRef: record.runtimeEndpointRef,
          contractManifestHash: record.contractManifestHash,
          pinnedKnomosisCommit: record.pinnedKnomosisCommit,
          status: record.status,
        },
      });
    return record;
  }

  async getById(deploymentId: string): Promise<KnomosisDeploymentRecord | null> {
    const rows = await this.db
      .select()
      .from(knomosisDeployments)
      .where(eq(knomosisDeployments.deploymentId, deploymentId))
      .limit(1);
    return rows[0] ? mapDeployment(rows[0]) : null;
  }

  async list(): Promise<KnomosisDeploymentRecord[]> {
    return (await this.db.select().from(knomosisDeployments)).map(mapDeployment);
  }

  async clear(): Promise<void> {
    await this.db.delete(knomosisDeployments);
  }
}

// ---------------------------------------------------------------------------
// Action records
// ---------------------------------------------------------------------------

function mapAction(row: typeof knomosisActionRecords.$inferSelect): KnomosisActionRecordEntity {
  return {
    actionRecordId: row.actionRecordId,
    deploymentId: row.deploymentId,
    actionType: row.actionType,
    roomId: row.roomId,
    actorWalletAccountId: row.actorWalletAccountId,
    actorUserId: row.actorUserId,
    payloadHash: row.payloadHash,
    typedDataHash: row.typedDataHash,
    signedAction: row.signedAction as KnomosisActionRecordEntity['signedAction'],
    // Optional (exactOptionalPropertyTypes): include the key only when non-null.
    ...(row.preflightSummary !== null ? { preflightSummary: row.preflightSummary } : {}),
    submissionState: row.submissionState,
    failureReason: row.failureReason,
    indexedEventRef: row.indexedEventRef,
    reconciliationState: row.reconciliationState,
    idempotencyKey: row.idempotencyKey,
    paymentIntentId: row.paymentIntentId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleKnomosisActionStore implements KnomosisActionStore {
  constructor(private readonly db: Db) {}

  async insert(record: KnomosisActionRecordEntity): Promise<KnomosisActionRecordEntity> {
    await this.db.insert(knomosisActionRecords).values({
      actionRecordId: record.actionRecordId,
      deploymentId: record.deploymentId,
      actionType: record.actionType,
      roomId: record.roomId,
      actorWalletAccountId: record.actorWalletAccountId,
      actorUserId: record.actorUserId,
      payloadHash: record.payloadHash,
      typedDataHash: record.typedDataHash,
      signedAction: record.signedAction,
      preflightSummary: record.preflightSummary ?? null,
      submissionState: record.submissionState,
      failureReason: record.failureReason,
      indexedEventRef: record.indexedEventRef,
      reconciliationState: record.reconciliationState,
      idempotencyKey: record.idempotencyKey,
      paymentIntentId: record.paymentIntentId,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    });
    return record;
  }

  async getById(actionRecordId: string): Promise<KnomosisActionRecordEntity | null> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(eq(knomosisActionRecords.actionRecordId, actionRecordId))
      .limit(1);
    return rows[0] ? mapAction(rows[0]) : null;
  }

  async getByIdempotencyKey(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<KnomosisActionRecordEntity | null> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.actorUserId, actorUserId),
          eq(knomosisActionRecords.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? mapAction(rows[0]) : null;
  }

  async getByPaymentIntentId(paymentIntentId: string): Promise<KnomosisActionRecordEntity | null> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.paymentIntentId, paymentIntentId),
          // Live only — the same predicate `knomosis_action_intent_uq` uses, so
          // the row this returns is exactly the row that would have collided.
          notInArray(knomosisActionRecords.submissionState, [...DEAD_ACTION_STATES]),
        ),
      )
      .limit(1);
    return rows[0] ? mapAction(rows[0]) : null;
  }

  async getLatestByPaymentIntentId(
    paymentIntentId: string,
  ): Promise<KnomosisActionRecordEntity | null> {
    // ANY state, newest first — the crash-recovery read (see the interface); the
    // live-only predicate above stays the uniqueness/replay path.
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(eq(knomosisActionRecords.paymentIntentId, paymentIntentId))
      .orderBy(desc(knomosisActionRecords.createdAt))
      .limit(1);
    return rows[0] ? mapAction(rows[0]) : null;
  }

  async getByTypedDataHash(
    deploymentId: string,
    typedDataHash: string,
  ): Promise<KnomosisActionRecordEntity | null> {
    // Fetch ALL rows sharing the hash (bounded: the single-use nonce caps forwarded
    // rows at one, and identical hash ⇒ identical nonce, so at most a handful of
    // `failed`/`reserving` losers) and resolve to the deterministic gateway-bound
    // row via the SAME pure selector the in-memory adapter uses — a `.limit(1)`
    // with no ORDER BY could pick a `failed` loser and strand the real row (WS-L.3.3a).
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.deploymentId, deploymentId),
          eq(knomosisActionRecords.typedDataHash, typedDataHash),
        ),
      );
    return selectGatewayBoundAction(rows.map(mapAction));
  }

  async update(record: KnomosisActionRecordEntity): Promise<KnomosisActionRecordEntity> {
    await this.db
      .update(knomosisActionRecords)
      .set({
        submissionState: record.submissionState,
        failureReason: record.failureReason,
        indexedEventRef: record.indexedEventRef,
        reconciliationState: record.reconciliationState,
        updatedAt: new Date(record.updatedAt),
      })
      .where(eq(knomosisActionRecords.actionRecordId, record.actionRecordId));
    return record;
  }

  async updateIfState(
    actionRecordId: string,
    expectedState: KnomosisActionRecordEntity['submissionState'],
    patch: {
      submissionState: KnomosisActionRecordEntity['submissionState'];
      failureReason: string | null;
      indexedEventRef: string | null;
      updatedAt: string;
    },
  ): Promise<KnomosisActionRecordEntity | null> {
    // Atomic CAS: the WHERE binds the expected state, so a concurrent ingestion
    // that already advanced the row matches 0 rows and we return null.
    const rows = await this.db
      .update(knomosisActionRecords)
      .set({
        submissionState: patch.submissionState,
        failureReason: patch.failureReason,
        indexedEventRef: patch.indexedEventRef,
        updatedAt: new Date(patch.updatedAt),
      })
      .where(
        and(
          eq(knomosisActionRecords.actionRecordId, actionRecordId),
          eq(knomosisActionRecords.submissionState, expectedState),
        ),
      )
      .returning();
    return rows[0] ? mapAction(rows[0]) : null;
  }

  async listByRoom(roomId: string, limit: number): Promise<KnomosisActionRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(eq(knomosisActionRecords.roomId, roomId))
      .orderBy(desc(knomosisActionRecords.createdAt))
      .limit(limit);
    return rows.map(mapAction);
  }

  async listUnreconciled(
    deploymentId: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.deploymentId, deploymentId),
          // A pre-submit reservation never reached the gateway — exclude it so it
          // never manufactures a spurious mismatch (WS-L.3.2a).
          ne(knomosisActionRecords.submissionState, 'reserving'),
          // `pending` OR `mismatch` — a mismatch stays eligible so a later tick can
          // resolve it to a superseding match (WS-L.3.4b).
          inArray(knomosisActionRecords.reconciliationState, ['pending', 'mismatch']),
        ),
      )
      .orderBy(asc(knomosisActionRecords.createdAt))
      .limit(limit);
    return rows.map(mapAction);
  }

  async listInFlightByDeployment(
    deploymentId: string,
    limit: number,
    afterActionRecordId?: string,
  ): Promise<KnomosisActionRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.deploymentId, deploymentId),
          // Every forwarded, still-in-flight row (any reconciliationState) — so the
          // gap-rebuild re-anchors already-`matched` in-flight actions whose terminal
          // event fell in the lost window, not only pending/mismatch (WS-L.3.3a).
          notInArray(knomosisActionRecords.submissionState, [
            'reserving',
            ...TERMINAL_SUBMISSION_STATES,
          ]),
          // Keyset cursor on the immutable primary key so the rebuild can page the
          // WHOLE in-flight set even as it re-marks rows to `pending` between pages (P3).
          ...(afterActionRecordId !== undefined
            ? [gt(knomosisActionRecords.actionRecordId, afterActionRecordId)]
            : []),
        ),
      )
      .orderBy(asc(knomosisActionRecords.actionRecordId))
      .limit(limit);
    return rows.map(mapAction);
  }

  async listSubmittedRetryable(
    deploymentId: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.deploymentId, deploymentId),
          eq(knomosisActionRecords.submissionState, 'submitted'),
        ),
      )
      .orderBy(asc(knomosisActionRecords.createdAt))
      .limit(limit);
    return rows.map(mapAction);
  }

  async listReservingOlderThan(
    deploymentId: string,
    createdBefore: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.deploymentId, deploymentId),
          eq(knomosisActionRecords.submissionState, 'reserving'),
          lt(knomosisActionRecords.createdAt, new Date(createdBefore)),
        ),
      )
      .orderBy(asc(knomosisActionRecords.createdAt))
      .limit(limit);
    return rows.map(mapAction);
  }

  async listAllReservingOlderThan(
    createdBefore: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.submissionState, 'reserving'),
          lt(knomosisActionRecords.createdAt, new Date(createdBefore)),
        ),
      )
      .orderBy(asc(knomosisActionRecords.createdAt))
      .limit(limit);
    return rows.map(mapAction);
  }

  async deploymentIdsWithInFlightActions(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ deploymentId: knomosisActionRecords.deploymentId })
      .from(knomosisActionRecords)
      .where(
        notInArray(knomosisActionRecords.submissionState, [
          'reserving',
          'finalized',
          'reverted',
          'failed',
        ]),
      );
    return rows.map((r) => r.deploymentId);
  }

  async listFinalizedDeposits(
    deploymentId: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.deploymentId, deploymentId),
          eq(knomosisActionRecords.submissionState, 'finalized'),
          eq(knomosisActionRecords.actionType, 'treasury_deposit'),
        ),
      )
      .orderBy(asc(knomosisActionRecords.createdAt))
      .limit(limit);
    return rows.map(mapAction);
  }

  async listOpenByWallet(walletAccountId: string): Promise<KnomosisActionRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.actorWalletAccountId, walletAccountId),
          sql`${knomosisActionRecords.submissionState} NOT IN ('finalized', 'reverted', 'failed')`,
        ),
      );
    return rows.map(mapAction);
  }

  async listByActor(userId: string, limit: number): Promise<KnomosisActionRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(eq(knomosisActionRecords.actorUserId, userId))
      .orderBy(asc(knomosisActionRecords.createdAt))
      .limit(limit);
    return rows.map(mapAction);
  }

  async listInFlightByActor(userId: string): Promise<KnomosisActionRecordEntity[]> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.actorUserId, userId),
          // Every forwarded, still-in-flight row — UNCAPPED — so the purge marks all
          // of them before deleting, never leaving one behind a page of terminal rows
          // to resurface as a critical orphan divergence (WS-L.3.3b / O1).
          notInArray(knomosisActionRecords.submissionState, [
            'reserving',
            ...TERMINAL_SUBMISSION_STATES,
          ]),
        ),
      )
      .orderBy(asc(knomosisActionRecords.createdAt));
    return rows.map(mapAction);
  }

  async sumFinalizedDeposits(
    deploymentId: string,
  ): Promise<{ walletAccountId: string; asset: string; total: string }[]> {
    // SUM the JSONB amount per (wallet, asset) across ALL finalized deposits —
    // aggregated in SQL so a high-volume deployment never omits later deposits
    // from the reconciliation ledger (WS-L.3.4a).
    const assetExpr = sql<string>`${knomosisActionRecords.signedAction} -> 'message' ->> 'asset'`;
    const rows = await this.db
      .select({
        walletAccountId: knomosisActionRecords.actorWalletAccountId,
        asset: assetExpr,
        total: sql<
          string | null
        >`sum((${knomosisActionRecords.signedAction} -> 'message' ->> 'amount')::numeric)::text`,
      })
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.deploymentId, deploymentId),
          eq(knomosisActionRecords.submissionState, 'finalized'),
          eq(knomosisActionRecords.actionType, 'treasury_deposit'),
        ),
      )
      .groupBy(knomosisActionRecords.actorWalletAccountId, assetExpr);
    return rows
      .filter(
        (r): r is { walletAccountId: string; asset: string; total: string | null } =>
          typeof r.asset === 'string',
      )
      .map((r) => ({ walletAccountId: r.walletAccountId, asset: r.asset, total: r.total ?? '0' }));
  }

  async purgeByUser(userId: string): Promise<number> {
    const rows = await this.db
      .delete(knomosisActionRecords)
      .where(eq(knomosisActionRecords.actorUserId, userId))
      .returning({ userId: knomosisActionRecords.actorUserId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.db.delete(knomosisActionRecords);
  }
}

// ---------------------------------------------------------------------------
// On-chain events
// ---------------------------------------------------------------------------

function mapEvent(row: typeof onChainEvents.$inferSelect): OnChainEventRecord {
  return {
    eventId: row.eventId,
    deploymentId: row.deploymentId,
    chainId: row.chainId,
    blockNumber: row.blockNumber === null ? null : row.blockNumber.toString(),
    txHash: row.txHash,
    logIndex: row.logIndex,
    eventType: row.eventType,
    decodedPayload: row.decodedPayload as Record<string, unknown>,
    eventSource: row.eventSource,
    gatewaySeq: row.gatewaySeq === null ? null : row.gatewaySeq.toString(),
    gatewayIndex: row.gatewayIndex,
    reorgState: row.reorgState,
    reorgDetectedAt: isoOrNull(row.reorgDetectedAt),
    indexedAt: iso(row.indexedAt),
  };
}

export class DrizzleOnChainEventStore implements OnChainEventStore {
  constructor(private readonly db: Db) {}

  async ingest(
    record: OnChainEventRecord,
  ): Promise<{ record: OnChainEventRecord; inserted: boolean }> {
    const inserted = await this.db
      .insert(onChainEvents)
      .values({
        eventId: record.eventId,
        deploymentId: record.deploymentId,
        chainId: record.chainId,
        blockNumber: record.blockNumber === null ? null : BigInt(record.blockNumber),
        txHash: record.txHash,
        logIndex: record.logIndex,
        eventType: record.eventType,
        decodedPayload: record.decodedPayload,
        eventSource: record.eventSource,
        gatewaySeq: record.gatewaySeq === null ? null : BigInt(record.gatewaySeq),
        gatewayIndex: record.gatewayIndex,
        reorgState: record.reorgState,
        reorgDetectedAt: dateOrNull(record.reorgDetectedAt),
        indexedAt: new Date(record.indexedAt),
      })
      .onConflictDoNothing()
      .returning({ eventId: onChainEvents.eventId });
    if (inserted.length > 0) return { record, inserted: true };
    // Replay: resolve the existing row via the per-source unique key.
    const existing =
      record.eventSource === 'gateway'
        ? await this.db
            .select()
            .from(onChainEvents)
            .where(
              and(
                eq(onChainEvents.deploymentId, record.deploymentId),
                eq(onChainEvents.gatewaySeq, BigInt(record.gatewaySeq ?? '0')),
                eq(onChainEvents.gatewayIndex, record.gatewayIndex ?? 0),
              ),
            )
            .limit(1)
        : await this.db
            .select()
            .from(onChainEvents)
            .where(
              and(
                eq(onChainEvents.deploymentId, record.deploymentId),
                eq(onChainEvents.txHash, record.txHash ?? ''),
                eq(onChainEvents.logIndex, record.logIndex ?? 0),
              ),
            )
            .limit(1);
    const row = existing[0];
    return { record: row ? mapEvent(row) : record, inserted: false };
  }

  async getById(eventId: string): Promise<OnChainEventRecord | null> {
    const rows = await this.db
      .select()
      .from(onChainEvents)
      .where(eq(onChainEvents.eventId, eventId))
      .limit(1);
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  async listByDeployment(deploymentId: string, limit: number): Promise<OnChainEventRecord[]> {
    const rows = await this.db
      .select()
      .from(onChainEvents)
      .where(eq(onChainEvents.deploymentId, deploymentId))
      .orderBy(
        asc(onChainEvents.gatewaySeq),
        asc(onChainEvents.gatewayIndex),
        asc(onChainEvents.blockNumber),
        asc(onChainEvents.logIndex),
      )
      .limit(limit);
    return rows.map(mapEvent);
  }

  async listByTypedDataHashes(
    deploymentId: string,
    typedDataHashes: readonly string[],
  ): Promise<OnChainEventRecord[]> {
    if (typedDataHashes.length === 0) return [];
    const rows = await this.db
      .select()
      .from(onChainEvents)
      .where(
        and(
          eq(onChainEvents.deploymentId, deploymentId),
          // Match the JSONB `typed_data_hash` cell against the batch's hashes —
          // parameterized IN-list (no string interpolation), index-eligible.
          inArray(sql`${onChainEvents.decodedPayload} ->> 'typed_data_hash'`, [...typedDataHashes]),
        ),
      )
      .orderBy(
        asc(onChainEvents.gatewaySeq),
        asc(onChainEvents.gatewayIndex),
        asc(onChainEvents.blockNumber),
        asc(onChainEvents.logIndex),
      );
    return rows.map(mapEvent);
  }

  async latestGatewaySeq(deploymentId: string): Promise<string | null> {
    // The resume cursor is the group-atomic PROCESSED watermark (the cursor row),
    // recorded ONLY after a whole seq group is persisted + processed — NOT the raw
    // max-stored seq, which could sit on a partially-stored multi-index group and
    // permanently skip its unprocessed indexes on resume (WS-L.3.3a).
    const cursorRows = await this.db
      .select({ seq: knomosisGatewayCursor.seq })
      .from(knomosisGatewayCursor)
      .where(eq(knomosisGatewayCursor.deploymentId, deploymentId));
    return cursorRows[0]?.seq ?? null;
  }

  async recordGatewayCursor(deploymentId: string, seq: string): Promise<void> {
    // Monotonic upsert: advance the cursor forward, never backward.
    await this.db
      .insert(knomosisGatewayCursor)
      .values({ deploymentId, seq })
      .onConflictDoUpdate({
        target: knomosisGatewayCursor.deploymentId,
        set: { seq },
        setWhere: lt(knomosisGatewayCursor.seq, seq),
      });
  }

  async markReorged(eventIds: readonly string[], detectedAtIso: string): Promise<void> {
    if (eventIds.length === 0) return;
    await this.db
      .update(onChainEvents)
      .set({ reorgState: 'reorged', reorgDetectedAt: new Date(detectedAtIso) })
      .where(inArray(onChainEvents.eventId, [...eventIds]));
  }

  async markConfirmed(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.db
      .update(onChainEvents)
      .set({ reorgState: 'confirmed' })
      .where(
        and(inArray(onChainEvents.eventId, [...eventIds]), eq(onChainEvents.reorgState, 'pending')),
      );
  }

  async clear(): Promise<void> {
    await this.db.delete(onChainEvents);
  }
}

// ---------------------------------------------------------------------------
// Nonces (atomic consume via the composite-PK insert)
// ---------------------------------------------------------------------------

export class DrizzleActionNonceStore implements ActionNonceStore {
  constructor(private readonly db: Db) {}

  async tryConsume(userId: string, deploymentId: string, nonce: string): Promise<boolean> {
    const rows = await this.db
      .insert(knomosisActionNonces)
      .values({ userId, deploymentId, nonce })
      .onConflictDoNothing()
      .returning({ nonce: knomosisActionNonces.nonce });
    return rows.length > 0;
  }

  async isUsed(userId: string, deploymentId: string, nonce: string): Promise<boolean> {
    const rows = await this.db
      .select({ nonce: knomosisActionNonces.nonce })
      .from(knomosisActionNonces)
      .where(
        and(
          eq(knomosisActionNonces.userId, userId),
          eq(knomosisActionNonces.deploymentId, deploymentId),
          eq(knomosisActionNonces.nonce, nonce),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async purgeByUser(userId: string): Promise<number> {
    const rows = await this.db
      .delete(knomosisActionNonces)
      .where(eq(knomosisActionNonces.userId, userId))
      .returning({ userId: knomosisActionNonces.userId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.db.delete(knomosisActionNonces);
  }
}

// ---------------------------------------------------------------------------
// Actor mappings
// ---------------------------------------------------------------------------

export class DrizzleWalletActorMappingStore implements WalletActorMappingStore {
  constructor(private readonly db: Db) {}

  async get(
    walletAccountId: string,
    deploymentId: string,
  ): Promise<WalletActorMappingRecord | null> {
    const rows = await this.db
      .select()
      .from(walletActorMappings)
      .where(
        and(
          eq(walletActorMappings.walletAccountId, walletAccountId),
          eq(walletActorMappings.deploymentId, deploymentId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row
      ? {
          walletAccountId: row.walletAccountId,
          deploymentId: row.deploymentId,
          actorId: row.actorId,
          createdAt: iso(row.createdAt),
        }
      : null;
  }

  async put(record: WalletActorMappingRecord): Promise<WalletActorMappingRecord> {
    await this.db
      .insert(walletActorMappings)
      .values({
        walletAccountId: record.walletAccountId,
        deploymentId: record.deploymentId,
        actorId: record.actorId,
        createdAt: new Date(record.createdAt),
      })
      .onConflictDoUpdate({
        target: [walletActorMappings.walletAccountId, walletActorMappings.deploymentId],
        set: { actorId: record.actorId },
      });
    return record;
  }

  async listByDeployment(deploymentId: string): Promise<WalletActorMappingRecord[]> {
    const rows = await this.db
      .select()
      .from(walletActorMappings)
      .where(eq(walletActorMappings.deploymentId, deploymentId));
    return rows.map((row) => ({
      walletAccountId: row.walletAccountId,
      deploymentId: row.deploymentId,
      actorId: row.actorId,
      createdAt: iso(row.createdAt),
    }));
  }

  async clear(): Promise<void> {
    await this.db.delete(walletActorMappings);
  }
}

// ---------------------------------------------------------------------------
// Governance proposals + votes + signatures
// ---------------------------------------------------------------------------

function mapProposal(row: typeof governanceProposals.$inferSelect): GovernanceProposalRecord {
  return {
    proposalId: row.proposalId,
    roomId: row.roomId,
    proposerUserId: row.proposerUserId,
    proposalType: row.proposalType,
    title: row.title,
    plainLanguageSummary: row.plainLanguageSummary,
    requestedAmount: row.requestedAmount,
    asset: row.asset,
    recipientRef: row.recipientRef,
    conflictDisclosures: row.conflictDisclosures,
    riskAssessment: row.riskAssessment,
    requestedAction: row.requestedAction as Record<string, unknown>,
    expectedDeliverable: row.expectedDeliverable,
    preflightState: row.preflightState,
    votingState: row.votingState,
    challengeState: row.challengeState,
    executionState: row.executionState,
    simulationMode: row.simulationMode,
    executableAfter: isoOrNull(row.executableAfter),
    createdAt: iso(row.createdAt),
    executedAt: isoOrNull(row.executedAt),
    executionClaimedAt: isoOrNull(row.executionClaimedAt),
    // WS-M production lifecycle columns (null on sim rows).
    lawPackVersionId: row.lawPackVersionId,
    category: row.category,
    deliberationEndsAt: isoOrNull(row.deliberationEndsAt),
    votingEndsAt: isoOrNull(row.votingEndsAt),
    challengeWindowEndsAt: isoOrNull(row.challengeWindowEndsAt),
    tallySnapshot: (row.tallySnapshot as Record<string, unknown> | null) ?? null,
  };
}

export class DrizzleGovernanceProposalStore implements GovernanceProposalStore {
  constructor(private readonly db: Db) {}

  async insert(record: GovernanceProposalRecord): Promise<GovernanceProposalRecord> {
    await this.db.insert(governanceProposals).values({
      proposalId: record.proposalId,
      roomId: record.roomId,
      proposerUserId: record.proposerUserId,
      proposalType: record.proposalType,
      title: record.title,
      plainLanguageSummary: record.plainLanguageSummary,
      requestedAmount: record.requestedAmount,
      asset: record.asset,
      recipientRef: record.recipientRef,
      conflictDisclosures: record.conflictDisclosures,
      riskAssessment: record.riskAssessment,
      requestedAction: record.requestedAction,
      expectedDeliverable: record.expectedDeliverable,
      preflightState: record.preflightState,
      votingState: record.votingState,
      challengeState: record.challengeState,
      executionState: record.executionState,
      simulationMode: record.simulationMode,
      executableAfter: dateOrNull(record.executableAfter),
      createdAt: new Date(record.createdAt),
      executedAt: dateOrNull(record.executedAt),
      executionClaimedAt: dateOrNull(record.executionClaimedAt),
      lawPackVersionId: record.lawPackVersionId ?? null,
      category: record.category ?? null,
      deliberationEndsAt: dateOrNull(record.deliberationEndsAt ?? null),
      votingEndsAt: dateOrNull(record.votingEndsAt ?? null),
      challengeWindowEndsAt: dateOrNull(record.challengeWindowEndsAt ?? null),
      tallySnapshot: record.tallySnapshot ?? null,
    });
    return record;
  }

  async getById(proposalId: string): Promise<GovernanceProposalRecord | null> {
    const rows = await this.db
      .select()
      .from(governanceProposals)
      .where(eq(governanceProposals.proposalId, proposalId))
      .limit(1);
    return rows[0] ? mapProposal(rows[0]) : null;
  }

  async listByRoom(roomId: string, limit: number): Promise<GovernanceProposalRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceProposals)
      .where(eq(governanceProposals.roomId, roomId))
      .orderBy(desc(governanceProposals.createdAt))
      .limit(limit);
    return rows.map(mapProposal);
  }

  async listUnsettledByRoom(
    roomId: string,
    limit: number,
    afterId: string | null = null,
  ): Promise<GovernanceProposalRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceProposals)
      .where(
        and(
          eq(governanceProposals.roomId, roomId),
          eq(governanceProposals.simulationMode, false),
          or(
            inArray(governanceProposals.votingState, ['deliberation', 'open']),
            and(
              eq(governanceProposals.votingState, 'passed'),
              inArray(governanceProposals.executionState, ['timelocked', 'executing']),
            ),
          ),
          afterId === null ? undefined : gt(governanceProposals.proposalId, afterId),
        ),
      )
      .orderBy(asc(governanceProposals.proposalId))
      .limit(limit);
    return rows.map(mapProposal);
  }

  async update(record: GovernanceProposalRecord): Promise<GovernanceProposalRecord> {
    await this.db
      .update(governanceProposals)
      .set({
        preflightState: record.preflightState,
        votingState: record.votingState,
        challengeState: record.challengeState,
        executionState: record.executionState,
        executableAfter: dateOrNull(record.executableAfter),
        executedAt: dateOrNull(record.executedAt),
        executionClaimedAt: dateOrNull(record.executionClaimedAt),
      })
      .where(eq(governanceProposals.proposalId, record.proposalId));
    return record;
  }

  async claimForExecution(
    proposalId: string,
    claimedAt: string,
  ): Promise<GovernanceProposalRecord | null> {
    // Atomic CAS timelocked→EXECUTING: only ONE racing execute wins the claim, so
    // the treasury cannot be debited twice.  The proposal advances to `executed`
    // only via finalizeExecution AFTER the debit + ledger are durable (WS-L.4.1c).
    // Stamps `executionClaimedAt` so the recovery sweep can distinguish a fresh
    // live claim from a genuinely stranded one (N2).
    const rows = await this.db
      .update(governanceProposals)
      .set({ executionState: 'executing', executionClaimedAt: new Date(claimedAt) })
      .where(
        and(
          eq(governanceProposals.proposalId, proposalId),
          eq(governanceProposals.executionState, 'timelocked'),
          eq(governanceProposals.votingState, 'passed'),
        ),
      )
      .returning();
    return rows[0] ? mapProposal(rows[0]) : null;
  }

  async finalizeExecution(
    proposalId: string,
    executedAt: string,
  ): Promise<GovernanceProposalRecord | null> {
    // Atomic CAS executing→executed: called ONLY after the debit + ledger are
    // durable, so `executed` implies the treasury effect happened (WS-L.4.1c).
    const rows = await this.db
      .update(governanceProposals)
      .set({ executionState: 'executed', executedAt: new Date(executedAt) })
      .where(
        and(
          eq(governanceProposals.proposalId, proposalId),
          eq(governanceProposals.executionState, 'executing'),
        ),
      )
      .returning();
    return rows[0] ? mapProposal(rows[0]) : null;
  }

  async resolveVotingIfOpen(
    proposalId: string,
    resolution:
      | { votingState: 'passed'; executionState: 'timelocked'; executableAfter: string }
      | { votingState: 'rejected' },
  ): Promise<GovernanceProposalRecord | null> {
    // Atomic CAS votingState open→terminal: the single-resolution gate so two
    // concurrent quorum-reaching votes cannot both close the proposal (WS-L.4.1d).
    const set =
      resolution.votingState === 'passed'
        ? {
            votingState: 'passed' as const,
            executionState: 'timelocked' as const,
            executableAfter: new Date(resolution.executableAfter),
          }
        : { votingState: 'rejected' as const };
    const rows = await this.db
      .update(governanceProposals)
      .set(set)
      .where(
        and(
          eq(governanceProposals.proposalId, proposalId),
          eq(governanceProposals.votingState, 'open'),
        ),
      )
      .returning();
    return rows[0] ? mapProposal(rows[0]) : null;
  }

  async casVotingState(
    proposalId: string,
    from: GovernanceProposalRecord['votingState'],
    to: GovernanceProposalRecord['votingState'],
    patch: Parameters<GovernanceProposalStore['casVotingState']>[3],
  ): Promise<GovernanceProposalRecord | null> {
    // Generalized voting-state CAS (WS-M.4.2d): the WHERE carries the
    // expectation so a concurrent settle matches zero rows, never clobbers.
    const rows = await this.db
      .update(governanceProposals)
      .set({
        votingState: to,
        ...(patch.executionState !== undefined ? { executionState: patch.executionState } : {}),
        ...(patch.executableAfter !== undefined
          ? { executableAfter: dateOrNull(patch.executableAfter ?? null) }
          : {}),
        ...(patch.challengeWindowEndsAt !== undefined
          ? { challengeWindowEndsAt: dateOrNull(patch.challengeWindowEndsAt ?? null) }
          : {}),
        ...(patch.votingEndsAt !== undefined
          ? { votingEndsAt: dateOrNull(patch.votingEndsAt ?? null) }
          : {}),
        ...(patch.tallySnapshot !== undefined ? { tallySnapshot: patch.tallySnapshot } : {}),
        ...(patch.challengeState !== undefined ? { challengeState: patch.challengeState } : {}),
      })
      .where(
        and(
          eq(governanceProposals.proposalId, proposalId),
          eq(governanceProposals.votingState, from),
        ),
      )
      .returning();
    return rows[0] ? mapProposal(rows[0]) : null;
  }

  async casExecutionState(
    proposalId: string,
    fromStates: readonly GovernanceProposalRecord['executionState'][],
    to: GovernanceProposalRecord['executionState'],
    options: { clearClaim?: boolean } = {},
  ): Promise<boolean> {
    const rows = await this.db
      .update(governanceProposals)
      .set({
        executionState: to,
        ...(options.clearClaim === true ? { executionClaimedAt: null } : {}),
      })
      .where(
        and(
          eq(governanceProposals.proposalId, proposalId),
          inArray(governanceProposals.executionState, [...fromStates]),
        ),
      )
      .returning({ proposalId: governanceProposals.proposalId });
    return rows.length > 0;
  }

  async applyChallengeProjection(
    proposalId: string,
    projection: {
      challengeState: GovernanceProposalRecord['challengeState'];
      blockExecution?: boolean;
      executableAfterFloor?: string;
    },
  ): Promise<boolean> {
    // COLUMN-scoped, WHERE-guarded statements — never a stale whole-row write
    // that could undo a concurrent execution (PR #144 W11).
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(governanceProposals)
        .set({ challengeState: projection.challengeState })
        .where(eq(governanceProposals.proposalId, proposalId))
        .returning({ proposalId: governanceProposals.proposalId });
      if (rows.length === 0) return false;
      if (projection.blockExecution === true) {
        await tx
          .update(governanceProposals)
          .set({ executionState: 'blocked' })
          .where(
            and(
              eq(governanceProposals.proposalId, proposalId),
              inArray(governanceProposals.executionState, ['not_executed', 'timelocked']),
            ),
          );
      }
      if (projection.executableAfterFloor !== undefined) {
        const floor = new Date(projection.executableAfterFloor);
        await tx
          .update(governanceProposals)
          .set({ executableAfter: floor })
          .where(
            and(
              eq(governanceProposals.proposalId, proposalId),
              eq(governanceProposals.executionState, 'timelocked'),
              or(
                isNull(governanceProposals.executableAfter),
                lt(governanceProposals.executableAfter, floor),
              ),
            ),
          );
      }
      return true;
    });
  }

  async listExecutable(nowIso: string): Promise<GovernanceProposalRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceProposals)
      .where(
        and(
          eq(governanceProposals.executionState, 'timelocked'),
          lte(governanceProposals.executableAfter, new Date(nowIso)),
        ),
      );
    return rows.map(mapProposal);
  }

  async listRecoverableExecuting(claimedBeforeIso: string): Promise<GovernanceProposalRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceProposals)
      .where(
        and(
          eq(governanceProposals.executionState, 'executing'),
          eq(governanceProposals.votingState, 'passed'),
          // A legacy null claim is always recoverable; a stamped claim only once it
          // is older than the cutoff — so a just-claimed live execution is left to
          // its initiating caller and never raced by the null-actor sweep (N2).
          or(
            isNull(governanceProposals.executionClaimedAt),
            lte(governanceProposals.executionClaimedAt, new Date(claimedBeforeIso)),
          ),
        ),
      );
    return rows.map(mapProposal);
  }

  async listOpenByRoomAndType(
    roomId: string,
    proposalType: GovernanceProposalRecord['proposalType'],
  ): Promise<GovernanceProposalRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceProposals)
      .where(
        and(
          eq(governanceProposals.roomId, roomId),
          eq(governanceProposals.proposalType, proposalType),
          eq(governanceProposals.votingState, 'open'),
        ),
      );
    return rows.map(mapProposal);
  }

  async listByProposer(userId: string): Promise<GovernanceProposalRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceProposals)
      .where(eq(governanceProposals.proposerUserId, userId));
    return rows.map(mapProposal);
  }

  async anonymizeProposer(userId: string): Promise<number> {
    // Scrub the authorship link ONLY — never DELETE the proposal, or the §0059
    // `proposal_id` FKs would cascade-remove other members' votes/signatures.
    const rows = await this.db
      .update(governanceProposals)
      .set({ proposerUserId: null })
      .where(eq(governanceProposals.proposerUserId, userId))
      .returning({ proposalId: governanceProposals.proposalId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.db.delete(governanceProposals);
  }
}

export class DrizzleProposalVoteStore implements ProposalVoteStore {
  constructor(private readonly db: Db) {}

  async cast(record: ProposalVoteRecord): Promise<ProposalVoteRecord | null> {
    // Gate the insert on the LIVE proposal state, atomically: lock the proposal row
    // FOR UPDATE so a concurrent resolveVotingIfOpen cannot close it between the
    // open-check and the vote insert — a vote loaded while open must not be counted
    // after the proposal has closed/timelocked (WS-L.4.1d).  Returns null when the
    // proposal is no longer open OR the voter already voted.
    return this.db.transaction(async (tx) => {
      const proposal = await tx
        .select({ votingState: governanceProposals.votingState })
        .from(governanceProposals)
        .where(eq(governanceProposals.proposalId, record.proposalId))
        .for('update');
      if (proposal[0]?.votingState !== 'open') return null;
      const rows = await tx
        .insert(governanceProposalVotes)
        .values({
          proposalId: record.proposalId,
          voterUserId: record.voterUserId,
          choice: record.choice,
          castAt: new Date(record.castAt),
        })
        .onConflictDoNothing()
        .returning({ proposalId: governanceProposalVotes.proposalId });
      return rows.length > 0 ? record : null;
    });
  }

  async tally(proposalId: string): Promise<{ approve: number; reject: number; abstain: number }> {
    const rows = await this.db
      .select({
        choice: governanceProposalVotes.choice,
        count: sql<number>`count(*)::int`,
      })
      .from(governanceProposalVotes)
      .where(eq(governanceProposalVotes.proposalId, proposalId))
      .groupBy(governanceProposalVotes.choice);
    const tally = { approve: 0, reject: 0, abstain: 0 };
    for (const row of rows) {
      if (row.choice === 'approve' || row.choice === 'reject' || row.choice === 'abstain') {
        tally[row.choice] = row.count;
      }
    }
    return tally;
  }

  async listByVoter(userId: string): Promise<ProposalVoteRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceProposalVotes)
      .where(eq(governanceProposalVotes.voterUserId, userId));
    return rows.map((r) => ({
      proposalId: r.proposalId,
      voterUserId: r.voterUserId,
      choice: r.choice as ProposalVoteRecord['choice'],
      castAt: iso(r.castAt),
    }));
  }

  async purgeByUser(userId: string): Promise<number> {
    const rows = await this.db
      .delete(governanceProposalVotes)
      .where(eq(governanceProposalVotes.voterUserId, userId))
      .returning({ voterUserId: governanceProposalVotes.voterUserId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.db.delete(governanceProposalVotes);
  }
}

function mapSignature(row: typeof governanceSignatures.$inferSelect): GovernanceSignatureRecord {
  return {
    signatureId: row.signatureId,
    proposalId: row.proposalId,
    userId: row.userId,
    walletAccountId: row.walletAccountId,
    signatureType: row.signatureType as GovernanceSignatureRecord['signatureType'],
    typedDataHash: row.typedDataHash,
    signatureRef: row.signatureRef,
    weightSnapshot: row.weightSnapshot,
    eligibilityReason: row.eligibilityReason,
    createdAt: iso(row.createdAt),
    purpose: row.purpose as NonNullable<GovernanceSignatureRecord['purpose']>,
    choice: (row.choice as GovernanceSignatureRecord['choice']) ?? null,
    nonce: row.nonce,
  };
}

export class DrizzleGovernanceSignatureStore implements GovernanceSignatureStore {
  constructor(private readonly db: Db) {}

  async insert(record: GovernanceSignatureRecord): Promise<GovernanceSignatureRecord | null> {
    const rows = await this.db
      .insert(governanceSignatures)
      .values({
        signatureId: record.signatureId,
        proposalId: record.proposalId,
        userId: record.userId,
        walletAccountId: record.walletAccountId,
        signatureType: record.signatureType,
        typedDataHash: record.typedDataHash,
        signatureRef: record.signatureRef,
        weightSnapshot: record.weightSnapshot,
        eligibilityReason: record.eligibilityReason,
        createdAt: new Date(record.createdAt),
        purpose: record.purpose ?? 'vote',
        choice: record.choice ?? null,
        nonce: record.nonce ?? null,
      })
      .onConflictDoNothing()
      .returning({ signatureId: governanceSignatures.signatureId });
    return rows.length > 0 ? record : null;
  }

  async listByProposal(proposalId: string): Promise<GovernanceSignatureRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceSignatures)
      .where(eq(governanceSignatures.proposalId, proposalId));
    return rows.map(mapSignature);
  }

  async listOpenByWallet(walletAccountId: string): Promise<GovernanceSignatureRecord[]> {
    const rows = await this.db
      .select({ signature: governanceSignatures })
      .from(governanceSignatures)
      .innerJoin(
        governanceProposals,
        eq(governanceSignatures.proposalId, governanceProposals.proposalId),
      )
      .where(
        and(
          eq(governanceSignatures.walletAccountId, walletAccountId),
          eq(governanceProposals.votingState, 'open'),
        ),
      );
    return rows.map((r) => mapSignature(r.signature));
  }

  async removeByAction(actionRecordId: string): Promise<number> {
    const rows = await this.db
      .delete(governanceSignatures)
      .where(eq(governanceSignatures.signatureRef, actionRecordId))
      .returning({ signatureId: governanceSignatures.signatureId });
    return rows.length;
  }

  async purgeByUser(userId: string): Promise<number> {
    const rows = await this.db
      .delete(governanceSignatures)
      .where(eq(governanceSignatures.userId, userId))
      .returning({ userId: governanceSignatures.userId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.db.delete(governanceSignatures);
  }
}

// ---------------------------------------------------------------------------
// Simulated treasury + governance audit + reconciliation + receipts +
// comprehension
// ---------------------------------------------------------------------------

export class DrizzleSimTreasuryStore implements SimTreasuryStore {
  constructor(private readonly db: Db) {}

  async get(roomId: string): Promise<SimTreasuryRecord | null> {
    const rows = await this.db
      .select()
      .from(simTreasuries)
      .where(eq(simTreasuries.roomId, roomId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          roomId: row.roomId,
          balances: row.balances as Record<string, string>,
          updatedAt: iso(row.updatedAt),
        }
      : null;
  }

  async put(
    record: SimTreasuryRecord,
    expectedUpdatedAt?: string,
    entry?: SimTreasuryEntryRecord,
  ): Promise<SimTreasuryRecord | null> {
    const values = {
      roomId: record.roomId,
      balances: record.balances,
      updatedAt: new Date(record.updatedAt),
    };
    if (expectedUpdatedAt === undefined) {
      // Bootstrap: INSERT-IF-ABSENT — never clobber an existing treasury.
      const inserted = await this.db
        .insert(simTreasuries)
        .values(values)
        .onConflictDoNothing()
        .returning({ roomId: simTreasuries.roomId });
      if (inserted.length > 0) return record;
      return this.get(record.roomId);
    }
    // ATOMIC balance write + ledger append (a single transaction), with idempotency.
    return this.db.transaction(async (tx) => {
      // IDEMPOTENCY: a crash-retry whose entry already exists applies NOTHING.
      if (entry?.idempotencyKey != null) {
        const dup = await tx
          .select({ id: simTreasuryEntries.entryId })
          .from(simTreasuryEntries)
          .where(eq(simTreasuryEntries.idempotencyKey, entry.idempotencyKey))
          .limit(1);
        if (dup.length > 0) {
          const cur = await tx
            .select()
            .from(simTreasuries)
            .where(eq(simTreasuries.roomId, record.roomId))
            .limit(1);
          const row = cur[0];
          return row
            ? {
                roomId: row.roomId,
                balances: row.balances as Record<string, string>,
                updatedAt: iso(row.updatedAt),
              }
            : null;
        }
      }
      // Conditional (optimistic-concurrency) overwrite: applies only when the stored
      // `updated_at` still matches the snapshot, so racing writes cannot lose an update.
      const rows = await tx
        .insert(simTreasuries)
        .values(values)
        .onConflictDoUpdate({
          target: simTreasuries.roomId,
          set: { balances: record.balances, updatedAt: new Date(record.updatedAt) },
          setWhere: eq(simTreasuries.updatedAt, new Date(expectedUpdatedAt)),
        })
        .returning({ roomId: simTreasuries.roomId });
      if (rows.length === 0) return null;
      if (entry !== undefined) {
        await tx.insert(simTreasuryEntries).values({
          entryId: entry.entryId,
          roomId: entry.roomId,
          kind: entry.kind,
          asset: entry.asset,
          amount: entry.amount,
          actorUserId: entry.actorUserId,
          proposalId: entry.proposalId,
          idempotencyKey: entry.idempotencyKey,
          createdAt: new Date(entry.createdAt),
        });
      }
      return record;
    });
  }

  async appendEntry(entry: SimTreasuryEntryRecord): Promise<SimTreasuryEntryRecord> {
    await this.db.insert(simTreasuryEntries).values({
      entryId: entry.entryId,
      roomId: entry.roomId,
      kind: entry.kind,
      asset: entry.asset,
      amount: entry.amount,
      actorUserId: entry.actorUserId,
      proposalId: entry.proposalId,
      idempotencyKey: entry.idempotencyKey,
      createdAt: new Date(entry.createdAt),
    });
    return entry;
  }

  async listEntries(roomId: string, limit: number): Promise<SimTreasuryEntryRecord[]> {
    const rows = await this.db
      .select()
      .from(simTreasuryEntries)
      .where(eq(simTreasuryEntries.roomId, roomId))
      .orderBy(desc(simTreasuryEntries.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      entryId: row.entryId,
      roomId: row.roomId,
      kind: row.kind as SimTreasuryEntryRecord['kind'],
      asset: row.asset,
      amount: row.amount,
      actorUserId: row.actorUserId,
      proposalId: row.proposalId,
      idempotencyKey: row.idempotencyKey,
      createdAt: iso(row.createdAt),
    }));
  }

  async findEntryByIdempotencyKey(idempotencyKey: string): Promise<SimTreasuryEntryRecord | null> {
    const [row] = await this.db
      .select()
      .from(simTreasuryEntries)
      .where(eq(simTreasuryEntries.idempotencyKey, idempotencyKey))
      .limit(1);
    if (row === undefined) return null;
    return {
      entryId: row.entryId,
      roomId: row.roomId,
      kind: row.kind as SimTreasuryEntryRecord['kind'],
      asset: row.asset,
      amount: row.amount,
      actorUserId: row.actorUserId,
      proposalId: row.proposalId,
      idempotencyKey: row.idempotencyKey,
      createdAt: iso(row.createdAt),
    };
  }

  async anonymizeActor(userId: string): Promise<number> {
    const rows = await this.db
      .update(simTreasuryEntries)
      .set({ actorUserId: null })
      .where(eq(simTreasuryEntries.actorUserId, userId))
      .returning({ entryId: simTreasuryEntries.entryId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.db.delete(simTreasuryEntries);
    await this.db.delete(simTreasuries);
  }
}

export class DrizzleGovernanceAuditStore implements GovernanceAuditStore {
  constructor(private readonly db: Db) {}

  async append(entry: GovernanceAuditRecord): Promise<GovernanceAuditRecord> {
    // Idempotent on `dedupeKey`: the partial-null unique index means a duplicate key
    // hits ON CONFLICT DO NOTHING (a crash-retry REPAIRS a dropped audit exactly
    // once); rows with a NULL key are unconstrained, so ordinary audits still append
    // freely (WS-L.4.1c / P2).  The return value is unused by all callers.
    await this.db
      .insert(governanceAuditLogs)
      .values({
        entryId: entry.entryId,
        roomId: entry.roomId,
        actionType: entry.actionType,
        actorUserId: entry.actorUserId,
        actionDetails: entry.actionDetails,
        simulationMode: entry.simulationMode,
        createdAt: new Date(entry.createdAt),
        dedupeKey: entry.dedupeKey ?? null,
        prevHash: entry.prevHash ?? null,
        integrityHash: entry.integrityHash ?? null,
        proposalId: entry.proposalId ?? null,
        treasuryId: entry.treasuryId ?? null,
      })
      .onConflictDoNothing({ target: governanceAuditLogs.dedupeKey });
    return entry;
  }

  async appendChained(entry: GovernanceAuditRecord): Promise<GovernanceAuditRecord | null> {
    if (entry.integrityHash === undefined || entry.integrityHash === null) {
      throw new Error('appendChained requires an integrityHash');
    }
    try {
      await this.db.insert(governanceAuditLogs).values({
        entryId: entry.entryId,
        roomId: entry.roomId,
        actionType: entry.actionType,
        actorUserId: entry.actorUserId,
        actionDetails: entry.actionDetails,
        simulationMode: entry.simulationMode,
        createdAt: new Date(entry.createdAt),
        dedupeKey: entry.dedupeKey ?? null,
        prevHash: entry.prevHash ?? null,
        integrityHash: entry.integrityHash,
        proposalId: entry.proposalId ?? null,
        treasuryId: entry.treasuryId ?? null,
      });
      return entry;
    } catch (error) {
      // A unique violation on the fork-proof chain indexes (migration 0082)
      // means the writer must re-read the head and retry; anything else
      // rethrows.  (Drizzle buries the SQLSTATE on the cause chain — see
      // `isUniqueViolation`.)
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async chainHead(roomId: string): Promise<GovernanceAuditRecord | null> {
    // The chain head is the chained entry whose integrity hash no other chained
    // entry references as its parent — unique by the fork-proof indexes.
    const rows = await this.db
      .select()
      .from(governanceAuditLogs)
      .where(
        and(
          eq(governanceAuditLogs.roomId, roomId),
          isNotNull(governanceAuditLogs.integrityHash),
          sql`${governanceAuditLogs.integrityHash} NOT IN (
            SELECT gal."prev_hash" FROM "knomosis"."governance_audit_log" gal
            WHERE gal."room_id" = ${roomId} AND gal."prev_hash" IS NOT NULL
          )`,
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? this.#mapChained(row) : null;
  }

  async listChainedByRoom(roomId: string): Promise<GovernanceAuditRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceAuditLogs)
      .where(
        and(eq(governanceAuditLogs.roomId, roomId), isNotNull(governanceAuditLogs.integrityHash)),
      );
    return rows.map((row) => this.#mapChained(row));
  }

  #mapChained(row: typeof governanceAuditLogs.$inferSelect): GovernanceAuditRecord {
    return {
      entryId: row.entryId,
      roomId: row.roomId,
      actionType: row.actionType as GovernanceAuditRecord['actionType'],
      actorUserId: row.actorUserId,
      actionDetails: row.actionDetails as Record<string, unknown>,
      simulationMode: row.simulationMode,
      createdAt: iso(row.createdAt),
      prevHash: row.prevHash,
      integrityHash: row.integrityHash,
      proposalId: row.proposalId,
      treasuryId: row.treasuryId,
    };
  }

  async listByRoom(
    roomId: string,
    limit: number,
    before?: AuditLogCursor,
  ): Promise<GovernanceAuditRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceAuditLogs)
      .where(
        before === undefined
          ? eq(governanceAuditLogs.roomId, roomId)
          : and(
              eq(governanceAuditLogs.roomId, roomId),
              // Row-value keyset comparison over the STRICT (createdAt, entryId)
              // total order — the entryId tiebreaker makes same-millisecond rows
              // page without skips/duplicates (WS-L.4.1f).  The timestamp binds
              // as an ISO STRING + explicit cast: postgres.js cannot serialize a
              // raw Date inside a row-value fragment (it threw on every second
              // page until the treasury contract test caught it).
              sql`(${governanceAuditLogs.createdAt}, ${governanceAuditLogs.entryId}) < (${new Date(before.createdAt).toISOString()}::timestamptz, ${before.entryId}::uuid)`,
            ),
      )
      .orderBy(desc(governanceAuditLogs.createdAt), desc(governanceAuditLogs.entryId))
      .limit(limit);
    return rows.map((row) => ({
      entryId: row.entryId,
      roomId: row.roomId,
      actionType: row.actionType as GovernanceAuditRecord['actionType'],
      actorUserId: row.actorUserId,
      actionDetails: row.actionDetails as Record<string, unknown>,
      simulationMode: row.simulationMode,
      createdAt: iso(row.createdAt),
      prevHash: row.prevHash,
      integrityHash: row.integrityHash,
      proposalId: row.proposalId,
      treasuryId: row.treasuryId,
    }));
  }

  async countByRoom(roomId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(governanceAuditLogs)
      .where(eq(governanceAuditLogs.roomId, roomId));
    return rows[0]?.count ?? 0;
  }

  async countQualifyingByRoom(roomId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(governanceAuditLogs)
      .where(
        and(
          eq(governanceAuditLogs.roomId, roomId),
          eq(governanceAuditLogs.simulationMode, true),
          inArray(governanceAuditLogs.actionType, [...READINESS_QUALIFYING_AUDIT_ACTIONS]),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async countQualifyingByRoomActor(roomId: string, userId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(governanceAuditLogs)
      .where(
        and(
          eq(governanceAuditLogs.roomId, roomId),
          eq(governanceAuditLogs.actorUserId, userId),
          inArray(governanceAuditLogs.actionType, [...READINESS_QUALIFYING_AUDIT_ACTIONS]),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async anonymizeActor(userId: string): Promise<number> {
    // The append-only trigger EXPLICITLY permits the right-to-erasure NULLing of
    // `actor_user_id` (migration 0059), so scrub the actor WITHOUT disabling it —
    // never leaving the audit log mutable if the update errors mid-way.
    const rows = await this.db
      .update(governanceAuditLogs)
      .set({ actorUserId: null })
      .where(eq(governanceAuditLogs.actorUserId, userId))
      .returning({ entryId: governanceAuditLogs.entryId });
    return rows.length;
  }

  /** Test-only; production DELETEs are blocked by the append-only trigger. */
  async clear(): Promise<void> {
    await this.db.execute(
      sql`ALTER TABLE "knomosis"."governance_audit_log" DISABLE TRIGGER "governance_audit_no_mutate_trg"`,
    );
    await this.db.delete(governanceAuditLogs);
    await this.db.execute(
      sql`ALTER TABLE "knomosis"."governance_audit_log" ENABLE TRIGGER "governance_audit_no_mutate_trg"`,
    );
  }
}

export class DrizzleReconciliationStore implements ReconciliationStore {
  constructor(private readonly db: Db) {}

  async append(result: ReconciliationResultRecord): Promise<ReconciliationResultRecord> {
    await this.db.insert(reconciliationResults).values({
      resultId: result.resultId,
      deploymentId: result.deploymentId,
      entityType: result.entityType,
      entityRef: result.entityRef,
      outcome: result.outcome,
      severity: result.severity,
      details: result.details,
      lowWatermarkSeq: result.lowWatermarkSeq === null ? null : BigInt(result.lowWatermarkSeq),
      createdAt: new Date(result.createdAt),
    });
    return result;
  }

  async latestForEntity(
    entityType: ReconciliationResultRecord['entityType'],
    entityRef: string,
  ): Promise<ReconciliationResultRecord | null> {
    const rows = await this.db
      .select()
      .from(reconciliationResults)
      .where(
        and(
          eq(reconciliationResults.entityType, entityType),
          eq(reconciliationResults.entityRef, entityRef),
        ),
      )
      // seq DESC is the strict tiebreaker: on an equal created_at the LATER
      // insert (a resolving match) wins over its mismatch (WS-L.3.4b).
      .orderBy(desc(reconciliationResults.createdAt), desc(reconciliationResults.seq))
      .limit(1);
    const row = rows[0];
    return row ? mapReconciliation(row) : null;
  }

  async listUnresolvedMismatches(deploymentId: string): Promise<ReconciliationResultRecord[]> {
    // Latest result per entity; the seq tiebreaker ensures a same-`created_at`
    // resolving match supersedes its mismatch (else DISTINCT ON could keep the
    // older mismatch and block canExpandTreasury forever, WS-L.3.4b).
    const rows = await this.db.execute(sql`
      SELECT DISTINCT ON (entity_type, entity_ref) *
      FROM "knomosis"."knomosis_reconciliation_result"
      WHERE deployment_id = ${deploymentId}
      ORDER BY entity_type, entity_ref, created_at DESC, seq DESC
    `);
    const records = (rows as unknown as Array<Record<string, unknown>>)
      .map((raw) => ({
        resultId: String(raw['result_id']),
        deploymentId: String(raw['deployment_id']),
        entityType: String(raw['entity_type']) as ReconciliationResultRecord['entityType'],
        entityRef: String(raw['entity_ref']),
        outcome: String(raw['outcome']) as ReconciliationResultRecord['outcome'],
        severity: (raw['severity'] ?? null) as ReconciliationResultRecord['severity'],
        details: (raw['details'] ?? {}) as Record<string, unknown>,
        lowWatermarkSeq:
          raw['low_watermark_seq'] === null ? null : String(raw['low_watermark_seq']),
        createdAt: new Date(String(raw['created_at'])).toISOString(),
      }))
      .filter((r) => r.outcome !== 'match');
    return records;
  }

  async clear(): Promise<void> {
    await this.db.delete(reconciliationResults);
  }
}

function mapReconciliation(
  row: typeof reconciliationResults.$inferSelect,
): ReconciliationResultRecord {
  return {
    resultId: row.resultId,
    deploymentId: row.deploymentId,
    entityType: row.entityType as ReconciliationResultRecord['entityType'],
    entityRef: row.entityRef,
    outcome: row.outcome,
    severity: row.severity,
    details: row.details as Record<string, unknown>,
    lowWatermarkSeq: row.lowWatermarkSeq === null ? null : row.lowWatermarkSeq.toString(),
    createdAt: iso(row.createdAt),
  };
}

export class DrizzleKnomosisReceiptStore implements KnomosisReceiptStore {
  constructor(private readonly db: Db) {}

  async upsert(record: KnomosisReceiptRecord): Promise<KnomosisReceiptRecord> {
    await this.db
      .insert(knomosisReceipts)
      .values({
        receiptId: record.receiptId,
        actionRecordId: record.actionRecordId,
        kind: record.kind,
        payload: record.payload,
        summaryPayloadHash: record.summaryPayloadHash,
        ownerUserId: record.ownerUserId,
        finalState: record.finalState,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      })
      .onConflictDoUpdate({
        target: [knomosisReceipts.actionRecordId, knomosisReceipts.kind],
        set: {
          payload: record.payload,
          summaryPayloadHash: record.summaryPayloadHash,
          finalState: record.finalState,
          updatedAt: new Date(record.updatedAt),
        },
      });
    return record;
  }

  async getByAction(
    actionRecordId: string,
    kind: 'public' | 'private',
  ): Promise<KnomosisReceiptRecord | null> {
    const rows = await this.db
      .select()
      .from(knomosisReceipts)
      .where(
        and(eq(knomosisReceipts.actionRecordId, actionRecordId), eq(knomosisReceipts.kind, kind)),
      )
      .limit(1);
    return rows[0] ? mapReceipt(rows[0]) : null;
  }

  async listPublicByRoomActions(
    actionRecordIds: readonly string[],
  ): Promise<KnomosisReceiptRecord[]> {
    if (actionRecordIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(knomosisReceipts)
      .where(
        and(
          eq(knomosisReceipts.kind, 'public'),
          inArray(knomosisReceipts.actionRecordId, [...actionRecordIds]),
        ),
      );
    return rows.map(mapReceipt);
  }

  async listPrivateForUser(userId: string, limit: number): Promise<KnomosisReceiptRecord[]> {
    const rows = await this.db
      .select()
      .from(knomosisReceipts)
      .where(and(eq(knomosisReceipts.kind, 'private'), eq(knomosisReceipts.ownerUserId, userId)))
      .orderBy(desc(knomosisReceipts.createdAt))
      .limit(limit);
    return rows.map(mapReceipt);
  }

  async purgeByUser(userId: string): Promise<number> {
    // Private receipts only — public receipts carry no owner (ownerUserId null).
    const rows = await this.db
      .delete(knomosisReceipts)
      .where(and(eq(knomosisReceipts.kind, 'private'), eq(knomosisReceipts.ownerUserId, userId)))
      .returning({ id: knomosisReceipts.receiptId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.db.delete(knomosisReceipts);
  }
}

function mapReceipt(row: typeof knomosisReceipts.$inferSelect): KnomosisReceiptRecord {
  return {
    receiptId: row.receiptId,
    actionRecordId: row.actionRecordId,
    kind: row.kind,
    payload: row.payload as Record<string, unknown>,
    summaryPayloadHash: row.summaryPayloadHash,
    ownerUserId: row.ownerUserId,
    finalState: row.finalState,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleComprehensionStore implements ComprehensionStore {
  constructor(private readonly db: Db) {}

  async get(userId: string, quizVersion: string): Promise<ComprehensionResultRecord | null> {
    const rows = await this.db
      .select()
      .from(comprehensionResults)
      .where(
        and(
          eq(comprehensionResults.userId, userId),
          eq(comprehensionResults.quizVersion, quizVersion),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row
      ? {
          userId: row.userId,
          quizVersion: row.quizVersion,
          passed: row.passed,
          attempts: row.attempts,
          passedAt: isoOrNull(row.passedAt),
          updatedAt: iso(row.updatedAt),
        }
      : null;
  }

  async record(
    userId: string,
    quizVersion: string,
    passed: boolean,
    nowIso: string,
  ): Promise<ComprehensionResultRecord> {
    const now = new Date(nowIso);
    const passedAtValue = passed ? now : null;
    // MERGE in SQL against the CURRENT row rather than a stale pre-read snapshot: a
    // concurrent FAILING attempt must NOT downgrade a pass that committed between
    // this call's read and its write.  `passed` is monotonic (OR), `attempts`
    // increments the stored value, and `passed_at` keeps the FIRST pass time
    // (COALESCE) — so an already-passed steward never reverts to unpassed and gets
    // blocked from governance/readiness (WS-L.4.1e).
    await this.db
      .insert(comprehensionResults)
      .values({
        userId,
        quizVersion,
        passed,
        attempts: 1,
        passedAt: dateOrNull(passedAtValue?.toISOString() ?? null),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [comprehensionResults.userId, comprehensionResults.quizVersion],
        set: {
          passed: sql`${comprehensionResults.passed} OR ${passed}`,
          attempts: sql`${comprehensionResults.attempts} + 1`,
          passedAt: sql`coalesce(${comprehensionResults.passedAt}, ${passedAtValue})`,
          updatedAt: now,
        },
      });
    // Return the authoritative merged row (the SQL merge is the source of truth).
    const merged = await this.get(userId, quizVersion);
    return (
      merged ?? {
        userId,
        quizVersion,
        passed,
        attempts: 1,
        passedAt: passed ? nowIso : null,
        updatedAt: nowIso,
      }
    );
  }

  async listByUser(userId: string): Promise<ComprehensionResultRecord[]> {
    const rows = await this.db
      .select()
      .from(comprehensionResults)
      .where(eq(comprehensionResults.userId, userId));
    return rows.map((r) => ({
      userId: r.userId,
      quizVersion: r.quizVersion,
      passed: r.passed,
      attempts: r.attempts,
      passedAt: isoOrNull(r.passedAt),
      updatedAt: iso(r.updatedAt),
    }));
  }

  async purgeByUser(userId: string): Promise<number> {
    const rows = await this.db
      .delete(comprehensionResults)
      .where(eq(comprehensionResults.userId, userId))
      .returning({ userId: comprehensionResults.userId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.db.delete(comprehensionResults);
  }
}

// ---------------------------------------------------------------------------
// Bundle factory (boot convenience)
// ---------------------------------------------------------------------------

export interface DrizzleKnomosisStores {
  wallets: FinancialWalletStore;
  deployments: KnomosisDeploymentStore;
  actions: KnomosisActionStore;
  events: OnChainEventStore;
  nonces: ActionNonceStore;
  actorMappings: WalletActorMappingStore;
  proposals: GovernanceProposalStore;
  votes: ProposalVoteStore;
  proposalSignatures: GovernanceSignatureStore;
  simTreasury: SimTreasuryStore;
  governanceAudit: GovernanceAuditStore;
  reconciliation: ReconciliationStore;
  receipts: KnomosisReceiptStore;
  comprehension: ComprehensionStore;
}

export function createDrizzleKnomosisStores(db: Db): DrizzleKnomosisStores {
  return {
    wallets: new DrizzleFinancialWalletStore(db),
    deployments: new DrizzleKnomosisDeploymentStore(db),
    actions: new DrizzleKnomosisActionStore(db),
    events: new DrizzleOnChainEventStore(db),
    nonces: new DrizzleActionNonceStore(db),
    actorMappings: new DrizzleWalletActorMappingStore(db),
    proposals: new DrizzleGovernanceProposalStore(db),
    votes: new DrizzleProposalVoteStore(db),
    proposalSignatures: new DrizzleGovernanceSignatureStore(db),
    simTreasury: new DrizzleSimTreasuryStore(db),
    governanceAudit: new DrizzleGovernanceAuditStore(db),
    reconciliation: new DrizzleReconciliationStore(db),
    receipts: new DrizzleKnomosisReceiptStore(db),
    comprehension: new DrizzleComprehensionStore(db),
  };
}
