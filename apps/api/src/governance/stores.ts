// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U store interfaces + in-memory adapters (the house pattern). The records
// mirror the isolated `knomosis` schema; the production Drizzle adapters bind the
// same interfaces later (the gated path). Domain values (bundles, law-packs,
// descriptors, verdicts) are stored as their @licio/governance types.

import type {
  CandidateTally,
  CapabilityDescriptor,
  GovernancePolicyBundle,
  LawPack,
  RatificationChoice,
  RatificationResult,
  Verdict,
} from '@licio/governance';

export type ElectionStatus = 'scheduled' | 'open' | 'tallying' | 'settled' | 'cancelled';
export type RatificationStatus = 'open' | 'settled' | 'cancelled';
export type RatificationOutcome = 'approved' | 'rejected';
export type ElectionMode = 'simulated' | 'testnet' | 'onchain';
export type ModelStatus =
  | 'proposed'
  | 'evaluating'
  | 'eligible'
  | 'rejected'
  | 'approved'
  | 'superseded';

export interface StewardSeatRecord {
  roomId: string;
  holderUserId: string | null;
  termStart: string;
  termEnd: string;
  bootstrap: boolean;
  currentElectionId: string | null;
  updatedAt: string;
}
export interface ElectionRecord {
  electionId: string;
  roomId: string;
  status: ElectionStatus;
  opensAt: string;
  closesAt: string;
  weightModel: string;
  winnerUserId: string | null;
  tally: CandidateTally[] | null;
  mode: ElectionMode;
  createdAt: string;
  settledAt: string | null;
}
export interface VoteRecord {
  electionId: string;
  voterUserId: string;
  candidateUserId: string;
  weight: number;
  castAt: string;
}
export interface ModelRecord {
  modelId: string;
  roomId: string;
  artifactDigest: string;
  bundle: GovernancePolicyBundle;
  cardRef: string | null;
  proposedByUserId: string | null;
  status: ModelStatus;
  evaluationRef: string | null;
  /** The `ModerationProposer.backendId` that ran this model's admission gate (set
   *  when it became `eligible`; null until admitted, or for a proposer with no
   *  backendId). `moderate` refuses a live decision under a different backend
   *  (WS-U ADR-9 review — an un-vetted backend swap fails closed). */
  admittedBackendId: string | null;
  createdAt: string;
}
export interface PromptRecord {
  promptId: string;
  roomId: string;
  modelId: string;
  promptDigest: string;
  promptText: string;
  proposedByUserId: string | null;
  createdAt: string;
}
export interface RatificationVoteRecord {
  voteId: string;
  roomId: string;
  modelId: string;
  lawPackId: string | null;
  status: RatificationStatus;
  opensAt: string;
  closesAt: string;
  minQuorum: number;
  /**
   * The room's eligible-voter count SNAPSHOTTED at open — the FROZEN turnout
   * denominator. `minQuorum` was already frozen at open; freezing the electorate
   * too makes the whole adoption bound (quorum + turnout) fixed for the life of
   * the vote, so membership churn between open and the settle tick can no longer
   * flip the outcome by shrinking the denominator. (`minTurnout` needs no snapshot:
   * it comes from the vote's IMMUTABLE bound law-pack, so it is already stable.)
   */
  eligibleCount: number;
  openedByUserId: string | null;
  tally: RatificationResult | null;
  outcome: RatificationOutcome | null;
  createdAt: string;
  settledAt: string | null;
}
export interface RatificationBallotRecord {
  voteId: string;
  voterUserId: string;
  choice: RatificationChoice;
  castAt: string;
}
export interface LawPackRecord {
  lawPackId: string;
  roomId: string;
  version: string;
  lawPack: LawPack;
  createdAt: string;
  // --- WS-M.1.3a/c/d (migration 0082; absent on WS-U rows → store defaults).
  /** SHA-256 hex over the canonical bundle minus the field itself. */
  hashCommitment?: string | null;
  auditState?: 'draft' | 'reviewed' | 'audited';
  /** The fixture corpus proving the pack's behavior (WS-M.1.3c). */
  fixtures?: Record<string, unknown> | null;
  humanSummary?: string | null;
  /** Published versions are IMMUTABLE (DB trigger) and retained indefinitely. */
  published?: boolean;
  effectiveAt?: string | null;
  supersedesLawPackId?: string | null;
}
export interface BindingRecord {
  roomId: string;
  modelId: string;
  promptId: string;
  lawPackId: string | null;
  approvedByElectionId: string | null;
  capabilityDescriptor: CapabilityDescriptor;
  active: boolean;
  /**
   * True when the platform floor (a WS-J safety steward) has frozen this room's
   * agent. This is DURABLE and distinct from `active`: a member ratification may
   * flip `active`, but it must NEVER clear `floorFrozen` — only the WS-J-gated
   * unfreeze does. While frozen, no re-adoption re-activates the agent, so the
   * platform legal floor stays non-overridable by any community vote.
   */
  floorFrozen: boolean;
  approvedAt: string;
}
export interface AgentActionRecord {
  actionId: string;
  roomId: string;
  bindingModelId: string;
  promptHash: string;
  actionType: string;
  subjectRef: string;
  lawPackRuleRef: string | null;
  statementOfReasons: string;
  reversible: boolean;
  createdAt: string;
}
export interface PendingRemoderationRecord {
  roomId: string;
  /** Soft ref to the moderated contribution. */
  subjectRef: string;
  /** Retry attempts so far (incremented each sweep pass that stays unavailable). */
  attempts: number;
  enqueuedAt: string;
  lastAttemptAt: string | null;
}
export interface TreasuryActionRecord {
  actionId: string;
  roomId: string;
  category: string;
  /** `number` (simulation units) or an exact decimal string (minor units) —
   *  the kernel compares either with exact decimal math (no double rounding). */
  amount: number | string;
  asset: string | null;
  /** The per-asset target allocation for an `investment_rebalance` (null for other
   *  categories) — persisted so an accepted rebalance can be AUDITED / replayed to
   *  prove which allocation satisfied the community-voted investment bands. */
  targetAllocation: readonly { asset: string; fraction: number }[] | null;
  accepted: boolean;
  verdict: Verdict;
  executedAt: string;
}

