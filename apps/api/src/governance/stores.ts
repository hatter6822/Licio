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
}
export interface BindingRecord {
  roomId: string;
  modelId: string;
  promptId: string;
  lawPackId: string | null;
  approvedByElectionId: string | null;
  capabilityDescriptor: CapabilityDescriptor;
  active: boolean;
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
export interface TreasuryActionRecord {
  actionId: string;
  roomId: string;
  category: string;
  amount: number;
  asset: string | null;
  accepted: boolean;
  verdict: Verdict;
  executedAt: string;
}

export interface SeatStore {
  get(roomId: string): Promise<StewardSeatRecord | null>;
  put(seat: StewardSeatRecord): Promise<StewardSeatRecord>;
  list(): Promise<StewardSeatRecord[]>;
  clear(): Promise<void>;
}
export interface ElectionStore {
  insert(election: ElectionRecord): Promise<ElectionRecord>;
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
  patchStatus(
    modelId: string,
    status: ModelStatus,
    evaluationRef: string | null,
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
  clear(): Promise<void>;
}
export interface RatificationVoteStore {
  insert(vote: RatificationVoteRecord): Promise<RatificationVoteRecord>;
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
  setActive(roomId: string, active: boolean): Promise<BindingRecord | null>;
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
  async patchStatus(modelId: string, status: ModelStatus, evaluationRef: string | null) {
    const cur = this.models.get(modelId);
    if (!cur) return null;
    const next = { ...cur, status, evaluationRef };
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
  async clear() {
    this.lawPacks.clear();
  }
}

export class InMemoryRatificationVoteStore implements RatificationVoteStore {
  private readonly votes = new Map<string, RatificationVoteRecord>();
  async insert(vote: RatificationVoteRecord) {
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
  async setActive(roomId: string, active: boolean) {
    const cur = this.bindings.get(roomId);
    if (!cur) return null;
    const next = { ...cur, active };
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
    return this.actions.filter((a) => a.roomId === roomId && a.accepted);
  }
  async clear() {
    this.actions.length = 0;
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
  };
}
