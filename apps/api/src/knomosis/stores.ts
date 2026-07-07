// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L knomosis store interfaces + in-memory adapters (the house pattern):
// interfaces + in-memory adapters here; the gated Postgres adapters with the
// SAME surface live in `drizzle-knomosis-stores.ts`.  Every async method is a
// Promise so the Postgres drop-in is transparent.  All timestamps are ISO
// strings; monetary amounts are minor-unit decimal STRINGS (never floats).
//
// Isolation note (WS-D.3.2): these stores are the ONLY code that touches the
// wallet/knomosis bounded context — no method joins, embeds, or returns any
// ranking/attention value, and none accepts one.

import type {
  GovernanceAuditActionType,
  KnomosisEnvironment,
  KnomosisSignedActionType,
  ReconciliationState,
  SubmissionState,
  UnlinkState,
  WalletAccountType,
  WalletRiskState,
} from '@licio/shared';

type Clock = () => number;
const iso = (now: Clock): string => new Date(now()).toISOString();

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Financial wallet account (WS-D.3.1a / WS-L.2.5).  `addressHashHex` is the
 *  FINANCIAL-domain HMAC of the lowercased address (hex form; the Drizzle
 *  adapter stores bytea) — a full address never appears in any record. */
export interface FinancialWalletRecord {
  walletAccountId: string;
  userId: string;
  addressHashHex: string;
  addressTruncated: string;
  chainId: number;
  walletType: WalletAccountType;
  unlinkState: UnlinkState;
  riskState: WalletRiskState;
  label: string | null;
  linkedAt: string;
  lastUsedAt: string | null;
  unlinkRequestedAt: string | null;
  unlinkFinalizeAfter: string | null;
  unlinkedAt: string | null;
}

export interface KnomosisDeploymentRecord {
  deploymentId: string;
  environment: KnomosisEnvironment;
  chainId: number;
  l1BridgeAddress: string;
  runtimeEndpointRef: string;
  contractManifestHash: string;
  pinnedKnomosisCommit: string;
  status: 'provisioning' | 'active' | 'frozen' | 'retired';
  createdAt: string;
}