/**
 * Canonicalize a persisted treasury amount to its most faithful in-memory form:
 * a `number` when the decimal round-trips through IEEE-754 without loss (so the
 * pre-existing simulation-unit callers keep numbers), otherwise the exact decimal
 * string (so a minor-unit / uint256 amount is never silently rounded).  BOTH the
 * in-memory store and the Drizzle adapter (Postgres `numeric` always deserializes
 * to a string) apply this on READ, so the same stored value reads back identically
 * regardless of backend — the store-interface symmetry the house pattern requires.
 */
export function canonicalTreasuryAmount(raw: number | string): number | string {
  const text = typeof raw === 'number' ? String(raw) : raw;
  const asNumber = Number(text);
  // Faithful iff number → string reproduces the exact stored decimal; this rejects
  // > 2^53 integers and precision-losing fractions, which stay exact strings.
  return Number.isFinite(asNumber) && String(asNumber) === text ? asNumber : raw;
}

export interface SeatStore {
  get(roomId: string): Promise<StewardSeatRecord | null>;
  put(seat: StewardSeatRecord): Promise<StewardSeatRecord>;
  list(): Promise<StewardSeatRecord[]>;
  clear(): Promise<void>;
}
export interface ElectionStore {
  /** Insert an election; returns null when an OPEN election already exists for the
   *  room (the one-open-per-room invariant — a DB partial unique index in prod). */
  insert(election: ElectionRecord): Promise<ElectionRecord | null>;
  get(electionId: string): Promise<ElectionRecord | null>;
  listByRoom(roomId: string): Promise<ElectionRecord[]>;
  patch(electionId: string, fields: Partial<ElectionRecord>): Promise<ElectionRecord | null>;
  clear(): Promise<void>;
}
export interface VoteStore {
  cast(vote: VoteRecord): Promise<VoteRecord | null>; // null ⇒ already voted (idempotent)
  listByElection(electionId: string): Promise<VoteRecord[]>;
  clear(): Promise<void>;
}
export interface ModelStore {
  insert(model: ModelRecord): Promise<ModelRecord | null>; // null ⇒ digest already present
  get(modelId: string): Promise<ModelRecord | null>;
  listByRoom(roomId: string): Promise<ModelRecord[]>;
  /** Models in a given lifecycle status, oldest-first, bounded — the admission
   *  retry sweep drains `evaluating` models (WS-U ADR-9 review). */
  listByStatus(status: ModelStatus, limit: number): Promise<ModelRecord[]>;
  patchStatus(
    modelId: string,
    status: ModelStatus,
    evaluationRef: string | null,
    /** When provided, also pins the admitting backend (undefined ⇒ leave unchanged). */
    admittedBackendId?: string | null,
  ): Promise<ModelRecord | null>;
  clear(): Promise<void>;
}
export interface PromptStore {
  insert(prompt: PromptRecord): Promise<PromptRecord>;
  get(promptId: string): Promise<PromptRecord | null>;
  getByModel(modelId: string): Promise<PromptRecord | null>;
  clear(): Promise<void>;
}
export interface LawPackStore {
  insert(lawPack: LawPackRecord): Promise<LawPackRecord>;
  get(lawPackId: string): Promise<LawPackRecord | null>;
  /** WS-M.1.3d: a room's version history, newest first. */
  listByRoom(roomId: string): Promise<LawPackRecord[]>;
  clear(): Promise<void>;
}
export interface RatificationVoteStore {
  /** Insert a vote; returns null when an OPEN vote already exists for the room
   *  (the one-open-per-room invariant — a DB partial unique index in prod). */
  insert(vote: RatificationVoteRecord): Promise<RatificationVoteRecord | null>;
  get(voteId: string): Promise<RatificationVoteRecord | null>;
  /** The single OPEN vote for a room (at most one at a time), or null. */
  getOpenForRoom(roomId: string): Promise<RatificationVoteRecord | null>;
  listOpen(): Promise<RatificationVoteRecord[]>;
  patch(
    voteId: string,
    fields: Partial<RatificationVoteRecord>,
  ): Promise<RatificationVoteRecord | null>;
  clear(): Promise<void>;
}
export interface RatificationBallotStore {
  cast(ballot: RatificationBallotRecord): Promise<RatificationBallotRecord | null>; // null ⇒ already voted
  listByVote(voteId: string): Promise<RatificationBallotRecord[]>;
  clear(): Promise<void>;
}
export interface BindingStore {
  get(roomId: string): Promise<BindingRecord | null>;
  put(binding: BindingRecord): Promise<BindingRecord>;
  /** Set the binding's active + durable floor-frozen state together (the platform
   *  floor freeze/unfreeze); returns null when the room has no binding. */
  setActive(roomId: string, active: boolean, floorFrozen: boolean): Promise<BindingRecord | null>;
  clear(): Promise<void>;
}
export interface AgentActionStore {
  append(action: AgentActionRecord): Promise<AgentActionRecord>;
  listByRoom(roomId: string, limit: number): Promise<AgentActionRecord[]>;
  clear(): Promise<void>;
}
export interface TreasuryActionStore {
  append(action: TreasuryActionRecord): Promise<TreasuryActionRecord>;
  /** Executed (accepted) actions in a category, for kernel window/interval history. */
  acceptedByRoom(roomId: string): Promise<TreasuryActionRecord[]>;
  clear(): Promise<void>;
}
export interface PendingRemoderationStore {
  /**
   * Enqueue a contribution whose in-room moderation was deferred (model outage).
   * UPSERT by (roomId, subjectRef): a re-defer of the same contribution is a no-op
   * that preserves the original `enqueuedAt` + `attempts`, so an ongoing outage
   * neither duplicates the row nor resets its age/retry history. Stores ONLY soft
   * refs + bookkeeping — the moderation context is RECONSTRUCTED from the live
   * content stores at retry time, never persisted here (no UGC in this table).
   */
  enqueue(record: { roomId: string; subjectRef: string; enqueuedAt: string }): Promise<void>;
  /** Pending items OLDEST-first (enqueue order), bounded — the sweep drains in FIFO. */
  list(limit: number): Promise<PendingRemoderationRecord[]>;
  /** Record a retry attempt (attempts += 1, lastAttemptAt = at); no-op if absent. */
  markAttempt(roomId: string, subjectRef: string, at: string): Promise<void>;
  /** Remove a resolved item (decision applied, benign, moot, or deleted); no-op if absent. */
  remove(roomId: string, subjectRef: string): Promise<void>;
  clear(): Promise<void>;
}

