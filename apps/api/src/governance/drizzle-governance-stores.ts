// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapters for the WS-U governance stores, behind the SAME
// interfaces as the in-memory adapters (the house policy), covered by the gated
// integration tests that run the real migration chain (incl. 0035's `knomosis`
// bounded context and 0036's vote PK + model digest uniqueness). The structural
// guarantees the in-memory adapters maintain by convention are enforced here by
// the schema: a double ballot collides on the composite PK, and a duplicate
// model collides on the `(room_id, artifact_digest)` unique index — no
// read-then-write race. Domain documents (bundle, law-pack, descriptor, tally,
// verdict) round-trip through the jsonb columns.

import {
  agentActionLogs,
  agentTreasuryActions,
  type createDbClient,
  modelRatificationBallots,
  modelRatifications,
  roomAgentBindings,
  roomGovernanceModels,
  roomGovernancePrompts,
  roomLawPacks,
  roomPendingRemoderations,
  roomStewardSeats,
  stewardElections,
  stewardGovernanceVotes,
} from '@licio/db';
import type {
  CandidateTally,
  CapabilityDescriptor,
  GovernancePolicyBundle,
  LawPack,
  RatificationResult,
  Verdict,
} from '@licio/governance';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
  AgentActionRecord,
  AgentActionStore,
  BindingRecord,
  BindingStore,
  ElectionRecord,
  ElectionStore,
  GovernanceStores,
  LawPackRecord,
  LawPackStore,
  ModelRecord,
  ModelStatus,
  ModelStore,
  PendingRemoderationRecord,
  PendingRemoderationStore,
  PromptRecord,
  PromptStore,
  RatificationBallotRecord,
  RatificationBallotStore,
  RatificationVoteRecord,
  RatificationVoteStore,
  SeatStore,
  StewardSeatRecord,
  TreasuryActionRecord,
  TreasuryActionStore,
  VoteRecord,
  VoteStore,
} from './stores.js';
import { canonicalTreasuryAmount } from './stores.js';

type Db = ReturnType<typeof createDbClient>;

// --- row ↔ record mappers --------------------------------------------------

