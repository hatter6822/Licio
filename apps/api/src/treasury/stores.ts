// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M treasury-and-governance store interfaces + in-memory adapters (the
// house pattern): interfaces + in-memory adapters here; the gated Postgres
// adapters with the SAME surface live in `drizzle-treasury-stores.ts`.  Every
// async method is a Promise so the Postgres drop-in is transparent.  All
// timestamps are ISO strings; monetary amounts are minor-unit decimal STRINGS
// (never floats — compared with @licio/governance exact decimal math).
//
// Isolation note (WS-D.3.2): these stores are the ONLY code that touches the
// WS-M tables of the knomosis bounded context — no method joins, embeds, or
// returns any ranking/attention value, and none accepts one.
//
// Concurrency invariants mirrored from migration 0082 (the in-memory adapters
// EMULATE the database's unique indexes so tests exercise identical semantics):
//  - one reservation per proposal;
//  - one payment intent per (user, room, idempotency key);
//  - one ACTIVE delegation per (room, delegator, scope key);
//  - one treasury per room; globally unique treasury addresses;
//  - one grant per approving proposal;
//  - one charter version number per room.

import type {
  CharterSections,
  PauseFlags,
  PaymentIntentState,
  PaymentTargetType,
  ProposalChallengeState,
  ProposalChallengeType,
  ReconciliationSnapshotResult,
} from '@licio/shared';

const clone = <T>(value: T): T => structuredClone(value);

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface GovernanceProfileRecord {
  roomId: string;
  lawPackId: string | null;
  charterVersionId: string | null;
  treasuryId: string | null;
  quorumPolicyRef: Record<string, unknown> | null;
  thresholdPolicyRef: Record<string, unknown> | null;
  timelockPolicyRef: Record<string, unknown> | null;
  freezeState: 'active' | 'frozen';
  freezeReason: string | null;
  pauseFlags: PauseFlags;
  updatedAt: string;
}

export interface CharterVersionRecord {
  charterVersionId: string;
  roomId: string;
  version: number;
  sections: CharterSections;
  /** 0x-prefixed SHA-256 over the canonical sections. */
  contentHash: string;
  createdByUserId: string | null;
  createdAt: string;
}

export interface TreasuryRecord {
  treasuryId: string;
  roomId: string;
  deploymentId: string;
  treasuryAddress: string;
  acceptedAssets: string[];
  /** asset → minor-unit string; from the LAST RECONCILED snapshot only. */
  balanceSnapshot: Record<string, string> | null;
  balancesReconciledAt: string | null;
  depositLimits: {
    perUserPerPeriod: string;
    perRoomPerPeriod: string;
    perDepositMax: string;
    periodSeconds: number;
  };
  freezeState: 'active' | 'frozen';
  freezeReason: string | null;
  pauseFlags: PauseFlags;
  reconciliationState: 'synced' | 'pending' | 'divergent';
  createdAt: string;
}

export type ReservationState = 'reserved' | 'consumed' | 'released';