// --- In-memory adapters ----------------------------------------------------

export class InMemorySeatStore implements SeatStore {
  private readonly seats = new Map<string, StewardSeatRecord>();
  async get(roomId: string) {
    return this.seats.get(roomId) ?? null;
  }
  async put(seat: StewardSeatRecord) {
    this.seats.set(seat.roomId, seat);
    return seat;
  }
  async list() {
    return [...this.seats.values()];
  }
  async clear() {
    this.seats.clear();
  }
}

export class InMemoryElectionStore implements ElectionStore {
  private readonly elections = new Map<string, ElectionRecord>();
  async insert(election: ElectionRecord) {
    // Enforce one OPEN election per room atomically (mirrors the DB partial unique
    // index), so two concurrent opens cannot both succeed.
    if (election.status === 'open') {
      for (const e of this.elections.values()) {
        if (e.roomId === election.roomId && e.status === 'open') return null;
      }
    }
    this.elections.set(election.electionId, election);
    return election;
  }
  async get(electionId: string) {
    return this.elections.get(electionId) ?? null;
  }
  async listByRoom(roomId: string) {
    return [...this.elections.values()].filter((e) => e.roomId === roomId);
  }
  async patch(electionId: string, fields: Partial<ElectionRecord>) {
    const cur = this.elections.get(electionId);
    if (!cur) return null;
    const next = { ...cur, ...fields };
    this.elections.set(electionId, next);
    return next;
  }
  async clear() {
    this.elections.clear();
  }
}