export interface KnomosisActionRecordEntity {
  actionRecordId: string;
  deploymentId: string;
  actionType: KnomosisSignedActionType;
  roomId: string;
  actorWalletAccountId: string;
  actorUserId: string;
  payloadHash: string;
  typedDataHash: string;
  /** The exact signed payload: typed-data message + signature (audit/forwarding). */
  signedAction: { message: Record<string, string>; signature: string };
  submissionState: SubmissionState;
  failureReason: string | null;
  indexedEventRef: string | null;
  reconciliationState: ReconciliationState;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnChainEventRecord {
  eventId: string;
  deploymentId: string;
  chainId: number;
  blockNumber: string | null; // decimal string (bigint-safe)
  txHash: string | null;
  logIndex: number | null;
  eventType: string;
  decodedPayload: Record<string, unknown>;
  eventSource: 'chain' | 'gateway';
  gatewaySeq: string | null; // decimal string
  gatewayIndex: number | null;
  reorgState: 'pending' | 'confirmed' | 'reorged';
  reorgDetectedAt: string | null;
  indexedAt: string;
}

export interface WalletActorMappingRecord {
  walletAccountId: string;
  deploymentId: string;
  actorId: string;
  createdAt: string;
}

export interface GovernanceProposalRecord {
  proposalId: string;
  roomId: string;
  proposerUserId: string;
  proposalType: 'charter_update' | 'bounty' | 'capped_grant';
  title: string;
  plainLanguageSummary: string;
  requestedAmount: string | null;
  asset: string | null;
  recipientRef: string | null;
  conflictDisclosures: string | null;
  riskAssessment: string;
  requestedAction: Record<string, unknown>;
  expectedDeliverable: string;
  preflightState: 'pending' | 'passed' | 'failed';
  votingState: 'open' | 'passed' | 'rejected' | 'quorum_not_met';
  challengeState: 'none' | 'open' | 'upheld' | 'dismissed';
  executionState: 'not_executed' | 'timelocked' | 'executed' | 'blocked';
  simulationMode: boolean;
  executableAfter: string | null;
  createdAt: string;
  executedAt: string | null;
}

export type ProposalVoteChoice = 'approve' | 'reject' | 'abstain';

export interface ProposalVoteRecord {
  proposalId: string;
  voterUserId: string;
  choice: ProposalVoteChoice;
  castAt: string;
}

export interface GovernanceSignatureRecord {
  signatureId: string;
  proposalId: string;
  userId: string;
  walletAccountId: string;
  signatureType: 'eip712_ecdsa' | 'eip712_eip1271';
  typedDataHash: string;
  signatureRef: string;
  weightSnapshot: string | null;
  eligibilityReason: string;
  createdAt: string;
}

export interface SimTreasuryRecord {
  roomId: string;
  /** asset (SIM-*) → minor-unit amount string; never negative. */
  balances: Record<string, string>;
  updatedAt: string;
}

export interface SimTreasuryEntryRecord {
  entryId: string;
  roomId: string;
  kind: 'deposit' | 'grant_execution';
  asset: string;
  amount: string;
  actorUserId: string | null;
  proposalId: string | null;
  createdAt: string;
}

export interface GovernanceAuditRecord {
  entryId: string;
  roomId: string;
  actionType: GovernanceAuditActionType;
  actorUserId: string | null;
  actionDetails: Record<string, unknown>;
  simulationMode: boolean;
  createdAt: string;
}

export interface ReconciliationResultRecord {
  resultId: string;
  deploymentId: string;
  entityType: 'treasury' | 'proposal' | 'grant' | 'action';
  entityRef: string;
  outcome: 'match' | 'mismatch' | 'halted_unsupported_version';
  severity: 'informational' | 'warning' | 'critical' | null;
  details: Record<string, unknown>;
  lowWatermarkSeq: string | null;
  createdAt: string;
}

export interface KnomosisReceiptRecord {
  receiptId: string;
  actionRecordId: string;
  kind: 'public' | 'private';
  payload: Record<string, unknown>;
  summaryPayloadHash: string;
  ownerUserId: string | null;
  finalState: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComprehensionResultRecord {
  userId: string;
  quizVersion: string;
  passed: boolean;
  attempts: number;
  passedAt: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Store interfaces (every method a Promise; test-only clear())
// ---------------------------------------------------------------------------

export interface FinancialWalletStore {
  insert(record: FinancialWalletRecord): Promise<FinancialWalletRecord>;
  getById(walletAccountId: string): Promise<FinancialWalletRecord | null>;
  getByAddressHash(addressHashHex: string): Promise<FinancialWalletRecord | null>;
  listByUser(userId: string, includeUnlinked: boolean): Promise<FinancialWalletRecord[]>;
  update(record: FinancialWalletRecord): Promise<FinancialWalletRecord>;
  /** Wallets whose cooling-off elapsed (unlink finalization sweep, WS-L.2.5b). */
  listPendingFinalization(nowIso: string): Promise<FinancialWalletRecord[]>;
  clear(): Promise<void>;
}

export interface KnomosisDeploymentStore {
  /** Reviewed config-sync ONLY (WS-L.1.1a-1); never a user-facing API. */
  upsert(record: KnomosisDeploymentRecord): Promise<KnomosisDeploymentRecord>;
  getById(deploymentId: string): Promise<KnomosisDeploymentRecord | null>;
  list(): Promise<KnomosisDeploymentRecord[]>;
  clear(): Promise<void>;
}

export interface KnomosisActionStore {
  insert(record: KnomosisActionRecordEntity): Promise<KnomosisActionRecordEntity>;
  getById(actionRecordId: string): Promise<KnomosisActionRecordEntity | null>;
  getByIdempotencyKey(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<KnomosisActionRecordEntity | null>;
  update(record: KnomosisActionRecordEntity): Promise<KnomosisActionRecordEntity>;
  listByRoom(roomId: string, limit: number): Promise<KnomosisActionRecordEntity[]>;
  /** Event-stream lookup: the action a gateway event refers to (WS-L.3.3a). */
  getByTypedDataHash(
    deploymentId: string,
    typedDataHash: string,
  ): Promise<KnomosisActionRecordEntity | null>;
  /** Actions not yet in a terminal reconciliation outcome, oldest first. */
  listUnreconciled(deploymentId: string, limit: number): Promise<KnomosisActionRecordEntity[]>;
  /** Pending obligations for the unlink check (WS-L.2.5b): non-terminal actions
   *  signed by this wallet. */
  listOpenByWallet(walletAccountId: string): Promise<KnomosisActionRecordEntity[]>;
  clear(): Promise<void>;
}

export interface OnChainEventStore {
  /** Idempotent insert keyed by the per-source unique key; returns the stored
   *  record (existing on replay — no drop, no duplicate). */
  ingest(record: OnChainEventRecord): Promise<{ record: OnChainEventRecord; inserted: boolean }>;
  getById(eventId: string): Promise<OnChainEventRecord | null>;
  listByDeployment(deploymentId: string, limit: number): Promise<OnChainEventRecord[]>;
  /** The highest ingested gateway seq for a deployment (cursor resume). */
  latestGatewaySeq(deploymentId: string): Promise<string | null>;
  markReorged(eventIds: readonly string[], detectedAtIso: string): Promise<void>;
  markConfirmed(eventIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface WalletActorMappingStore {
  get(walletAccountId: string, deploymentId: string): Promise<WalletActorMappingRecord | null>;
  put(record: WalletActorMappingRecord): Promise<WalletActorMappingRecord>;
  clear(): Promise<void>;
}

export interface GovernanceProposalStore {
  insert(record: GovernanceProposalRecord): Promise<GovernanceProposalRecord>;
  getById(proposalId: string): Promise<GovernanceProposalRecord | null>;
  listByRoom(roomId: string, limit: number): Promise<GovernanceProposalRecord[]>;
  update(record: GovernanceProposalRecord): Promise<GovernanceProposalRecord>;
  /** Timelocked proposals whose executableAfter elapsed (simulated execution). */
  listExecutable(nowIso: string): Promise<GovernanceProposalRecord[]>;
  /** Open proposals in a room of a given type (policy-conflict check). */
  listOpenByRoomAndType(
    roomId: string,
    proposalType: GovernanceProposalRecord['proposalType'],
  ): Promise<GovernanceProposalRecord[]>;
  clear(): Promise<void>;
}

export interface ProposalVoteStore {
  /** Insert-once per (proposal, voter); returns null when already voted. */
  cast(record: ProposalVoteRecord): Promise<ProposalVoteRecord | null>;
  tally(proposalId: string): Promise<{ approve: number; reject: number; abstain: number }>;
  clear(): Promise<void>;
}

export interface GovernanceSignatureStore {
  /** Insert-once per (proposal, wallet); returns null on duplicate. */
  insert(record: GovernanceSignatureRecord): Promise<GovernanceSignatureRecord | null>;
  listByProposal(proposalId: string): Promise<GovernanceSignatureRecord[]>;
  /** Signatures by this wallet on proposals that are still open (obligations). */
  listOpenByWallet(walletAccountId: string): Promise<GovernanceSignatureRecord[]>;
  clear(): Promise<void>;
}

export interface SimTreasuryStore {
  get(roomId: string): Promise<SimTreasuryRecord | null>;
  put(record: SimTreasuryRecord): Promise<SimTreasuryRecord>;
  appendEntry(entry: SimTreasuryEntryRecord): Promise<SimTreasuryEntryRecord>;
  listEntries(roomId: string, limit: number): Promise<SimTreasuryEntryRecord[]>;
  clear(): Promise<void>;
}

/** Append-only (WS-L.4.1f): no update/delete surface exists on the interface. */
export interface GovernanceAuditStore {
  append(entry: GovernanceAuditRecord): Promise<GovernanceAuditRecord>;
  listByRoom(roomId: string, limit: number, beforeIso?: string): Promise<GovernanceAuditRecord[]>;
  countByRoom(roomId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface ReconciliationStore {
  append(result: ReconciliationResultRecord): Promise<ReconciliationResultRecord>;
  latestForEntity(
    entityType: ReconciliationResultRecord['entityType'],
    entityRef: string,
  ): Promise<ReconciliationResultRecord | null>;
  /** Unexplained divergences (latest result per entity is a mismatch). */
  listUnresolvedMismatches(deploymentId: string): Promise<ReconciliationResultRecord[]>;
  clear(): Promise<void>;
}

export interface KnomosisReceiptStore {
  /** Upsert by (actionRecordId, kind) — receipts UPDATE when a reorg flips
   *  the final state (WS-L.3.4c). */
  upsert(record: KnomosisReceiptRecord): Promise<KnomosisReceiptRecord>;
  getByAction(
    actionRecordId: string,
    kind: 'public' | 'private',
  ): Promise<KnomosisReceiptRecord | null>;
  listPublicByRoomActions(actionRecordIds: readonly string[]): Promise<KnomosisReceiptRecord[]>;
  listPrivateForUser(userId: string, limit: number): Promise<KnomosisReceiptRecord[]>;
  clear(): Promise<void>;
}

export interface ComprehensionStore {
  get(userId: string, quizVersion: string): Promise<ComprehensionResultRecord | null>;
  record(
    userId: string,
    quizVersion: string,
    passed: boolean,
    nowIso: string,
  ): Promise<ComprehensionResultRecord>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory adapters (Map-backed, injected clock, defensive copies)
// ---------------------------------------------------------------------------

export class InMemoryFinancialWalletStore implements FinancialWalletStore {
  readonly #rows = new Map<string, FinancialWalletRecord>();

  async insert(record: FinancialWalletRecord): Promise<FinancialWalletRecord> {
    for (const existing of this.#rows.values()) {
      if (existing.addressHashHex === record.addressHashHex) {
        throw new Error('wallet address already linked');
      }
    }
    this.#rows.set(record.walletAccountId, { ...record });
    return { ...record };
  }

  async getById(walletAccountId: string): Promise<FinancialWalletRecord | null> {
    const row = this.#rows.get(walletAccountId);
    return row ? { ...row } : null;
  }

  async getByAddressHash(addressHashHex: string): Promise<FinancialWalletRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.addressHashHex === addressHashHex) return { ...row };
    }
    return null;
  }

  async listByUser(userId: string, includeUnlinked: boolean): Promise<FinancialWalletRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.userId === userId && (includeUnlinked || r.unlinkState !== 'finalized'))
      .sort((a, b) => a.linkedAt.localeCompare(b.linkedAt))
      .map((r) => ({ ...r }));
  }

  async update(record: FinancialWalletRecord): Promise<FinancialWalletRecord> {
    if (!this.#rows.has(record.walletAccountId)) throw new Error('wallet not found');
    this.#rows.set(record.walletAccountId, { ...record });
    return { ...record };
  }

  async listPendingFinalization(nowIso: string): Promise<FinancialWalletRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.unlinkState === 'pending_unlink' &&
          r.unlinkFinalizeAfter !== null &&
          r.unlinkFinalizeAfter <= nowIso,
      )
      .map((r) => ({ ...r }));
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryKnomosisDeploymentStore implements KnomosisDeploymentStore {
  readonly #rows = new Map<string, KnomosisDeploymentRecord>();

  async upsert(record: KnomosisDeploymentRecord): Promise<KnomosisDeploymentRecord> {
    this.#rows.set(record.deploymentId, { ...record });
    return { ...record };
  }

  async getById(deploymentId: string): Promise<KnomosisDeploymentRecord | null> {
    const row = this.#rows.get(deploymentId);
    return row ? { ...row } : null;
  }

  async list(): Promise<KnomosisDeploymentRecord[]> {
    return [...this.#rows.values()].map((r) => ({ ...r }));
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

const TERMINAL_SUBMISSION_STATES: ReadonlySet<SubmissionState> = new Set([
  'finalized',
  'reverted',
  'failed',
]);

export class InMemoryKnomosisActionStore implements KnomosisActionStore {
  readonly #rows = new Map<string, KnomosisActionRecordEntity>();

  async insert(record: KnomosisActionRecordEntity): Promise<KnomosisActionRecordEntity> {
    for (const existing of this.#rows.values()) {
      if (
        existing.actorUserId === record.actorUserId &&
        existing.idempotencyKey === record.idempotencyKey
      ) {
        throw new Error('idempotency key already used');
      }
    }
    this.#rows.set(record.actionRecordId, structuredClone(record));
    return structuredClone(record);
  }

  async getById(actionRecordId: string): Promise<KnomosisActionRecordEntity | null> {
    const row = this.#rows.get(actionRecordId);
    return row ? structuredClone(row) : null;
  }

  async getByIdempotencyKey(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<KnomosisActionRecordEntity | null> {
    for (const row of this.#rows.values()) {
      if (row.actorUserId === actorUserId && row.idempotencyKey === idempotencyKey) {
        return structuredClone(row);
      }
    }
    return null;
  }

  async update(record: KnomosisActionRecordEntity): Promise<KnomosisActionRecordEntity> {
    if (!this.#rows.has(record.actionRecordId)) throw new Error('action record not found');
    this.#rows.set(record.actionRecordId, structuredClone(record));
    return structuredClone(record);
  }

  async listByRoom(roomId: string, limit: number): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter((r) => r.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async getByTypedDataHash(
    deploymentId: string,
    typedDataHash: string,
  ): Promise<KnomosisActionRecordEntity | null> {
    for (const row of this.#rows.values()) {
      if (row.deploymentId === deploymentId && row.typedDataHash === typedDataHash) {
        return structuredClone(row);
      }
    }
    return null;
  }

  async listUnreconciled(
    deploymentId: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter((r) => r.deploymentId === deploymentId && r.reconciliationState === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async listOpenByWallet(walletAccountId: string): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.actorWalletAccountId === walletAccountId &&
          !TERMINAL_SUBMISSION_STATES.has(r.submissionState),
      )
      .map((r) => structuredClone(r));
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryOnChainEventStore implements OnChainEventStore {
  readonly #rows = new Map<string, OnChainEventRecord>();

  #sourceKey(record: OnChainEventRecord): string {
    return record.eventSource === 'chain'
      ? `chain:${record.deploymentId}:${record.txHash}:${record.logIndex}`
      : `gateway:${record.deploymentId}:${record.gatewaySeq}:${record.gatewayIndex}`;
  }

  async ingest(
    record: OnChainEventRecord,
  ): Promise<{ record: OnChainEventRecord; inserted: boolean }> {
    const key = this.#sourceKey(record);
    for (const row of this.#rows.values()) {
      if (this.#sourceKey(row) === key) return { record: structuredClone(row), inserted: false };
    }
    this.#rows.set(record.eventId, structuredClone(record));
    return { record: structuredClone(record), inserted: true };
  }

  async getById(eventId: string): Promise<OnChainEventRecord | null> {
    const row = this.#rows.get(eventId);
    return row ? structuredClone(row) : null;
  }

  async listByDeployment(deploymentId: string, limit: number): Promise<OnChainEventRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.deploymentId === deploymentId)
      .sort((a, b) => {
        const seqA = BigInt(a.gatewaySeq ?? a.blockNumber ?? '0');
        const seqB = BigInt(b.gatewaySeq ?? b.blockNumber ?? '0');
        if (seqA !== seqB) return seqA < seqB ? -1 : 1;
        return (a.gatewayIndex ?? a.logIndex ?? 0) - (b.gatewayIndex ?? b.logIndex ?? 0);
      })
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async latestGatewaySeq(deploymentId: string): Promise<string | null> {
    let latest: bigint | null = null;
    for (const row of this.#rows.values()) {
      if (row.deploymentId !== deploymentId || row.gatewaySeq === null) continue;
      const seq = BigInt(row.gatewaySeq);
      if (latest === null || seq > latest) latest = seq;
    }
    return latest === null ? null : latest.toString();
  }

  async markReorged(eventIds: readonly string[], detectedAtIso: string): Promise<void> {
    for (const id of eventIds) {
      const row = this.#rows.get(id);
      if (row) {
        row.reorgState = 'reorged';
        row.reorgDetectedAt = detectedAtIso;
      }
    }
  }

  async markConfirmed(eventIds: readonly string[]): Promise<void> {
    for (const id of eventIds) {
      const row = this.#rows.get(id);
      if (row && row.reorgState === 'pending') row.reorgState = 'confirmed';
    }
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryWalletActorMappingStore implements WalletActorMappingStore {
  readonly #rows = new Map<string, WalletActorMappingRecord>();

  async get(
    walletAccountId: string,
    deploymentId: string,
  ): Promise<WalletActorMappingRecord | null> {
    const row = this.#rows.get(`${walletAccountId}:${deploymentId}`);
    return row ? { ...row } : null;
  }

  async put(record: WalletActorMappingRecord): Promise<WalletActorMappingRecord> {
    this.#rows.set(`${record.walletAccountId}:${record.deploymentId}`, { ...record });
    return { ...record };
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryGovernanceProposalStore implements GovernanceProposalStore {
  readonly #rows = new Map<string, GovernanceProposalRecord>();

  async insert(record: GovernanceProposalRecord): Promise<GovernanceProposalRecord> {
    this.#rows.set(record.proposalId, structuredClone(record));
    return structuredClone(record);
  }

  async getById(proposalId: string): Promise<GovernanceProposalRecord | null> {
    const row = this.#rows.get(proposalId);
    return row ? structuredClone(row) : null;
  }

  async listByRoom(roomId: string, limit: number): Promise<GovernanceProposalRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async update(record: GovernanceProposalRecord): Promise<GovernanceProposalRecord> {
    if (!this.#rows.has(record.proposalId)) throw new Error('proposal not found');
    this.#rows.set(record.proposalId, structuredClone(record));
    return structuredClone(record);
  }

  async listExecutable(nowIso: string): Promise<GovernanceProposalRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.executionState === 'timelocked' &&
          r.executableAfter !== null &&
          r.executableAfter <= nowIso,
      )
      .map((r) => structuredClone(r));
  }

  async listOpenByRoomAndType(
    roomId: string,
    proposalType: GovernanceProposalRecord['proposalType'],
  ): Promise<GovernanceProposalRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) => r.roomId === roomId && r.proposalType === proposalType && r.votingState === 'open',
      )
      .map((r) => structuredClone(r));
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryProposalVoteStore implements ProposalVoteStore {
  readonly #rows = new Map<string, ProposalVoteRecord>();

  async cast(record: ProposalVoteRecord): Promise<ProposalVoteRecord | null> {
    const key = `${record.proposalId}:${record.voterUserId}`;
    if (this.#rows.has(key)) return null;
    this.#rows.set(key, { ...record });
    return { ...record };
  }

  async tally(proposalId: string): Promise<{ approve: number; reject: number; abstain: number }> {
    const tally = { approve: 0, reject: 0, abstain: 0 };
    for (const row of this.#rows.values()) {
      if (row.proposalId === proposalId) tally[row.choice] += 1;
    }
    return tally;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryGovernanceSignatureStore implements GovernanceSignatureStore {
  readonly #rows = new Map<string, GovernanceSignatureRecord>();
  readonly #proposals: GovernanceProposalStore;

  constructor(proposals: GovernanceProposalStore) {
    this.#proposals = proposals;
  }

  async insert(record: GovernanceSignatureRecord): Promise<GovernanceSignatureRecord | null> {
    const key = `${record.proposalId}:${record.walletAccountId}`;
    for (const row of this.#rows.values()) {
      if (`${row.proposalId}:${row.walletAccountId}` === key) return null;
    }
    this.#rows.set(record.signatureId, { ...record });
    return { ...record };
  }

  async listByProposal(proposalId: string): Promise<GovernanceSignatureRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.proposalId === proposalId)
      .map((r) => ({ ...r }));
  }

  async listOpenByWallet(walletAccountId: string): Promise<GovernanceSignatureRecord[]> {
    const open: GovernanceSignatureRecord[] = [];
    for (const row of this.#rows.values()) {
      if (row.walletAccountId !== walletAccountId) continue;
      const proposal = await this.#proposals.getById(row.proposalId);
      if (proposal && proposal.votingState === 'open') open.push({ ...row });
    }
    return open;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemorySimTreasuryStore implements SimTreasuryStore {
  readonly #treasuries = new Map<string, SimTreasuryRecord>();
  readonly #entries: SimTreasuryEntryRecord[] = [];

  async get(roomId: string): Promise<SimTreasuryRecord | null> {
    const row = this.#treasuries.get(roomId);
    return row ? structuredClone(row) : null;
  }

  async put(record: SimTreasuryRecord): Promise<SimTreasuryRecord> {
    this.#treasuries.set(record.roomId, structuredClone(record));
    return structuredClone(record);
  }

  async appendEntry(entry: SimTreasuryEntryRecord): Promise<SimTreasuryEntryRecord> {
    this.#entries.push({ ...entry });
    return { ...entry };
  }

  async listEntries(roomId: string, limit: number): Promise<SimTreasuryEntryRecord[]> {
    return this.#entries
      .filter((e) => e.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async clear(): Promise<void> {
    this.#treasuries.clear();
    this.#entries.length = 0;
  }
}

export class InMemoryGovernanceAuditStore implements GovernanceAuditStore {
  readonly #rows: GovernanceAuditRecord[] = [];

  async append(entry: GovernanceAuditRecord): Promise<GovernanceAuditRecord> {
    // Append-only by construction: the array is never mutated except push.
    this.#rows.push(structuredClone(entry));
    return structuredClone(entry);
  }

  async listByRoom(
    roomId: string,
    limit: number,
    beforeIso?: string,
  ): Promise<GovernanceAuditRecord[]> {
    return this.#rows
      .filter((r) => r.roomId === roomId && (beforeIso === undefined || r.createdAt < beforeIso))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async countByRoom(roomId: string): Promise<number> {
    return this.#rows.filter((r) => r.roomId === roomId).length;
  }

  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

export class InMemoryReconciliationStore implements ReconciliationStore {
  readonly #rows: ReconciliationResultRecord[] = [];

  async append(result: ReconciliationResultRecord): Promise<ReconciliationResultRecord> {
    this.#rows.push(structuredClone(result));
    return structuredClone(result);
  }

  async latestForEntity(
    entityType: ReconciliationResultRecord['entityType'],
    entityRef: string,
  ): Promise<ReconciliationResultRecord | null> {
    const matches = this.#rows
      .filter((r) => r.entityType === entityType && r.entityRef === entityRef)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = matches[0];
    return latest ? structuredClone(latest) : null;
  }

  async listUnresolvedMismatches(deploymentId: string): Promise<ReconciliationResultRecord[]> {
    const latestByEntity = new Map<string, ReconciliationResultRecord>();
    for (const row of this.#rows) {
      if (row.deploymentId !== deploymentId) continue;
      const key = `${row.entityType}:${row.entityRef}`;
      const existing = latestByEntity.get(key);
      if (!existing || row.createdAt > existing.createdAt) latestByEntity.set(key, row);
    }
    return [...latestByEntity.values()]
      .filter((r) => r.outcome !== 'match')
      .map((r) => structuredClone(r));
  }

  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

export class InMemoryKnomosisReceiptStore implements KnomosisReceiptStore {
  readonly #rows = new Map<string, KnomosisReceiptRecord>();

  async upsert(record: KnomosisReceiptRecord): Promise<KnomosisReceiptRecord> {
    const key = `${record.actionRecordId}:${record.kind}`;
    const existing = [...this.#rows.entries()].find(
      ([, r]) => `${r.actionRecordId}:${r.kind}` === key,
    );
    if (existing) {
      const updated = { ...record, receiptId: existing[1].receiptId };
      this.#rows.set(existing[0], structuredClone(updated));
      return structuredClone(updated);
    }
    this.#rows.set(record.receiptId, structuredClone(record));
    return structuredClone(record);
  }

  async getByAction(
    actionRecordId: string,
    kind: 'public' | 'private',
  ): Promise<KnomosisReceiptRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.actionRecordId === actionRecordId && row.kind === kind) {
        return structuredClone(row);
      }
    }
    return null;
  }

  async listPublicByRoomActions(
    actionRecordIds: readonly string[],
  ): Promise<KnomosisReceiptRecord[]> {
    const wanted = new Set(actionRecordIds);
    return [...this.#rows.values()]
      .filter((r) => r.kind === 'public' && wanted.has(r.actionRecordId))
      .map((r) => structuredClone(r));
  }

  async listPrivateForUser(userId: string, limit: number): Promise<KnomosisReceiptRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.kind === 'private' && r.ownerUserId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryComprehensionStore implements ComprehensionStore {
  readonly #rows = new Map<string, ComprehensionResultRecord>();

  async get(userId: string, quizVersion: string): Promise<ComprehensionResultRecord | null> {
    const row = this.#rows.get(`${userId}:${quizVersion}`);
    return row ? { ...row } : null;
  }

  async record(
    userId: string,
    quizVersion: string,
    passed: boolean,
    nowIso: string,
  ): Promise<ComprehensionResultRecord> {
    const key = `${userId}:${quizVersion}`;
    const existing = this.#rows.get(key);
    const next: ComprehensionResultRecord = {
      userId,
      quizVersion,
      // A pass is durable: retakes never revoke it (WS-L.4.1e).
      passed: (existing?.passed ?? false) || passed,
      attempts: (existing?.attempts ?? 0) + 1,
      passedAt: existing?.passedAt ?? (passed ? nowIso : null),
      updatedAt: nowIso,
    };
    this.#rows.set(key, next);
    return { ...next };
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// In-process wallet abuse limiter (WS-L.2.5d).  Sliding windows keyed by a
// non-reversible account ref (NEVER a network address, §19.1).  Ephemeral by
// design — the durable backstops are the DB-visible cooldown timestamps.
// ---------------------------------------------------------------------------

export class WalletAbuseLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  /** Record + check one attempt; false ⇒ over the limit (reject). */
  hit(key: string, limit: number, windowMs: number): boolean {
    const now = this.#now();
    const kept = (this.#hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (kept.length >= limit) {
      this.#hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.#hits.set(key, kept);
    return true;
  }

  clear(): void {
    this.#hits.clear();
  }
}

export type { Clock };
export { iso as isoFromClock };