export interface ReservationRecord {
  reservationId: string;
  treasuryId: string;
  proposalId: string;
  category: string;
  asset: string;
  amount: string;
  state: ReservationState;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentIntentRecord {
  paymentIntentId: string;
  userId: string | null;
  roomId: string;
  treasuryId: string;
  targetType: PaymentTargetType;
  targetId: string;
  asset: string;
  amount: string;
  jurisdictionState: 'allowed' | 'restricted' | 'blocked';
  complianceState: 'pending' | 'cleared' | 'flagged' | 'blocked';
  executionState: PaymentIntentState;
  retryCount: number;
  quoteRef: Record<string, unknown> | null;
  actionRecordId: string | null;
  receiptId: string | null;
  idempotencyKey: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface GrantMilestoneRecord {
  milestoneId: string;
  description: string;
  amount: string;
  state: 'none' | 'pending' | 'in_progress' | 'submitted' | 'accepted' | 'rejected';
  paymentIntentId: string | null;
}

export interface GrantRecord {
  grantId: string;
  roomId: string;
  treasuryId: string;
  proposalId: string;
  recipientRef: string;
  purpose: string;
  amount: string;
  asset: string;
  milestones: GrantMilestoneRecord[];
  milestoneState: GrantMilestoneRecord['state'];
  reviewState: 'pending' | 'independent_review' | 'cleared' | 'flagged';
  payoutState: 'not_started' | 'scheduled' | 'partially_paid' | 'paid' | 'clawed_back';
  auditSummary: string | null;
  createdAt: string;
}

export interface ActionBudgetRecord {
  budgetId: string;
  roomId: string;
  /** `user:<uuid>` or `workflow:<name>`. */
  actorKey: string;
  availableUnits: number;
  lastRefillAt: string;
  rateLimitState: Record<string, unknown> | null;
  updatedAt: string;
}

export interface DelegationRecordEntity {
  delegationId: string;
  roomId: string;
  delegatorUserId: string | null;
  delegateUserId: string | null;
  scope: { all: true } | { proposal_type: string };
  /** `all` | `type:<proposalType>` — backs the active-uniqueness. */
  scopeKey: string;
  state: 'active' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
}

export interface ChallengeRecord {
  challengeId: string;
  proposalId: string;
  challengerUserId: string | null;
  challengeType: ProposalChallengeType;
  description: string;
  evidenceRefs: string[];
  state: ProposalChallengeState;
  resolutionNote: string | null;
  resolvedByUserId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SnapshotRecord {
  snapshotId: string;
  treasuryId: string;
  asset: string;
  productLedgerBalance: string;
  receiptsBalance: string;
  onchainObservedBalance: string;
  gap: string;
  explanation: Record<string, unknown> | null;
  result: ReconciliationSnapshotResult;
  observedAt: string;
}

export interface AttestationRecord {
  roomId: string;
  item: 'safety_override_acknowledged' | 'external_audit_passed';
  attestedByUserId: string | null;
  note: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Store interfaces
// ---------------------------------------------------------------------------

export interface GovernanceProfileStore {
  get(roomId: string): Promise<GovernanceProfileRecord | null>;
  upsert(record: GovernanceProfileRecord): Promise<GovernanceProfileRecord>;
  /** Every governed room (the scheduler's sweep population). */
  listAll(): Promise<GovernanceProfileRecord[]>;
  clear(): Promise<void>;
}

export interface CharterStore {
  latestByRoom(roomId: string): Promise<CharterVersionRecord | null>;
  getById(charterVersionId: string): Promise<CharterVersionRecord | null>;
  /** Returns null on a (room, version) collision — the caller retries with a
   *  re-read version number (mirrors the unique index). */
  insert(record: CharterVersionRecord): Promise<CharterVersionRecord | null>;
  listByRoom(roomId: string): Promise<CharterVersionRecord[]>;
  clear(): Promise<void>;
}

export interface TreasuryStore {
  getById(treasuryId: string): Promise<TreasuryRecord | null>;
  getByRoom(roomId: string): Promise<TreasuryRecord | null>;
  /** Returns null when the room already has a treasury OR the address is
   *  taken (mirrors both unique indexes). */
  insert(record: TreasuryRecord): Promise<TreasuryRecord | null>;
  /** Column-scoped updates (never whole-record clobbering). */
  setFreeze(
    treasuryId: string,
    state: 'active' | 'frozen',
    reason: string | null,
  ): Promise<boolean>;
  setPauseFlags(treasuryId: string, flags: PauseFlags): Promise<boolean>;
  /** A null snapshot PRESERVES the last-reconciled balances (a divergent or
   *  pending tick must never blank the dashboard's last-reconciled view). */
  setReconciliation(
    treasuryId: string,
    state: TreasuryRecord['reconciliationState'],
    balanceSnapshot: Record<string, string> | null,
    reconciledAt: string | null,
  ): Promise<boolean>;
  listAll(): Promise<TreasuryRecord[]>;
  clear(): Promise<void>;
}

export interface ReservationStore {
  getByProposal(proposalId: string): Promise<ReservationRecord | null>;
  /** Returns null when the proposal already holds a reservation. */
  insert(record: ReservationRecord): Promise<ReservationRecord | null>;
  /** CAS state transition — false when the stored state ≠ `from`. */
  transition(
    reservationId: string,
    from: ReservationState,
    to: ReservationState,
    updatedAt: string,
  ): Promise<boolean>;
  /** OPEN (`reserved`) reservations only — headroom subtracts these AND the
   *  consumed window separately, so the two projections must stay disjoint
   *  (a non-released union here would double-count every consumed row). */
  listActiveByTreasury(treasuryId: string, category: string): Promise<ReservationRecord[]>;
  /** OPEN reservations per ASSET across every category — the liquidity check
   *  a new spend proposal subtracts from the reconciled balance. */
  listActiveByTreasuryAsset(treasuryId: string, asset: string): Promise<ReservationRecord[]>;
  listConsumedByTreasury(treasuryId: string, category: string): Promise<ReservationRecord[]>;
  clear(): Promise<void>;
}

export interface PaymentIntentStore {
  getById(paymentIntentId: string): Promise<PaymentIntentRecord | null>;
  findByIdempotencyKey(
    userId: string,
    roomId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntentRecord | null>;
  /** Returns the EXISTING intent on an idempotency-key collision (WS-M.3.1c:
   *  the key row and the intent are one write — the unique index is the record). */
  insert(record: PaymentIntentRecord): Promise<PaymentIntentRecord>;
  /** CAS state transition — the ONLY writer of executionState (WS-M.3.1b).
   *  Returns the updated record, or null when the stored state ≠ `from`. */
  transition(
    paymentIntentId: string,
    from: PaymentIntentState,
    to: PaymentIntentState,
    patch: Partial<
      Pick<
        PaymentIntentRecord,
        | 'jurisdictionState'
        | 'complianceState'
        | 'retryCount'
        | 'quoteRef'
        | 'actionRecordId'
        | 'receiptId'
        | 'expiresAt'
      >
    >,
    updatedAt: string,
  ): Promise<PaymentIntentRecord | null>;
  listByRoom(roomId: string, limit: number): Promise<PaymentIntentRecord[]>;
  /** Keyset page over a treasury's FULL intent history (paymentIntentId
   *  ascending) — reconciliation and the accounting export walk every page,
   *  never a fixed newest-N slice that silently drops older rows. */
  listByTreasuryPage(
    treasuryId: string,
    afterId: string | null,
    limit: number,
  ): Promise<PaymentIntentRecord[]>;
  /** Deposit-class intents CREATED in the rolling period for a room — the
   *  complete allowance basis (WS-M.2.2a), bounded by the period itself. */
  listDepositsInPeriod(roomId: string, sinceIso: string): Promise<PaymentIntentRecord[]>;
  /** Timed-out pre-submission intents for the expiry sweep (WS-M.3.1b). */
  listExpired(nowIso: string, limit: number): Promise<PaymentIntentRecord[]>;
  /** Post-submission intents to reconcile against their action records. */
  listByStates(
    states: readonly PaymentIntentState[],
    limit: number,
  ): Promise<PaymentIntentRecord[]>;
  clear(): Promise<void>;
}

export interface GrantStore {
  getById(grantId: string): Promise<GrantRecord | null>;
  getByProposal(proposalId: string): Promise<GrantRecord | null>;
  /** Returns null when the proposal already has a grant. */
  insert(record: GrantRecord): Promise<GrantRecord | null>;
  update(record: GrantRecord): Promise<GrantRecord | null>;
  listByRoom(roomId: string, limit: number): Promise<GrantRecord[]>;
  clear(): Promise<void>;
}

export interface ActionBudgetStore {
  get(roomId: string, actorKey: string): Promise<ActionBudgetRecord | null>;
  /** Optimistic write guarded by `expectedUpdatedAt` (null ⇒ insert-only).
   *  Returns null on a concurrent modification — the caller re-reads. */
  put(
    record: ActionBudgetRecord,
    expectedUpdatedAt: string | null,
  ): Promise<ActionBudgetRecord | null>;
  clear(): Promise<void>;
}

export interface DelegationStore {
  getById(delegationId: string): Promise<DelegationRecordEntity | null>;
  /** Returns null when an ACTIVE delegation already exists for the same
   *  (room, delegator, scopeKey) — mirrors the partial unique index. */
  insert(record: DelegationRecordEntity): Promise<DelegationRecordEntity | null>;
  revoke(delegationId: string, revokedAt: string): Promise<DelegationRecordEntity | null>;
  listActiveByDelegate(roomId: string, delegateUserId: string): Promise<DelegationRecordEntity[]>;
  listActiveByDelegator(roomId: string, delegatorUserId: string): Promise<DelegationRecordEntity[]>;
  listByRoom(roomId: string, limit: number): Promise<DelegationRecordEntity[]>;
  clear(): Promise<void>;
}

export interface ChallengeStore {
  getById(challengeId: string): Promise<ChallengeRecord | null>;
  insert(record: ChallengeRecord): Promise<ChallengeRecord>;
  /** CAS state transition per the pure challenge table. */
  transition(
    challengeId: string,
    from: ProposalChallengeState,
    to: ProposalChallengeState,
    resolution: { note: string | null; resolvedByUserId: string | null; resolvedAt: string },
  ): Promise<ChallengeRecord | null>;
  listByProposal(proposalId: string): Promise<ChallengeRecord[]>;
  countOpenByProposal(proposalId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface SnapshotStore {
  append(record: SnapshotRecord): Promise<SnapshotRecord>;
  latestByTreasuryAsset(treasuryId: string, asset: string): Promise<SnapshotRecord | null>;
  listByTreasury(treasuryId: string, limit: number): Promise<SnapshotRecord[]>;
  clear(): Promise<void>;
}

export interface AttestationStore {
  get(roomId: string, item: AttestationRecord['item']): Promise<AttestationRecord | null>;
  upsert(record: AttestationRecord): Promise<AttestationRecord>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory adapters
// ---------------------------------------------------------------------------

export class InMemoryGovernanceProfileStore implements GovernanceProfileStore {
  readonly #rows = new Map<string, GovernanceProfileRecord>();

  async get(roomId: string): Promise<GovernanceProfileRecord | null> {
    const row = this.#rows.get(roomId);
    return row ? clone(row) : null;
  }

  async upsert(record: GovernanceProfileRecord): Promise<GovernanceProfileRecord> {
    this.#rows.set(record.roomId, clone(record));
    return clone(record);
  }

  async listAll(): Promise<GovernanceProfileRecord[]> {
    return [...this.#rows.values()].map(clone);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryCharterStore implements CharterStore {
  readonly #rows: CharterVersionRecord[] = [];

  async latestByRoom(roomId: string): Promise<CharterVersionRecord | null> {
    const versions = this.#rows.filter((r) => r.roomId === roomId);
    if (versions.length === 0) return null;
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    return clone(latest);
  }

  async getById(charterVersionId: string): Promise<CharterVersionRecord | null> {
    const row = this.#rows.find((r) => r.charterVersionId === charterVersionId);
    return row ? clone(row) : null;
  }

  async insert(record: CharterVersionRecord): Promise<CharterVersionRecord | null> {
    if (this.#rows.some((r) => r.roomId === record.roomId && r.version === record.version)) {
      return null; // (room, version) unique collision
    }
    this.#rows.push(clone(record));
    return clone(record);
  }

  async listByRoom(roomId: string): Promise<CharterVersionRecord[]> {
    return this.#rows
      .filter((r) => r.roomId === roomId)
      .sort((a, b) => b.version - a.version)
      .map(clone);
  }

  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

export class InMemoryTreasuryStore implements TreasuryStore {
  readonly #rows = new Map<string, TreasuryRecord>();

  async getById(treasuryId: string): Promise<TreasuryRecord | null> {
    const row = this.#rows.get(treasuryId);
    return row ? clone(row) : null;
  }

  async getByRoom(roomId: string): Promise<TreasuryRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.roomId === roomId) return clone(row);
    }
    return null;
  }

  async insert(record: TreasuryRecord): Promise<TreasuryRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.roomId === record.roomId) return null; // one treasury per room
      if (row.treasuryAddress === record.treasuryAddress) return null; // unique address
    }
    this.#rows.set(record.treasuryId, clone(record));
    return clone(record);
  }

  async setFreeze(
    treasuryId: string,
    state: 'active' | 'frozen',
    reason: string | null,
  ): Promise<boolean> {
    const row = this.#rows.get(treasuryId);
    if (!row) return false;
    row.freezeState = state;
    row.freezeReason = reason;
    return true;
  }

  async setPauseFlags(treasuryId: string, flags: PauseFlags): Promise<boolean> {
    const row = this.#rows.get(treasuryId);
    if (!row) return false;
    row.pauseFlags = clone(flags);
    return true;
  }

  async setReconciliation(
    treasuryId: string,
    state: TreasuryRecord['reconciliationState'],
    balanceSnapshot: Record<string, string> | null,
    reconciledAt: string | null,
  ): Promise<boolean> {
    const row = this.#rows.get(treasuryId);
    if (!row) return false;
    row.reconciliationState = state;
    if (balanceSnapshot !== null) {
      row.balanceSnapshot = clone(balanceSnapshot);
      row.balancesReconciledAt = reconciledAt;
    }
    return true;
  }

  async listAll(): Promise<TreasuryRecord[]> {
    return [...this.#rows.values()].map(clone);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryReservationStore implements ReservationStore {
  readonly #rows = new Map<string, ReservationRecord>();

  async getByProposal(proposalId: string): Promise<ReservationRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.proposalId === proposalId) return clone(row);
    }
    return null;
  }

  async insert(record: ReservationRecord): Promise<ReservationRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.proposalId === record.proposalId) return null; // one per proposal
    }
    this.#rows.set(record.reservationId, clone(record));
    return clone(record);
  }

  async transition(
    reservationId: string,
    from: ReservationState,
    to: ReservationState,
    updatedAt: string,
  ): Promise<boolean> {
    const row = this.#rows.get(reservationId);
    if (!row || row.state !== from) return false;
    row.state = to;
    row.updatedAt = updatedAt;
    return true;
  }

  async listActiveByTreasury(treasuryId: string, category: string): Promise<ReservationRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) => r.treasuryId === treasuryId && r.category === category && r.state === 'reserved',
      )
      .map(clone);
  }

  async listActiveByTreasuryAsset(treasuryId: string, asset: string): Promise<ReservationRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.treasuryId === treasuryId && r.asset === asset && r.state === 'reserved')
      .map(clone);
  }

  async listConsumedByTreasury(treasuryId: string, category: string): Promise<ReservationRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) => r.treasuryId === treasuryId && r.category === category && r.state === 'consumed',
      )
      .map(clone);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryPaymentIntentStore implements PaymentIntentStore {
  readonly #rows = new Map<string, PaymentIntentRecord>();

  async getById(paymentIntentId: string): Promise<PaymentIntentRecord | null> {
    const row = this.#rows.get(paymentIntentId);
    return row ? clone(row) : null;
  }

  async findByIdempotencyKey(
    userId: string,
    roomId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntentRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.userId === userId && row.roomId === roomId && row.idempotencyKey === idempotencyKey) {
        return clone(row);
      }
    }
    return null;
  }

  async insert(record: PaymentIntentRecord): Promise<PaymentIntentRecord> {
    if (record.userId !== null) {
      const existing = await this.findByIdempotencyKey(
        record.userId,
        record.roomId,
        record.idempotencyKey,
      );
      if (existing !== null) return existing;
    }
    this.#rows.set(record.paymentIntentId, clone(record));
    return clone(record);
  }

  async transition(
    paymentIntentId: string,
    from: PaymentIntentState,
    to: PaymentIntentState,
    patch: Parameters<PaymentIntentStore['transition']>[3],
    updatedAt: string,
  ): Promise<PaymentIntentRecord | null> {
    const row = this.#rows.get(paymentIntentId);
    if (!row || row.executionState !== from) return null;
    row.executionState = to;
    row.updatedAt = updatedAt;
    if (patch.jurisdictionState !== undefined) row.jurisdictionState = patch.jurisdictionState;
    if (patch.complianceState !== undefined) row.complianceState = patch.complianceState;
    if (patch.retryCount !== undefined) row.retryCount = patch.retryCount;
    if (patch.quoteRef !== undefined) row.quoteRef = clone(patch.quoteRef);
    if (patch.actionRecordId !== undefined) row.actionRecordId = patch.actionRecordId;
    if (patch.receiptId !== undefined) row.receiptId = patch.receiptId;
    if (patch.expiresAt !== undefined) row.expiresAt = patch.expiresAt;
    return clone(row);
  }

  async listByRoom(roomId: string, limit: number): Promise<PaymentIntentRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async listByTreasuryPage(
    treasuryId: string,
    afterId: string | null,
    limit: number,
  ): Promise<PaymentIntentRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.treasuryId === treasuryId)
      .sort((a, b) => (a.paymentIntentId < b.paymentIntentId ? -1 : 1))
      .filter((r) => afterId === null || r.paymentIntentId > afterId)
      .slice(0, limit)
      .map(clone);
  }

  async listDepositsInPeriod(roomId: string, sinceIso: string): Promise<PaymentIntentRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.roomId === roomId &&
          (r.targetType === 'treasury_deposit' || r.targetType === 'bounty_contribution') &&
          r.createdAt >= sinceIso,
      )
      .map(clone);
  }

  async listExpired(nowIso: string, limit: number): Promise<PaymentIntentRecord[]> {
    const timed: PaymentIntentState[] = ['created', 'preflighted', 'quoted', 'signed'];
    return [...this.#rows.values()]
      .filter((r) => timed.includes(r.executionState) && r.expiresAt <= nowIso)
      .slice(0, limit)
      .map(clone);
  }

  async listByStates(
    states: readonly PaymentIntentState[],
    limit: number,
  ): Promise<PaymentIntentRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => states.includes(r.executionState))
      .slice(0, limit)
      .map(clone);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryGrantStore implements GrantStore {
  readonly #rows = new Map<string, GrantRecord>();

  async getById(grantId: string): Promise<GrantRecord | null> {
    const row = this.#rows.get(grantId);
    return row ? clone(row) : null;
  }

  async getByProposal(proposalId: string): Promise<GrantRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.proposalId === proposalId) return clone(row);
    }
    return null;
  }

  async insert(record: GrantRecord): Promise<GrantRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.proposalId === record.proposalId) return null; // one per proposal
    }
    this.#rows.set(record.grantId, clone(record));
    return clone(record);
  }

  async update(record: GrantRecord): Promise<GrantRecord | null> {
    if (!this.#rows.has(record.grantId)) return null;
    this.#rows.set(record.grantId, clone(record));
    return clone(record);
  }

  async listByRoom(roomId: string, limit: number): Promise<GrantRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryActionBudgetStore implements ActionBudgetStore {
  readonly #rows = new Map<string, ActionBudgetRecord>();

  #key(roomId: string, actorKey: string): string {
    return `${roomId}:${actorKey}`;
  }

  async get(roomId: string, actorKey: string): Promise<ActionBudgetRecord | null> {
    const row = this.#rows.get(this.#key(roomId, actorKey));
    return row ? clone(row) : null;
  }

  async put(
    record: ActionBudgetRecord,
    expectedUpdatedAt: string | null,
  ): Promise<ActionBudgetRecord | null> {
    const key = this.#key(record.roomId, record.actorKey);
    const current = this.#rows.get(key);
    if (expectedUpdatedAt === null) {
      if (current !== undefined) return null; // insert-only collision
    } else if (current === undefined || current.updatedAt !== expectedUpdatedAt) {
      return null; // optimistic-concurrency conflict
    }
    this.#rows.set(key, clone(record));
    return clone(record);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryDelegationStore implements DelegationStore {
  readonly #rows = new Map<string, DelegationRecordEntity>();

  async getById(delegationId: string): Promise<DelegationRecordEntity | null> {
    const row = this.#rows.get(delegationId);
    return row ? clone(row) : null;
  }

  async insert(record: DelegationRecordEntity): Promise<DelegationRecordEntity | null> {
    for (const row of this.#rows.values()) {
      if (
        row.roomId === record.roomId &&
        row.delegatorUserId === record.delegatorUserId &&
        row.scopeKey === record.scopeKey &&
        row.state === 'active'
      ) {
        return null; // one active per (room, delegator, scope)
      }
    }
    this.#rows.set(record.delegationId, clone(record));
    return clone(record);
  }

  async revoke(delegationId: string, revokedAt: string): Promise<DelegationRecordEntity | null> {
    const row = this.#rows.get(delegationId);
    if (row?.state !== 'active') return null;
    row.state = 'revoked';
    row.revokedAt = revokedAt;
    return clone(row);
  }

  async listActiveByDelegate(
    roomId: string,
    delegateUserId: string,
  ): Promise<DelegationRecordEntity[]> {
    return [...this.#rows.values()]
      .filter(
        (r) => r.roomId === roomId && r.delegateUserId === delegateUserId && r.state === 'active',
      )
      .map(clone);
  }

  async listActiveByDelegator(
    roomId: string,
    delegatorUserId: string,
  ): Promise<DelegationRecordEntity[]> {
    return [...this.#rows.values()]
      .filter(
        (r) => r.roomId === roomId && r.delegatorUserId === delegatorUserId && r.state === 'active',
      )
      .map(clone);
  }

  async listByRoom(roomId: string, limit: number): Promise<DelegationRecordEntity[]> {
    return [...this.#rows.values()]
      .filter((r) => r.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryChallengeStore implements ChallengeStore {
  readonly #rows = new Map<string, ChallengeRecord>();

  async getById(challengeId: string): Promise<ChallengeRecord | null> {
    const row = this.#rows.get(challengeId);
    return row ? clone(row) : null;
  }

  async insert(record: ChallengeRecord): Promise<ChallengeRecord> {
    this.#rows.set(record.challengeId, clone(record));
    return clone(record);
  }

  async transition(
    challengeId: string,
    from: ProposalChallengeState,
    to: ProposalChallengeState,
    resolution: { note: string | null; resolvedByUserId: string | null; resolvedAt: string },
  ): Promise<ChallengeRecord | null> {
    const row = this.#rows.get(challengeId);
    if (!row || row.state !== from) return null;
    row.state = to;
    row.resolutionNote = resolution.note;
    row.resolvedByUserId = resolution.resolvedByUserId;
    // An escalation is a routing step, not a resolution — resolvedAt stays null
    // until the final disposition (upheld/dismissed).
    row.resolvedAt = to === 'escalated' ? null : resolution.resolvedAt;
    return clone(row);
  }

  async listByProposal(proposalId: string): Promise<ChallengeRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.proposalId === proposalId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async countOpenByProposal(proposalId: string): Promise<number> {
    return [...this.#rows.values()].filter(
      (r) => r.proposalId === proposalId && (r.state === 'open' || r.state === 'escalated'),
    ).length;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemorySnapshotStore implements SnapshotStore {
  readonly #rows: SnapshotRecord[] = [];

  async append(record: SnapshotRecord): Promise<SnapshotRecord> {
    this.#rows.push(clone(record));
    return clone(record);
  }

  async latestByTreasuryAsset(treasuryId: string, asset: string): Promise<SnapshotRecord | null> {
    for (let i = this.#rows.length - 1; i >= 0; i -= 1) {
      const row = this.#rows[i];
      if (row && row.treasuryId === treasuryId && row.asset === asset) return clone(row);
    }
    return null;
  }

  async listByTreasury(treasuryId: string, limit: number): Promise<SnapshotRecord[]> {
    return this.#rows
      .filter((r) => r.treasuryId === treasuryId)
      .slice(-limit)
      .reverse()
      .map(clone);
  }

  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

export class InMemoryAttestationStore implements AttestationStore {
  readonly #rows = new Map<string, AttestationRecord>();

  async get(roomId: string, item: AttestationRecord['item']): Promise<AttestationRecord | null> {
    const row = this.#rows.get(`${roomId}:${item}`);
    return row ? clone(row) : null;
  }

  async upsert(record: AttestationRecord): Promise<AttestationRecord> {
    this.#rows.set(`${record.roomId}:${record.item}`, clone(record));
    return clone(record);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}
