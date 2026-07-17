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
  /** True when the freeze is the CASCADE of a room-scope freeze — the
   *  structural marker a room unfreeze keys on (free-form reason text can
   *  coincide across independent holds, PR #144 W10). */
  freezeCascade: boolean;
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
  /** COLUMN-scoped charter-pointer update: a whole-record upsert built from a
   *  stale read could clobber a freeze written in between (PR #144 W7). */
  setCharterPointer(roomId: string, charterVersionId: string, updatedAt: string): Promise<boolean>;
  /** COLUMN-scoped freeze fields — the whole-record upsert wrote back stale
   *  pause flags / pack refs read before the freeze decision (sweep). */
  setProfileFreeze(
    roomId: string,
    state: 'active' | 'frozen',
    reason: string | null,
    updatedAt: string,
  ): Promise<boolean>;
  /** COLUMN-scoped treasury pointer (same stale-clobber hazard). */
  setTreasuryPointer(roomId: string, treasuryId: string, updatedAt: string): Promise<boolean>;
  /** COLUMN-scoped pause flags — a whole-record write from a stale read could
   *  silently unfreeze a room mid-emergency (PR #144 W9). */
  setProfilePauseFlags(roomId: string, flags: PauseFlags, updatedAt: string): Promise<boolean>;
  /** COLUMN-scoped law-pack adoption refs (same stale-clobber hazard). */
  setLawPackRefs(
    roomId: string,
    refs: {
      lawPackId: string;
      quorumPolicyRef: Record<string, unknown>;
      thresholdPolicyRef: Record<string, unknown>;
      timelockPolicyRef: Record<string, unknown>;
    },
    updatedAt: string,
  ): Promise<boolean>;
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
  /** Column-scoped updates (never whole-record clobbering).  `cascaded`
   *  marks a room-freeze cascade — the flag a room unfreeze clears by. */
  setFreeze(
    treasuryId: string,
    state: 'active' | 'frozen',
    reason: string | null,
    cascaded: boolean,
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
  /** null userId = the ROOM-owned scope (grant/compensation payouts):
   *  idempotency is (room, key) so retries and steward handoffs converge. */
  findByIdempotencyKey(
    userId: string | null,
    roomId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntentRecord | null>;
  /** The intent (if any) already bound to a WS-L action record — one action
   *  settles exactly one intent, or a single transfer would double-count. */
  findByActionRecordId(actionRecordId: string): Promise<PaymentIntentRecord | null>;
  /** Returns the EXISTING intent on an idempotency-key collision (WS-M.3.1c:
   *  the key row and the intent are one write — the unique index is the record). */
  insert(record: PaymentIntentRecord): Promise<PaymentIntentRecord>;
  /** Remove a just-created intent that its OWN create call aborted atomically
   *  (the post-insert allowance race, WS-M.3.1a): it has no audit, no action, and
   *  no downstream reference, and abandoning it instead would leave a terminal
   *  row holding the idempotency key — so a retry would replay a dead intent that
   *  can never preflight/quote/submit.  Deleting frees the key so the retry mints
   *  a fresh attempt.  NOT a general lifecycle delete: only the create's own
   *  atomic rollback calls it. */
  deleteById(paymentIntentId: string): Promise<boolean>;
  /** CONDITIONAL rollback delete: remove the row ONLY if it is still the untouched
   *  insert (`created` with no bound action).  The create-overshoot rollback uses
   *  this so it cannot yank a row a concurrent idempotent replay already observed
   *  and ADVANCED (e.g. preflighted) — that would leave the replay client with a
   *  404/dangling id.  Returns false when the row changed (it now belongs to the
   *  request that advanced it, and stays). */
  deleteIfUntouched(paymentIntentId: string): Promise<boolean>;
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
  /** IN-FLIGHT intents owned by a user (nothing terminal) — the wallet-unlink
   *  obligations check (W12). */
  listActiveByUser(userId: string, limit: number): Promise<PaymentIntentRecord[]>;
  /** Data-rights scrub (W12): null the OWNER on every intent of a deleted
   *  user — the tombstoned users row never fires the FK's SET NULL. */
  anonymizeUser(userId: string): Promise<number>;
  /** Timed-out pre-submission intents for the expiry sweep (WS-M.3.1b) —
   *  keyset-paged (paymentIntentId ascending) so a page of un-abandonable signed
   *  orphans can never starve later expirable rows sitting BEHIND them. */
  listExpired(
    nowIso: string,
    limit: number,
    afterId?: string | null,
  ): Promise<PaymentIntentRecord[]>;
  /** Post-submission intents to reconcile against their action records —
   *  keyset-paged (paymentIntentId ascending) so a stuck first slice can
   *  never starve later reconcilable rows. */
  listByStates(
    states: readonly PaymentIntentState[],
    limit: number,
    afterId?: string | null,
  ): Promise<PaymentIntentRecord[]>;
  /** Intents in one COMPLIANCE state (the WS-N.2.2c fraud-queue read). */
  listByComplianceState(
    state: PaymentIntentRecord['complianceState'],
    limit: number,
  ): Promise<PaymentIntentRecord[]>;
  /** CAS on the ORTHOGONAL compliance column (WS-N.2.2c release/reject:
   *  flagged → cleared/blocked) — never touches executionState.  Returns
   *  null when the stored compliance state ≠ `from`. */
  updateComplianceState(
    paymentIntentId: string,
    from: PaymentIntentRecord['complianceState'],
    to: PaymentIntentRecord['complianceState'],
    updatedAt: string,
  ): Promise<PaymentIntentRecord | null>;
  clear(): Promise<void>;
}

/** The coarse milestone + payout projections over a milestone set — shared by
 *  both adapters so a milestone-scoped write re-projects IDENTICALLY. */
export function projectGrantAggregates(
  milestones: readonly GrantMilestoneRecord[],
  currentPayoutState: GrantRecord['payoutState'],
): Pick<GrantRecord, 'milestoneState' | 'payoutState'> {
  const milestoneState = milestones.every((m) => m.state === 'accepted')
    ? ('accepted' as const)
    : milestones.some((m) => m.state === 'rejected')
      ? ('rejected' as const)
      : milestones.some((m) => m.state !== 'pending')
        ? ('in_progress' as const)
        : ('pending' as const);
  // Scheduling only ever moves the grant to `scheduled`: `paid`/`partially_paid`
  // are RECONCILIATION verdicts and `clawed_back` is terminal.
  const scheduled = milestones.filter((m) => m.paymentIntentId !== null).length;
  const payoutState =
    scheduled === 0 ||
    currentPayoutState === 'partially_paid' ||
    currentPayoutState === 'paid' ||
    currentPayoutState === 'clawed_back'
      ? currentPayoutState
      : ('scheduled' as const);
  return { milestoneState, payoutState };
}

export interface GrantStore {
  getById(grantId: string): Promise<GrantRecord | null>;
  getByProposal(proposalId: string): Promise<GrantRecord | null>;
  /** Returns null when the proposal already has a grant. */
  insert(record: GrantRecord): Promise<GrantRecord | null>;
  update(record: GrantRecord): Promise<GrantRecord | null>;
  /** MILESTONE-scoped CAS: patches ONE milestone against the CURRENT row and
   *  re-projects the aggregates — two stewards updating different milestones
   *  can never clobber each other's writes (a whole-record `update` from a
   *  snapshot would).  Returns null when the milestone's stored state ≠
   *  `fromState` (the CAS lost) or the grant/milestone is unknown. */
  applyMilestoneTransition(
    grantId: string,
    milestoneId: string,
    fromState: GrantMilestoneRecord['state'],
    toState: GrantMilestoneRecord['state'],
    paymentIntentId: string | null,
  ): Promise<GrantRecord | null>;
  /** COLUMN-scoped payout-state projection (W12): the reconcile sweep and
   *  clawback must never write a stale milestones snapshot back over a
   *  concurrent milestone transition. */
  setPayoutState(
    grantId: string,
    payoutState: GrantRecord['payoutState'],
    auditSummary?: string,
  ): Promise<boolean>;
  /** COLUMN-scoped review-state write (same stale-snapshot hazard). */
  setReviewState(grantId: string, reviewState: GrantRecord['reviewState']): Promise<boolean>;
  /** UNSETTLED grants with recipientRef = ref (not paid/clawed_back) — the
   *  wallet-unlink obligations check (W12). */
  listUnsettledByRecipient(recipientRef: string, limit: number): Promise<GrantRecord[]>;
  /** UNSETTLED grants for a treasury (payout not paid/clawed_back), keyset-
   *  paged by grantId — the liquidity encumbrance walks EVERY page (W9). */
  listUnsettledByTreasury(
    treasuryId: string,
    limit: number,
    afterId?: string | null,
  ): Promise<GrantRecord[]>;
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

  async setCharterPointer(
    roomId: string,
    charterVersionId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const row = this.#rows.get(roomId);
    if (row === undefined) return false;
    row.charterVersionId = charterVersionId;
    row.updatedAt = updatedAt;
    return true;
  }

  async setProfileFreeze(
    roomId: string,
    state: 'active' | 'frozen',
    reason: string | null,
    updatedAt: string,
  ): Promise<boolean> {
    const row = this.#rows.get(roomId);
    if (row === undefined) return false;
    row.freezeState = state;
    row.freezeReason = reason;
    row.updatedAt = updatedAt;
    return true;
  }

  async setTreasuryPointer(
    roomId: string,
    treasuryId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const row = this.#rows.get(roomId);
    if (row === undefined) return false;
    row.treasuryId = treasuryId;
    row.updatedAt = updatedAt;
    return true;
  }

  async setProfilePauseFlags(
    roomId: string,
    flags: PauseFlags,
    updatedAt: string,
  ): Promise<boolean> {
    const row = this.#rows.get(roomId);
    if (row === undefined) return false;
    row.pauseFlags = clone(flags);
    row.updatedAt = updatedAt;
    return true;
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
    const row = this.#rows.get(roomId);
    if (row === undefined) return false;
    row.lawPackId = refs.lawPackId;
    row.quorumPolicyRef = clone(refs.quorumPolicyRef);
    row.thresholdPolicyRef = clone(refs.thresholdPolicyRef);
    row.timelockPolicyRef = clone(refs.timelockPolicyRef);
    row.updatedAt = updatedAt;
    return true;
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
    cascaded: boolean,
  ): Promise<boolean> {
    const row = this.#rows.get(treasuryId);
    if (!row) return false;
    row.freezeState = state;
    row.freezeReason = reason;
    row.freezeCascade = state === 'frozen' ? cascaded : false;
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

/** Execution states an intent can never leave — it can neither quote/submit nor
 *  be recovered.  A row in one of these is done: it must not appear in a LIVE
 *  view (the fraud queue) or be replayed as a usable intent. */
export const TERMINAL_INTENT_STATES: ReadonlySet<PaymentIntentState> = new Set([
  'finalized',
  'abandoned',
  'failed',
  'reverted',
  'reorged',
]);

export class InMemoryPaymentIntentStore implements PaymentIntentStore {
  readonly #rows = new Map<string, PaymentIntentRecord>();

  async getById(paymentIntentId: string): Promise<PaymentIntentRecord | null> {
    const row = this.#rows.get(paymentIntentId);
    return row ? clone(row) : null;
  }

  async deleteById(paymentIntentId: string): Promise<boolean> {
    return this.#rows.delete(paymentIntentId);
  }

  async deleteIfUntouched(paymentIntentId: string): Promise<boolean> {
    const row = this.#rows.get(paymentIntentId);
    if (row === undefined || row.executionState !== 'created' || row.actionRecordId !== null) {
      return false;
    }
    return this.#rows.delete(paymentIntentId);
  }

  async findByIdempotencyKey(
    userId: string | null,
    roomId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntentRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.roomId !== roomId || row.idempotencyKey !== idempotencyKey) continue;
      if (userId === null) {
        // The room-owned scope covers the PAYOUT classes only (0086): an
        // ERASED member deposit also carries a null user and must not match.
        if (
          row.userId === null &&
          (row.targetType === 'grant_payout' || row.targetType === 'steward_compensation')
        ) {
          return clone(row);
        }
      } else if (row.userId === userId) {
        return clone(row);
      }
    }
    return null;
  }

  async findByActionRecordId(actionRecordId: string): Promise<PaymentIntentRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.actionRecordId === actionRecordId) return clone(row);
    }
    return null;
  }

  async insert(record: PaymentIntentRecord): Promise<PaymentIntentRecord> {
    // Both scopes dedupe: (user, room, key) for member intents, (room, key)
    // for room-owned ones — mirrors the two partial unique indexes.
    const existing = await this.findByIdempotencyKey(
      record.userId,
      record.roomId,
      record.idempotencyKey,
    );
    if (existing !== null) return existing;
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
    // Emulate the 0087 partial unique: ONE intent per action record — the
    // attach race's loser gets a clean CAS-loss null, never a double-settle.
    if (patch.actionRecordId != null) {
      for (const other of this.#rows.values()) {
        if (
          other.paymentIntentId !== paymentIntentId &&
          other.actionRecordId === patch.actionRecordId
        ) {
          return null;
        }
      }
    }
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

  async listActiveByUser(userId: string, limit: number): Promise<PaymentIntentRecord[]> {
    // `reorged` is a REVERSAL (the transfer un-happened) — it must not hold a
    // wallet-unlink obligation open; a retry re-checks the wallet set (W14).
    const terminal: PaymentIntentState[] = [
      'finalized',
      'abandoned',
      'failed',
      'reverted',
      'reorged',
    ];
    return [...this.#rows.values()]
      .filter((r) => r.userId === userId && !terminal.includes(r.executionState))
      .slice(0, limit)
      .map(clone);
  }

  async anonymizeUser(userId: string): Promise<number> {
    let scrubbed = 0;
    for (const row of this.#rows.values()) {
      if (row.userId === userId) {
        row.userId = null;
        scrubbed += 1;
      }
    }
    return scrubbed;
  }

  async listExpired(
    nowIso: string,
    limit: number,
    afterId: string | null = null,
  ): Promise<PaymentIntentRecord[]> {
    const timed: PaymentIntentState[] = ['created', 'preflighted', 'quoted', 'signed'];
    return [...this.#rows.values()]
      .filter((r) => timed.includes(r.executionState) && r.expiresAt <= nowIso)
      .sort((a, b) => (a.paymentIntentId < b.paymentIntentId ? -1 : 1))
      .filter((r) => afterId === null || r.paymentIntentId > afterId)
      .slice(0, limit)
      .map(clone);
  }

  async listByStates(
    states: readonly PaymentIntentState[],
    limit: number,
    afterId: string | null = null,
  ): Promise<PaymentIntentRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => states.includes(r.executionState))
      .sort((a, b) => (a.paymentIntentId < b.paymentIntentId ? -1 : 1))
      .filter((r) => afterId === null || r.paymentIntentId > afterId)
      .slice(0, limit)
      .map(clone);
  }

  async listByComplianceState(
    state: PaymentIntentRecord['complianceState'],
    limit: number,
  ): Promise<PaymentIntentRecord[]> {
    // LIVE only — a fraud-held intent that expired/clawed back to a terminal
    // state (its `complianceState` still `flagged`) must not ride the fraud
    // queue: the reviewer would see a row they cannot release (it can no longer
    // quote or submit), and stale rows would consume the page ahead of live
    // held payments.  Filtered BEFORE the slice so the cap bounds live rows.
    return [...this.#rows.values()]
      .filter((r) => r.complianceState === state && !TERMINAL_INTENT_STATES.has(r.executionState))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, limit)
      .map(clone);
  }

  async updateComplianceState(
    paymentIntentId: string,
    from: PaymentIntentRecord['complianceState'],
    to: PaymentIntentRecord['complianceState'],
    updatedAt: string,
  ): Promise<PaymentIntentRecord | null> {
    const row = this.#rows.get(paymentIntentId);
    // CAS on the compliance column AND a LIVE execution state: a review decision
    // (release/reject) must not flip the column of an intent the expiry/clawback
    // path terminal-ized between the reviewer's read and this write — a
    // `flagged → cleared` on an `abandoned`/`failed` row would report the transfer
    // released while it can never quote or submit.  A terminal row fails the CAS
    // (→ null → 409), the same as a compliance-state mismatch.
    if (!row || row.complianceState !== from || TERMINAL_INTENT_STATES.has(row.executionState)) {
      return null;
    }
    row.complianceState = to;
    row.updatedAt = updatedAt;
    return clone(row);
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

  async applyMilestoneTransition(
    grantId: string,
    milestoneId: string,
    fromState: GrantMilestoneRecord['state'],
    toState: GrantMilestoneRecord['state'],
    paymentIntentId: string | null,
  ): Promise<GrantRecord | null> {
    const row = this.#rows.get(grantId);
    if (row === undefined) return null;
    const milestone = row.milestones.find((m) => m.milestoneId === milestoneId);
    if (milestone === undefined || milestone.state !== fromState) return null;
    milestone.state = toState;
    if (paymentIntentId !== null) milestone.paymentIntentId = paymentIntentId;
    const aggregates = projectGrantAggregates(row.milestones, row.payoutState);
    row.milestoneState = aggregates.milestoneState;
    row.payoutState = aggregates.payoutState;
    return clone(row);
  }

  async setPayoutState(
    grantId: string,
    payoutState: GrantRecord['payoutState'],
    auditSummary?: string,
  ): Promise<boolean> {
    const row = this.#rows.get(grantId);
    if (row === undefined) return false;
    row.payoutState = payoutState;
    if (auditSummary !== undefined) row.auditSummary = auditSummary;
    return true;
  }

  async setReviewState(grantId: string, reviewState: GrantRecord['reviewState']): Promise<boolean> {
    const row = this.#rows.get(grantId);
    if (row === undefined) return false;
    row.reviewState = reviewState;
    return true;
  }

  async listUnsettledByRecipient(recipientRef: string, limit: number): Promise<GrantRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.recipientRef === recipientRef &&
          r.payoutState !== 'paid' &&
          r.payoutState !== 'clawed_back',
      )
      .slice(0, limit)
      .map(clone);
  }

  async listUnsettledByTreasury(
    treasuryId: string,
    limit: number,
    afterId: string | null = null,
  ): Promise<GrantRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.treasuryId === treasuryId &&
          r.payoutState !== 'paid' &&
          r.payoutState !== 'clawed_back',
      )
      .sort((a, b) => (a.grantId < b.grantId ? -1 : 1))
      .filter((r) => afterId === null || r.grantId > afterId)
      .slice(0, limit)
      .map(clone);
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