export class InMemoryVoteStore implements VoteStore {
  private readonly votes = new Map<string, VoteRecord>();
  private key(electionId: string, voterUserId: string) {
    return `${electionId}:${voterUserId}`;
  }
  async cast(vote: VoteRecord) {
    const key = this.key(vote.electionId, vote.voterUserId);
    if (this.votes.has(key)) return null;
    this.votes.set(key, vote);
    return vote;
  }
  async listByElection(electionId: string) {
    return [...this.votes.values()].filter((v) => v.electionId === electionId);
  }
  async clear() {
    this.votes.clear();
  }
}

export class InMemoryModelStore implements ModelStore {
  private readonly models = new Map<string, ModelRecord>();
  async insert(model: ModelRecord) {
    for (const m of this.models.values()) {
      if (m.roomId === model.roomId && m.artifactDigest === model.artifactDigest) return null;
    }
    this.models.set(model.modelId, model);
    return model;
  }
  async get(modelId: string) {
    return this.models.get(modelId) ?? null;
  }
  async listByRoom(roomId: string) {
    return [...this.models.values()].filter((m) => m.roomId === roomId);
  }
  async listByStatus(status: ModelStatus, limit: number) {
    return [...this.models.values()]
      .filter((m) => m.status === status)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .slice(0, Math.max(0, limit));
  }
  async patchStatus(
    modelId: string,
    status: ModelStatus,
    evaluationRef: string | null,
    admittedBackendId?: string | null,
  ) {
    const cur = this.models.get(modelId);
    if (!cur) return null;
    const next: ModelRecord = {
      ...cur,
      status,
      evaluationRef,
      ...(admittedBackendId !== undefined ? { admittedBackendId } : {}),
    };
    this.models.set(modelId, next);
    return next;
  }
  async clear() {
    this.models.clear();
  }
}