function toSeat(row: typeof roomStewardSeats.$inferSelect): StewardSeatRecord {
  return {
    roomId: row.roomId,
    holderUserId: row.holderUserId,
    termStart: row.termStart.toISOString(),
    termEnd: row.termEnd.toISOString(),
    bootstrap: row.bootstrap,
    currentElectionId: row.currentElectionId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toElection(row: typeof stewardElections.$inferSelect): ElectionRecord {
  return {
    electionId: row.electionId,
    roomId: row.roomId,
    status: row.status,
    opensAt: row.opensAt.toISOString(),
    closesAt: row.closesAt.toISOString(),
    weightModel: row.weightModel,
    winnerUserId: row.winnerUserId,
    tally: (row.tally as CandidateTally[] | null) ?? null,
    mode: row.mode,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
  };
}

function toVote(row: typeof stewardGovernanceVotes.$inferSelect): VoteRecord {
  return {
    electionId: row.electionId,
    voterUserId: row.voterUserId,
    candidateUserId: row.candidateUserId,
    weight: Number(row.weight),
    castAt: row.castAt.toISOString(),
  };
}

function toModel(row: typeof roomGovernanceModels.$inferSelect): ModelRecord {
  return {
    modelId: row.modelId,
    roomId: row.roomId,
    artifactDigest: row.artifactDigest,
    bundle: row.bundleDocument as GovernancePolicyBundle,
    cardRef: row.cardRef,
    proposedByUserId: row.proposedByUserId,
    status: row.status,
    evaluationRef: row.evaluationRef,
    admittedBackendId: row.admittedBackendId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toPrompt(row: typeof roomGovernancePrompts.$inferSelect): PromptRecord {
  return {
    promptId: row.promptId,
    roomId: row.roomId,
    modelId: row.modelId,
    promptDigest: row.promptDigest,
    promptText: row.promptText,
    proposedByUserId: row.proposedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toLawPack(row: typeof roomLawPacks.$inferSelect): LawPackRecord {
  return {
    lawPackId: row.lawPackId,
    roomId: row.roomId,
    version: row.version,
    lawPack: row.document as LawPack,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRatification(row: typeof modelRatifications.$inferSelect): RatificationVoteRecord {
  return {
    voteId: row.voteId,
    roomId: row.roomId,
    modelId: row.modelId,
    lawPackId: row.lawPackId,
    status: row.status,
    opensAt: row.opensAt.toISOString(),
    closesAt: row.closesAt.toISOString(),
    minQuorum: row.minQuorum,
    eligibleCount: row.eligibleCount,
    openedByUserId: row.openedByUserId,
    tally: (row.tally as RatificationResult | null) ?? null,
    outcome: row.outcome,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
  };
}

function toRatificationBallot(
  row: typeof modelRatificationBallots.$inferSelect,
): RatificationBallotRecord {
  return {
    voteId: row.voteId,
    voterUserId: row.voterUserId,
    choice: row.choice,
    castAt: row.castAt.toISOString(),
  };
}

function toBinding(row: typeof roomAgentBindings.$inferSelect): BindingRecord {
  return {
    roomId: row.roomId,
    modelId: row.modelId,
    promptId: row.promptId,
    lawPackId: row.lawPackId,
    approvedByElectionId: row.approvedByElectionId,
    capabilityDescriptor: row.capabilityDescriptor as CapabilityDescriptor,
    active: row.active,
    floorFrozen: row.floorFrozen,
    approvedAt: row.approvedAt.toISOString(),
  };
}

function toAgentAction(row: typeof agentActionLogs.$inferSelect): AgentActionRecord {
  return {
    actionId: row.actionId,
    roomId: row.roomId,
    bindingModelId: row.bindingModelId,
    promptHash: row.promptHash,
    actionType: row.actionType,
    subjectRef: row.subjectRef,
    lawPackRuleRef: row.lawPackRuleRef,
    statementOfReasons: row.statementOfReasons,
    reversible: row.reversible,
    createdAt: row.createdAt.toISOString(),
  };
}

function toTreasury(row: typeof agentTreasuryActions.$inferSelect): TreasuryActionRecord {
  return {
    actionId: row.actionId,
    roomId: row.roomId,
    category: row.category,
    // Postgres `numeric` always deserializes to a string; canonicalize it the
    // SAME way the in-memory store does so both adapters return the identical
    // form for a given value — a lossless number, else the exact string (a
    // minor-unit amount above 2^53 stays a string; the kernel does exact decimal
    // math either way).
    amount: canonicalTreasuryAmount(row.amount),
    asset: row.asset,
    targetAllocation:
      (row.targetAllocation as TreasuryActionRecord['targetAllocation'] | null) ?? null,
    accepted: row.accepted,
    verdict: row.verdict as Verdict,
    executedAt: row.executedAt.toISOString(),
  };
}

function toPendingRemoderation(
  row: typeof roomPendingRemoderations.$inferSelect,
): PendingRemoderationRecord {
  return {
    roomId: row.roomId,
    subjectRef: row.subjectRef,
    attempts: row.attempts,
    enqueuedAt: row.enqueuedAt.toISOString(),
    lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
  };
}

// --- adapters --------------------------------------------------------------

export class DrizzleSeatStore implements SeatStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async get(roomId: string): Promise<StewardSeatRecord | null> {
    const rows = await this.#db
      .select()
      .from(roomStewardSeats)
      .where(eq(roomStewardSeats.roomId, roomId))
      .limit(1);
    return rows[0] ? toSeat(rows[0]) : null;
  }

  async put(seat: StewardSeatRecord): Promise<StewardSeatRecord> {
    const shared = {
      holderUserId: seat.holderUserId,
      termStart: new Date(seat.termStart),
      termEnd: new Date(seat.termEnd),
      bootstrap: seat.bootstrap,
      currentElectionId: seat.currentElectionId,
      updatedAt: new Date(seat.updatedAt),
    };
    await this.#db
      .insert(roomStewardSeats)
      .values({ roomId: seat.roomId, ...shared })
      .onConflictDoUpdate({ target: roomStewardSeats.roomId, set: shared });
    return seat;
  }

  async list(): Promise<StewardSeatRecord[]> {
    const rows = await this.#db.select().from(roomStewardSeats);
    return rows.map(toSeat);
  }

  async clear(): Promise<void> {
    await this.#db.delete(roomStewardSeats);
  }
}

export class DrizzleElectionStore implements ElectionStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(election: ElectionRecord): Promise<ElectionRecord | null> {
    // A second OPEN election for the room collides on the partial unique index
    // (one-open-per-room) and returns [] — the atomic guard against two opens.
    const rows = await this.#db
      .insert(stewardElections)
      .values({
        electionId: election.electionId,
        roomId: election.roomId,
        status: election.status,
        opensAt: new Date(election.opensAt),
        closesAt: new Date(election.closesAt),
        weightModel: election.weightModel,
        winnerUserId: election.winnerUserId,
        tally: election.tally,
        mode: election.mode,
        createdAt: new Date(election.createdAt),
        settledAt: election.settledAt ? new Date(election.settledAt) : null,
      })
      .onConflictDoNothing({
        target: stewardElections.roomId,
        where: sql`${stewardElections.status} = 'open'`,
      })
      .returning();
    return rows[0] ? toElection(rows[0]) : null;
  }

  async get(electionId: string): Promise<ElectionRecord | null> {
    const rows = await this.#db
      .select()
      .from(stewardElections)
      .where(eq(stewardElections.electionId, electionId))
      .limit(1);
    return rows[0] ? toElection(rows[0]) : null;
  }

  async listByRoom(roomId: string): Promise<ElectionRecord[]> {
    const rows = await this.#db
      .select()
      .from(stewardElections)
      .where(eq(stewardElections.roomId, roomId))
      .orderBy(asc(stewardElections.createdAt));
    return rows.map(toElection);
  }

  async patch(electionId: string, fields: Partial<ElectionRecord>): Promise<ElectionRecord | null> {
    const set: Partial<typeof stewardElections.$inferInsert> = {};
    if (fields.status !== undefined) set.status = fields.status;
    if (fields.winnerUserId !== undefined) set.winnerUserId = fields.winnerUserId;
    if (fields.tally !== undefined) set.tally = fields.tally;
    if (fields.mode !== undefined) set.mode = fields.mode;
    if (fields.weightModel !== undefined) set.weightModel = fields.weightModel;
    if (fields.roomId !== undefined) set.roomId = fields.roomId;
    if (fields.opensAt !== undefined) set.opensAt = new Date(fields.opensAt);
    if (fields.closesAt !== undefined) set.closesAt = new Date(fields.closesAt);
    if (fields.settledAt !== undefined) {
      set.settledAt = fields.settledAt === null ? null : new Date(fields.settledAt);
    }
    if (Object.keys(set).length === 0) return this.get(electionId);
    const rows = await this.#db
      .update(stewardElections)
      .set(set)
      .where(eq(stewardElections.electionId, electionId))
      .returning();
    return rows[0] ? toElection(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(stewardElections);
  }
}

export class DrizzleVoteStore implements VoteStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async cast(vote: VoteRecord): Promise<VoteRecord | null> {
    // The composite PK makes a second ballot from the same voter a no-op
    // conflict (idempotent), with no read-then-write race.
    const rows = await this.#db
      .insert(stewardGovernanceVotes)
      .values({
        electionId: vote.electionId,
        voterUserId: vote.voterUserId,
        candidateUserId: vote.candidateUserId,
        weight: String(vote.weight),
        castAt: new Date(vote.castAt),
      })
      .onConflictDoNothing({
        target: [stewardGovernanceVotes.electionId, stewardGovernanceVotes.voterUserId],
      })
      .returning();
    return rows[0] ? toVote(rows[0]) : null;
  }

  async listByElection(electionId: string): Promise<VoteRecord[]> {
    const rows = await this.#db
      .select()
      .from(stewardGovernanceVotes)
      .where(eq(stewardGovernanceVotes.electionId, electionId));
    return rows.map(toVote);
  }

  async clear(): Promise<void> {
    await this.#db.delete(stewardGovernanceVotes);
  }
}

export class DrizzleModelStore implements ModelStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(model: ModelRecord): Promise<ModelRecord | null> {
    // A duplicate (room, digest) collides on the unique index (returns []).
    const rows = await this.#db
      .insert(roomGovernanceModels)
      .values({
        modelId: model.modelId,
        roomId: model.roomId,
        artifactDigest: model.artifactDigest,
        bundleDocument: model.bundle,
        cardRef: model.cardRef,
        proposedByUserId: model.proposedByUserId,
        status: model.status,
        evaluationRef: model.evaluationRef,
        admittedBackendId: model.admittedBackendId,
        createdAt: new Date(model.createdAt),
      })
      .onConflictDoNothing({
        target: [roomGovernanceModels.roomId, roomGovernanceModels.artifactDigest],
      })
      .returning();
    return rows[0] ? toModel(rows[0]) : null;
  }

  async get(modelId: string): Promise<ModelRecord | null> {
    const rows = await this.#db
      .select()
      .from(roomGovernanceModels)
      .where(eq(roomGovernanceModels.modelId, modelId))
      .limit(1);
    return rows[0] ? toModel(rows[0]) : null;
  }

  async listByRoom(roomId: string): Promise<ModelRecord[]> {
    const rows = await this.#db
      .select()
      .from(roomGovernanceModels)
      .where(eq(roomGovernanceModels.roomId, roomId))
      .orderBy(asc(roomGovernanceModels.createdAt));
    return rows.map(toModel);
  }

  async patchStatus(
    modelId: string,
    status: ModelStatus,
    evaluationRef: string | null,
    admittedBackendId?: string | null,
  ): Promise<ModelRecord | null> {
    const set: Partial<typeof roomGovernanceModels.$inferInsert> = { status, evaluationRef };
    if (admittedBackendId !== undefined) set.admittedBackendId = admittedBackendId;
    const rows = await this.#db
      .update(roomGovernanceModels)
      .set(set)
      .where(eq(roomGovernanceModels.modelId, modelId))
      .returning();
    return rows[0] ? toModel(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(roomGovernanceModels);
  }
}

export class DrizzlePromptStore implements PromptStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(prompt: PromptRecord): Promise<PromptRecord> {
    await this.#db.insert(roomGovernancePrompts).values({
      promptId: prompt.promptId,
      roomId: prompt.roomId,
      modelId: prompt.modelId,
      promptDigest: prompt.promptDigest,
      promptText: prompt.promptText,
      proposedByUserId: prompt.proposedByUserId,
      createdAt: new Date(prompt.createdAt),
    });
    return prompt;
  }

  async get(promptId: string): Promise<PromptRecord | null> {
    const rows = await this.#db
      .select()
      .from(roomGovernancePrompts)
      .where(eq(roomGovernancePrompts.promptId, promptId))
      .limit(1);
    return rows[0] ? toPrompt(rows[0]) : null;
  }

  async getByModel(modelId: string): Promise<PromptRecord | null> {
    const rows = await this.#db
      .select()
      .from(roomGovernancePrompts)
      .where(eq(roomGovernancePrompts.modelId, modelId))
      .orderBy(asc(roomGovernancePrompts.createdAt))
      .limit(1);
    return rows[0] ? toPrompt(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(roomGovernancePrompts);
  }
}

export class DrizzleLawPackStore implements LawPackStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(lawPack: LawPackRecord): Promise<LawPackRecord> {
    await this.#db.insert(roomLawPacks).values({
      lawPackId: lawPack.lawPackId,
      roomId: lawPack.roomId,
      version: lawPack.version,
      document: lawPack.lawPack,
      createdAt: new Date(lawPack.createdAt),
    });
    return lawPack;
  }

  async get(lawPackId: string): Promise<LawPackRecord | null> {
    const rows = await this.#db
      .select()
      .from(roomLawPacks)
      .where(eq(roomLawPacks.lawPackId, lawPackId))
      .limit(1);
    return rows[0] ? toLawPack(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(roomLawPacks);
  }
}

export class DrizzleBindingStore implements BindingStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async get(roomId: string): Promise<BindingRecord | null> {
    const rows = await this.#db
      .select()
      .from(roomAgentBindings)
      .where(eq(roomAgentBindings.roomId, roomId))
      .limit(1);
    return rows[0] ? toBinding(rows[0]) : null;
  }

  async put(binding: BindingRecord): Promise<BindingRecord> {
    const shared = {
      modelId: binding.modelId,
      promptId: binding.promptId,
      lawPackId: binding.lawPackId,
      approvedByElectionId: binding.approvedByElectionId,
      capabilityDescriptor: binding.capabilityDescriptor,
      active: binding.active,
      floorFrozen: binding.floorFrozen,
      approvedAt: new Date(binding.approvedAt),
    };
    await this.#db
      .insert(roomAgentBindings)
      .values({ roomId: binding.roomId, ...shared })
      .onConflictDoUpdate({ target: roomAgentBindings.roomId, set: shared });
    return binding;
  }

  async setActive(
    roomId: string,
    active: boolean,
    floorFrozen: boolean,
  ): Promise<BindingRecord | null> {
    const rows = await this.#db
      .update(roomAgentBindings)
      .set({ active, floorFrozen })
      .where(eq(roomAgentBindings.roomId, roomId))
      .returning();
    return rows[0] ? toBinding(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(roomAgentBindings);
  }
}

export class DrizzleAgentActionStore implements AgentActionStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async append(action: AgentActionRecord): Promise<AgentActionRecord> {
    await this.#db.insert(agentActionLogs).values({
      actionId: action.actionId,
      roomId: action.roomId,
      bindingModelId: action.bindingModelId,
      promptHash: action.promptHash,
      actionType: action.actionType,
      subjectRef: action.subjectRef,
      lawPackRuleRef: action.lawPackRuleRef,
      statementOfReasons: action.statementOfReasons,
      reversible: action.reversible,
      createdAt: new Date(action.createdAt),
    });
    return action;
  }

  async listByRoom(roomId: string, limit: number): Promise<AgentActionRecord[]> {
    const rows = await this.#db
      .select()
      .from(agentActionLogs)
      .where(eq(agentActionLogs.roomId, roomId))
      .orderBy(desc(agentActionLogs.createdAt), desc(agentActionLogs.actionId))
      .limit(limit);
    return rows.map(toAgentAction);
  }

  async clear(): Promise<void> {
    await this.#db.delete(agentActionLogs);
  }
}

