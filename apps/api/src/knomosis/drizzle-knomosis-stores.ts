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
  knomosisReceipts,
  onChainEvents,
  reconciliationResults,
  simTreasuries,
  simTreasuryEntries,
  walletAccounts,
  walletActorMappings,
} from '@licio/db';
import { and, asc, desc, eq, inArray, lte, max, ne, sql } from 'drizzle-orm';
import type { ActionNonceStore } from './services.js';
import type {
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
import { READINESS_QUALIFYING_AUDIT_ACTIONS } from './stores.js';

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

  async insert(record: FinancialWalletRecord): Promise<FinancialWalletRecord> {
    await this.db.insert(walletAccounts).values({
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
    });
    return record;
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

  async update(record: FinancialWalletRecord): Promise<FinancialWalletRecord> {
    await this.db
      .update(walletAccounts)
      .set({
        unlinkState: record.unlinkState,
        riskState: record.riskState,
        label: record.label,
        linkedAt: new Date(record.linkedAt),
        lastUsedAt: dateOrNull(record.lastUsedAt),
        unlinkRequestedAt: dateOrNull(record.unlinkRequestedAt),
        unlinkFinalizeAfter: dateOrNull(record.unlinkFinalizeAfter),
        unlinkedAt: dateOrNull(record.unlinkedAt),
      })
      .where(eq(walletAccounts.walletAccountId, record.walletAccountId));
    return record;
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
    submissionState: row.submissionState,
    failureReason: row.failureReason,
    indexedEventRef: row.indexedEventRef,
    reconciliationState: row.reconciliationState,
    idempotencyKey: row.idempotencyKey,
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
      submissionState: record.submissionState,
      failureReason: record.failureReason,
      indexedEventRef: record.indexedEventRef,
      reconciliationState: record.reconciliationState,
      idempotencyKey: record.idempotencyKey,
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

  async getByTypedDataHash(
    deploymentId: string,
    typedDataHash: string,
  ): Promise<KnomosisActionRecordEntity | null> {
    const rows = await this.db
      .select()
      .from(knomosisActionRecords)
      .where(
        and(
          eq(knomosisActionRecords.deploymentId, deploymentId),
          eq(knomosisActionRecords.typedDataHash, typedDataHash),
        ),
      )
      .limit(1);
    return rows[0] ? mapAction(rows[0]) : null;
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
          eq(knomosisActionRecords.reconciliationState, 'pending'),
        ),
      )
      .orderBy(asc(knomosisActionRecords.createdAt))
      .limit(limit);
    return rows.map(mapAction);
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

  async latestGatewaySeq(deploymentId: string): Promise<string | null> {
    const rows = await this.db
      .select({ latest: max(onChainEvents.gatewaySeq) })
      .from(onChainEvents)
      .where(eq(onChainEvents.deploymentId, deploymentId));
    const latest = rows[0]?.latest ?? null;
    return latest === null ? null : latest.toString();
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
      })
      .where(eq(governanceProposals.proposalId, record.proposalId));
    return record;
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

  async clear(): Promise<void> {
    await this.db.delete(governanceProposals);
  }
}

export class DrizzleProposalVoteStore implements ProposalVoteStore {
  constructor(private readonly db: Db) {}

  async cast(record: ProposalVoteRecord): Promise<ProposalVoteRecord | null> {
    const rows = await this.db
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

  async put(record: SimTreasuryRecord): Promise<SimTreasuryRecord> {
    await this.db
      .insert(simTreasuries)
      .values({
        roomId: record.roomId,
        balances: record.balances,
        updatedAt: new Date(record.updatedAt),
      })
      .onConflictDoUpdate({
        target: simTreasuries.roomId,
        set: { balances: record.balances, updatedAt: new Date(record.updatedAt) },
      });
    return record;
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
      createdAt: iso(row.createdAt),
    }));
  }

  async clear(): Promise<void> {
    await this.db.delete(simTreasuryEntries);
    await this.db.delete(simTreasuries);
  }
}

export class DrizzleGovernanceAuditStore implements GovernanceAuditStore {
  constructor(private readonly db: Db) {}

  async append(entry: GovernanceAuditRecord): Promise<GovernanceAuditRecord> {
    await this.db.insert(governanceAuditLogs).values({
      entryId: entry.entryId,
      roomId: entry.roomId,
      actionType: entry.actionType,
      actorUserId: entry.actorUserId,
      actionDetails: entry.actionDetails,
      simulationMode: entry.simulationMode,
      createdAt: new Date(entry.createdAt),
    });
    return entry;
  }

  async listByRoom(
    roomId: string,
    limit: number,
    beforeIso?: string,
  ): Promise<GovernanceAuditRecord[]> {
    const rows = await this.db
      .select()
      .from(governanceAuditLogs)
      .where(
        beforeIso === undefined
          ? eq(governanceAuditLogs.roomId, roomId)
          : and(
              eq(governanceAuditLogs.roomId, roomId),
              sql`${governanceAuditLogs.createdAt} < ${new Date(beforeIso)}`,
            ),
      )
      .orderBy(desc(governanceAuditLogs.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      entryId: row.entryId,
      roomId: row.roomId,
      actionType: row.actionType as GovernanceAuditRecord['actionType'],
      actorUserId: row.actorUserId,
      actionDetails: row.actionDetails as Record<string, unknown>,
      simulationMode: row.simulationMode,
      createdAt: iso(row.createdAt),
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
      .orderBy(desc(reconciliationResults.createdAt))
      .limit(1);
    const row = rows[0];
    return row ? mapReconciliation(row) : null;
  }

  async listUnresolvedMismatches(deploymentId: string): Promise<ReconciliationResultRecord[]> {
    // Latest result per entity via a window function; keep non-matches.
    const rows = await this.db.execute(sql`
      SELECT DISTINCT ON (entity_type, entity_ref) *
      FROM "knomosis"."knomosis_reconciliation_result"
      WHERE deployment_id = ${deploymentId}
      ORDER BY entity_type, entity_ref, created_at DESC
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
    const existing = await this.get(userId, quizVersion);
    const next: ComprehensionResultRecord = {
      userId,
      quizVersion,
      passed: (existing?.passed ?? false) || passed,
      attempts: (existing?.attempts ?? 0) + 1,
      passedAt: existing?.passedAt ?? (passed ? nowIso : null),
      updatedAt: nowIso,
    };
    await this.db
      .insert(comprehensionResults)
      .values({
        userId: next.userId,
        quizVersion: next.quizVersion,
        passed: next.passed,
        attempts: next.attempts,
        passedAt: dateOrNull(next.passedAt),
        updatedAt: new Date(next.updatedAt),
      })
      .onConflictDoUpdate({
        target: [comprehensionResults.userId, comprehensionResults.quizVersion],
        set: {
          passed: next.passed,
          attempts: next.attempts,
          passedAt: dateOrNull(next.passedAt),
          updatedAt: new Date(next.updatedAt),
        },
      });
    return next;
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