export class InMemoryPromptStore implements PromptStore {
  private readonly prompts = new Map<string, PromptRecord>();
  async insert(prompt: PromptRecord) {
    this.prompts.set(prompt.promptId, prompt);
    return prompt;
  }
  async get(promptId: string) {
    return this.prompts.get(promptId) ?? null;
  }
  async getByModel(modelId: string) {
    for (const p of this.prompts.values()) {
      if (p.modelId === modelId) return p;
    }
    return null;
  }
  async clear() {
    this.prompts.clear();
  }
}

export class InMemoryLawPackStore implements LawPackStore {
  private readonly lawPacks = new Map<string, LawPackRecord>();
  async insert(lawPack: LawPackRecord) {
    this.lawPacks.set(lawPack.lawPackId, lawPack);
    return lawPack;
  }
  async get(lawPackId: string) {
    return this.lawPacks.get(lawPackId) ?? null;
  }
  async listByRoom(roomId: string) {
    return [...this.lawPacks.values()]
      .filter((p) => p.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async clear() {
    this.lawPacks.clear();
  }
}

export class InMemoryRatificationVoteStore implements RatificationVoteStore {
  private readonly votes = new Map<string, RatificationVoteRecord>();
  async insert(vote: RatificationVoteRecord) {
    // Enforce one OPEN vote per room atomically (mirrors the DB partial unique
    // index), so two concurrent opens cannot both succeed.
    if (vote.status === 'open') {
      for (const v of this.votes.values()) {
        if (v.roomId === vote.roomId && v.status === 'open') return null;
      }
    }
    this.votes.set(vote.voteId, vote);
    return vote;
  }
  async get(voteId: string) {
    return this.votes.get(voteId) ?? null;
  }
  async getOpenForRoom(roomId: string) {
    for (const v of this.votes.values()) {
      if (v.roomId === roomId && v.status === 'open') return v;
    }
    return null;
  }
  async listOpen() {
    return [...this.votes.values()].filter((v) => v.status === 'open');
  }
  async patch(voteId: string, fields: Partial<RatificationVoteRecord>) {
    const cur = this.votes.get(voteId);
    if (!cur) return null;
    const next = { ...cur, ...fields };
    this.votes.set(voteId, next);
    return next;
  }
  async clear() {
    this.votes.clear();
  }
}

export class InMemoryRatificationBallotStore implements RatificationBallotStore {
  private readonly ballots = new Map<string, RatificationBallotRecord>();
  private key(voteId: string, voterUserId: string) {
    return `${voteId}:${voterUserId}`;
  }
  async cast(ballot: RatificationBallotRecord) {
    const key = this.key(ballot.voteId, ballot.voterUserId);
    if (this.ballots.has(key)) return null;
    this.ballots.set(key, ballot);
    return ballot;
  }
  async listByVote(voteId: string) {
    return [...this.ballots.values()].filter((b) => b.voteId === voteId);
  }
  async clear() {
    this.ballots.clear();
  }
}

export class InMemoryBindingStore implements BindingStore {
  private readonly bindings = new Map<string, BindingRecord>();
  async get(roomId: string) {
    return this.bindings.get(roomId) ?? null;
  }
  async put(binding: BindingRecord) {
    this.bindings.set(binding.roomId, binding);
    return binding;
  }
  async setActive(roomId: string, active: boolean, floorFrozen: boolean) {
    const cur = this.bindings.get(roomId);
    if (!cur) return null;
    const next = { ...cur, active, floorFrozen };
    this.bindings.set(roomId, next);
    return next;
  }
  async clear() {
    this.bindings.clear();
  }
}

export class InMemoryAgentActionStore implements AgentActionStore {
  private readonly actions: AgentActionRecord[] = [];
  async append(action: AgentActionRecord) {
    this.actions.push(action);
    return action;
  }
  async listByRoom(roomId: string, limit: number) {
    return this.actions
      .filter((a) => a.roomId === roomId)
      .slice(-limit)
      .reverse();
  }
  async clear() {
    this.actions.length = 0;
  }
}

export class InMemoryTreasuryActionStore implements TreasuryActionStore {
  private readonly actions: TreasuryActionRecord[] = [];
  async append(action: TreasuryActionRecord) {
    this.actions.push(action);
    return action;
  }
  async acceptedByRoom(roomId: string) {
    return this.actions
      .filter((a) => a.roomId === roomId && a.accepted)
      .map((a) => ({ ...a, amount: canonicalTreasuryAmount(a.amount) }));
  }
  async clear() {
    this.actions.length = 0;
  }
}

export class InMemoryPendingRemoderationStore implements PendingRemoderationStore {
  private readonly pending = new Map<string, PendingRemoderationRecord>();
  private key(roomId: string, subjectRef: string) {
    return `${roomId}\x00${subjectRef}`;
  }
  async enqueue(record: { roomId: string; subjectRef: string; enqueuedAt: string }) {
    const key = this.key(record.roomId, record.subjectRef);
    // Keep enqueuedAt + attempts on a re-defer (survive an ongoing outage); the
    // context is reconstructed at retry, never stored, so there is nothing to refresh.
    if (this.pending.has(key)) return;
    this.pending.set(key, {
      roomId: record.roomId,
      subjectRef: record.subjectRef,
      attempts: 0,
      enqueuedAt: record.enqueuedAt,
      lastAttemptAt: null,
    });
  }
  async list(limit: number) {
    return [...this.pending.values()]
      .sort((a, b) => {
        if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt < b.enqueuedAt ? -1 : 1;
        // Deterministic tiebreak on the same-instant enqueue.
        return a.subjectRef < b.subjectRef ? -1 : a.subjectRef > b.subjectRef ? 1 : 0;
      })
      .slice(0, Math.max(0, limit));
  }
  async markAttempt(roomId: string, subjectRef: string, at: string) {
    const key = this.key(roomId, subjectRef);
    const cur = this.pending.get(key);
    if (!cur) return;
    this.pending.set(key, { ...cur, attempts: cur.attempts + 1, lastAttemptAt: at });
  }
  async remove(roomId: string, subjectRef: string) {
    this.pending.delete(this.key(roomId, subjectRef));
  }
  async clear() {
    this.pending.clear();
  }
}

export interface GovernanceStores {
  seats: SeatStore;
  elections: ElectionStore;
  votes: VoteStore;
  models: ModelStore;
  prompts: PromptStore;
  ratifications: RatificationVoteStore;
  ratificationBallots: RatificationBallotStore;
  lawPacks: LawPackStore;
  bindings: BindingStore;
  agentActions: AgentActionStore;
  treasuryActions: TreasuryActionStore;
  pendingRemoderation: PendingRemoderationStore;
}

export function createInMemoryGovernanceStores(): GovernanceStores {
  return {
    seats: new InMemorySeatStore(),
    elections: new InMemoryElectionStore(),
    votes: new InMemoryVoteStore(),
    models: new InMemoryModelStore(),
    prompts: new InMemoryPromptStore(),
    ratifications: new InMemoryRatificationVoteStore(),
    ratificationBallots: new InMemoryRatificationBallotStore(),
    lawPacks: new InMemoryLawPackStore(),
    bindings: new InMemoryBindingStore(),
    agentActions: new InMemoryAgentActionStore(),
    treasuryActions: new InMemoryTreasuryActionStore(),
    pendingRemoderation: new InMemoryPendingRemoderationStore(),
  };
}