export class DrizzleTreasuryActionStore implements TreasuryActionStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async append(action: TreasuryActionRecord): Promise<TreasuryActionRecord> {
    await this.#db.insert(agentTreasuryActions).values({
      actionId: action.actionId,
      roomId: action.roomId,
      category: action.category,
      amount: String(action.amount),
      asset: action.asset,
      targetAllocation: action.targetAllocation ?? null,
      accepted: action.accepted,
      verdict: action.verdict,
      executedAt: new Date(action.executedAt),
    });
    return action;
  }

  async acceptedByRoom(roomId: string): Promise<TreasuryActionRecord[]> {
    const rows = await this.#db
      .select()
      .from(agentTreasuryActions)
      .where(and(eq(agentTreasuryActions.roomId, roomId), eq(agentTreasuryActions.accepted, true)))
      .orderBy(asc(agentTreasuryActions.executedAt));
    return rows.map(toTreasury);
  }

  async clear(): Promise<void> {
    await this.#db.delete(agentTreasuryActions);
  }
}

export class DrizzleRatificationVoteStore implements RatificationVoteStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(vote: RatificationVoteRecord): Promise<RatificationVoteRecord | null> {
    // A second OPEN vote for the room collides on the partial unique index
    // (one-open-per-room) and returns [] — the atomic guard against two opens.
    const rows = await this.#db
      .insert(modelRatifications)
      .values({
        voteId: vote.voteId,
        roomId: vote.roomId,
        modelId: vote.modelId,
        lawPackId: vote.lawPackId,
        status: vote.status,
        opensAt: new Date(vote.opensAt),
        closesAt: new Date(vote.closesAt),
        minQuorum: vote.minQuorum,
        eligibleCount: vote.eligibleCount,
        openedByUserId: vote.openedByUserId,
        tally: vote.tally,
        outcome: vote.outcome,
        createdAt: new Date(vote.createdAt),
        settledAt: vote.settledAt ? new Date(vote.settledAt) : null,
      })
      .onConflictDoNothing({
        target: modelRatifications.roomId,
        where: sql`${modelRatifications.status} = 'open'`,
      })
      .returning();
    return rows[0] ? toRatification(rows[0]) : null;
  }

  async get(voteId: string): Promise<RatificationVoteRecord | null> {
    const rows = await this.#db
      .select()
      .from(modelRatifications)
      .where(eq(modelRatifications.voteId, voteId))
      .limit(1);
    return rows[0] ? toRatification(rows[0]) : null;
  }

  async getOpenForRoom(roomId: string): Promise<RatificationVoteRecord | null> {
    const rows = await this.#db
      .select()
      .from(modelRatifications)
      .where(and(eq(modelRatifications.roomId, roomId), eq(modelRatifications.status, 'open')))
      .orderBy(desc(modelRatifications.createdAt))
      .limit(1);
    return rows[0] ? toRatification(rows[0]) : null;
  }

  async listOpen(): Promise<RatificationVoteRecord[]> {
    const rows = await this.#db
      .select()
      .from(modelRatifications)
      .where(eq(modelRatifications.status, 'open'));
    return rows.map(toRatification);
  }

  async patch(
    voteId: string,
    fields: Partial<RatificationVoteRecord>,
  ): Promise<RatificationVoteRecord | null> {
    // Translate the FULL mutable surface (parity with the in-memory adapter, which
    // spreads every field) so a patch of any field is honoured by both adapters.
    const set: Partial<typeof modelRatifications.$inferInsert> = {};
    if (fields.status !== undefined) set.status = fields.status;
    if (fields.outcome !== undefined) set.outcome = fields.outcome;
    if (fields.tally !== undefined) set.tally = fields.tally;
    if (fields.lawPackId !== undefined) set.lawPackId = fields.lawPackId;
    if (fields.roomId !== undefined) set.roomId = fields.roomId;
    if (fields.modelId !== undefined) set.modelId = fields.modelId;
    if (fields.minQuorum !== undefined) set.minQuorum = fields.minQuorum;
    if (fields.openedByUserId !== undefined) set.openedByUserId = fields.openedByUserId;
    if (fields.opensAt !== undefined) set.opensAt = new Date(fields.opensAt);
    if (fields.closesAt !== undefined) set.closesAt = new Date(fields.closesAt);
    if (fields.createdAt !== undefined) set.createdAt = new Date(fields.createdAt);
    if (fields.settledAt !== undefined) {
      set.settledAt = fields.settledAt === null ? null : new Date(fields.settledAt);
    }
    if (Object.keys(set).length === 0) return this.get(voteId);
    const rows = await this.#db
      .update(modelRatifications)
      .set(set)
      .where(eq(modelRatifications.voteId, voteId))
      .returning();
    return rows[0] ? toRatification(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(modelRatifications);
  }
}

export class DrizzleRatificationBallotStore implements RatificationBallotStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async cast(ballot: RatificationBallotRecord): Promise<RatificationBallotRecord | null> {
    // The composite PK makes a second ballot from the same voter a no-op (idempotent).
    const rows = await this.#db
      .insert(modelRatificationBallots)
      .values({
        voteId: ballot.voteId,
        voterUserId: ballot.voterUserId,
        choice: ballot.choice,
        castAt: new Date(ballot.castAt),
      })
      .onConflictDoNothing({
        target: [modelRatificationBallots.voteId, modelRatificationBallots.voterUserId],
      })
      .returning();
    return rows[0] ? toRatificationBallot(rows[0]) : null;
  }

  async listByVote(voteId: string): Promise<RatificationBallotRecord[]> {
    const rows = await this.#db
      .select()
      .from(modelRatificationBallots)
      .where(eq(modelRatificationBallots.voteId, voteId));
    return rows.map(toRatificationBallot);
  }

  async clear(): Promise<void> {
    await this.#db.delete(modelRatificationBallots);
  }
}

export class DrizzlePendingRemoderationStore implements PendingRemoderationStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async enqueue(record: { roomId: string; subjectRef: string; enqueuedAt: string }): Promise<void> {
    // Insert on the composite PK; a re-defer is a no-op (DO NOTHING), preserving
    // attempts + enqueuedAt (parity with the in-memory adapter) — an ongoing outage
    // never duplicates the row nor resets its age/retry history. No content is
    // stored: the moderation context is reconstructed from the live stores at retry.
    await this.#db
      .insert(roomPendingRemoderations)
      .values({
        roomId: record.roomId,
        subjectRef: record.subjectRef,
        attempts: 0,
        enqueuedAt: new Date(record.enqueuedAt),
        lastAttemptAt: null,
      })
      .onConflictDoNothing({
        target: [roomPendingRemoderations.roomId, roomPendingRemoderations.subjectRef],
      });
  }

  async list(limit: number): Promise<PendingRemoderationRecord[]> {
    const rows = await this.#db
      .select()
      .from(roomPendingRemoderations)
      // Oldest-first FIFO drain; the same-instant tiebreak matches the in-memory adapter.
      .orderBy(asc(roomPendingRemoderations.enqueuedAt), asc(roomPendingRemoderations.subjectRef))
      .limit(Math.max(0, limit));
    return rows.map(toPendingRemoderation);
  }

  async markAttempt(roomId: string, subjectRef: string, at: string): Promise<void> {
    await this.#db
      .update(roomPendingRemoderations)
      .set({ attempts: sql`${roomPendingRemoderations.attempts} + 1`, lastAttemptAt: new Date(at) })
      .where(
        and(
          eq(roomPendingRemoderations.roomId, roomId),
          eq(roomPendingRemoderations.subjectRef, subjectRef),
        ),
      );
  }

  async remove(roomId: string, subjectRef: string): Promise<void> {
    await this.#db
      .delete(roomPendingRemoderations)
      .where(
        and(
          eq(roomPendingRemoderations.roomId, roomId),
          eq(roomPendingRemoderations.subjectRef, subjectRef),
        ),
      );
  }

  async clear(): Promise<void> {
    await this.#db.delete(roomPendingRemoderations);
  }
}

export function createDrizzleGovernanceStores(db: Db): GovernanceStores {
  return {
    seats: new DrizzleSeatStore(db),
    elections: new DrizzleElectionStore(db),
    votes: new DrizzleVoteStore(db),
    models: new DrizzleModelStore(db),
    prompts: new DrizzlePromptStore(db),
    ratifications: new DrizzleRatificationVoteStore(db),
    ratificationBallots: new DrizzleRatificationBallotStore(db),
    lawPacks: new DrizzleLawPackStore(db),
    bindings: new DrizzleBindingStore(db),
    agentActions: new DrizzleAgentActionStore(db),
    treasuryActions: new DrizzleTreasuryActionStore(db),
    pendingRemoderation: new DrizzlePendingRemoderationStore(db),
  };
}
