// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U AI-governed-rooms tables, in a DEDICATED, isolated `knomosis` bounded
// context (SPEC §21.5, §22.2). Isolation rule (WS-D.3.2, extended): the ONLY
// hard foreign keys leaving this context point at `public.users` (the identity
// root / articulation node) or stay WITHIN `knomosis`. References to ranking/
// content tables (`public.rooms`, `public.contributions`, the WS-K registry) are
// **soft** (a bare uuid/text, no FK constraint), so NO SQL join path can connect
// governance/treasury data to the ranking/attention context — the structural
// "no pay-to-rank" guarantee. The schema-isolation test classifies every table
// here into the wallet/Knomosis context and proves the BFS never reaches ranking.

import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const knomosisSchema = pgSchema('knomosis');

export const stewardElectionStatusEnum = knomosisSchema.enum('steward_election_status', [
  'scheduled',
  'open',
  'tallying',
  'settled',
  'cancelled',
]);

export const governanceVoteModeEnum = knomosisSchema.enum('governance_vote_mode', [
  'simulated',
  'testnet',
  'onchain',
]);

export const roomModelStatusEnum = knomosisSchema.enum('room_model_status', [
  'proposed',
  'evaluating',
  'eligible',
  'rejected',
  'approved',
  'superseded',
]);

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** The single elected-steward seat per room (WS-U.1.1a; SPEC §16.6). */
export const roomStewardSeats = knomosisSchema.table('room_steward_seat', {
  roomId: uuid('room_id').primaryKey(), // soft ref to public.rooms (isolation)
  holderUserId: uuid('holder_user_id').references(() => users.userId, { onDelete: 'set null' }),
  termStart: tz('term_start').notNull().defaultNow(),
  termEnd: tz('term_end').notNull(),
  bootstrap: boolean('bootstrap').notNull().default(true),
  currentElectionId: uuid('current_election_id'), // soft intra-context ref
  updatedAt: tz('updated_at').notNull().defaultNow(),
});
export type RoomStewardSeatRow = typeof roomStewardSeats.$inferSelect;

/** A steward election and its lifecycle (WS-U.1.1b; SPEC §16.6, §17.5). */
export const stewardElections = knomosisSchema.table(
  'steward_election',
  {
    electionId: uuid('election_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    status: stewardElectionStatusEnum('status').notNull().default('scheduled'),
    opensAt: tz('opens_at').notNull(),
    closesAt: tz('closes_at').notNull(),
    weightModel: text('weight_model').notNull().default('one_civic_account_one_vote'),
    winnerUserId: uuid('winner_user_id').references(() => users.userId, { onDelete: 'set null' }),
    tally: jsonb('tally'), // settled CandidateTally[] snapshot (survives voter erasure)
    mode: governanceVoteModeEnum('mode').notNull().default('simulated'),
    createdAt: tz('created_at').notNull().defaultNow(),
    settledAt: tz('settled_at'),
  },
  (t) => [index('steward_election_room_idx').on(t.roomId)],
);
export type StewardElectionRow = typeof stewardElections.$inferSelect;

/**
 * One member's simulated-mode ballot (WS-U.1.1c). The composite primary key
 * `(election_id, voter_user_id)` STRUCTURALLY enforces one ballot per voter per
 * election (the idempotent-ballot invariant the service relies on), so a
 * concurrent double-vote collides on the PK rather than racing a read-then-write.
 */
export const stewardGovernanceVotes = knomosisSchema.table(
  'steward_governance_vote',
  {
    electionId: uuid('election_id')
      .notNull()
      .references(() => stewardElections.electionId, { onDelete: 'cascade' }),
    voterUserId: uuid('voter_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    candidateUserId: uuid('candidate_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    weight: numeric('weight').notNull(),
    castAt: tz('cast_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.electionId, t.voterUserId] })],
);
export type StewardGovernanceVoteRow = typeof stewardGovernanceVotes.$inferSelect;

/** A steward-proposed, content-addressed governance model (WS-U.2.1a; SPEC §16.6, §24.2). */
export const roomGovernanceModels = knomosisSchema.table(
  'room_governance_model',
  {
    modelId: uuid('model_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    artifactDigest: text('artifact_digest').notNull(), // sha-256 hash-pin
    bundleDocument: jsonb('bundle_document').notNull(), // the GovernancePolicyBundle
    cardRef: uuid('card_ref'), // soft ref to the WS-K model card (cross-context)
    proposedByUserId: uuid('proposed_by_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    status: roomModelStatusEnum('status').notNull().default('proposed'),
    evaluationRef: uuid('evaluation_ref'), // soft ref to the WS-K evaluation decision
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('room_governance_model_room_idx').on(t.roomId),
    // A content-addressed bundle is unique PER ROOM (the in-room "this exact
    // model is already proposed" guarantee): a duplicate insert collides here
    // rather than relying on a read-then-write check.
    uniqueIndex('room_governance_model_room_digest_uq').on(t.roomId, t.artifactDigest),
  ],
);
export type RoomGovernanceModelRow = typeof roomGovernanceModels.$inferSelect;

/** The in-room prompt bound to a model proposal (WS-U.2.1b). */
export const roomGovernancePrompts = knomosisSchema.table('room_governance_prompt', {
  promptId: uuid('prompt_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull(), // soft ref
  modelId: uuid('model_id')
    .notNull()
    .references(() => roomGovernanceModels.modelId, { onDelete: 'cascade' }),
  promptDigest: text('prompt_digest').notNull(),
  promptText: text('prompt_text').notNull(),
  proposedByUserId: uuid('proposed_by_user_id').references(() => users.userId, {
    onDelete: 'set null',
  }),
  createdAt: tz('created_at').notNull().defaultNow(),
});
export type RoomGovernancePromptRow = typeof roomGovernancePrompts.$inferSelect;

export const modelRatificationStatusEnum = knomosisSchema.enum('model_ratification_status', [
  'open',
  'settled',
  'cancelled',
]);
export const modelRatificationOutcomeEnum = knomosisSchema.enum('model_ratification_outcome', [
  'approved',
  'rejected',
]);
export const modelRatificationChoiceEnum = knomosisSchema.enum('model_ratification_choice', [
  'approve',
  'reject',
]);

/**
 * A member ratification vote that ADOPTS a steward-proposed, platform-eligible
 * model (SPEC §16.6/§24.6). The model activates only on a quorum-meeting
 * approving majority at settle (fail-safe otherwise). The bounds being ratified
 * are the `law_pack_id` snapshot; the settled `tally` survives voter erasure.
 */
export const modelRatifications = knomosisSchema.table(
  'model_ratification',
  {
    voteId: uuid('vote_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    modelId: uuid('model_id')
      .notNull()
      .references(() => roomGovernanceModels.modelId, { onDelete: 'cascade' }),
    lawPackId: uuid('law_pack_id'), // soft intra-context ref (the bounds being ratified)
    status: modelRatificationStatusEnum('status').notNull().default('open'),
    opensAt: tz('opens_at').notNull(),
    closesAt: tz('closes_at').notNull(),
    minQuorum: integer('min_quorum').notNull(),
    openedByUserId: uuid('opened_by_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    tally: jsonb('tally'), // settled RatificationResult snapshot
    outcome: modelRatificationOutcomeEnum('outcome'),
    createdAt: tz('created_at').notNull().defaultNow(),
    settledAt: tz('settled_at'),
  },
  (t) => [
    index('model_ratification_room_idx').on(t.roomId),
    index('model_ratification_model_idx').on(t.modelId),
  ],
);
export type ModelRatificationRow = typeof modelRatifications.$inferSelect;

/** One member's ratification ballot (WS-U.2.3). The composite PK enforces one
 *  ballot per voter per vote (idempotent cast, no read-then-write race). */
export const modelRatificationBallots = knomosisSchema.table(
  'model_ratification_ballot',
  {
    voteId: uuid('vote_id')
      .notNull()
      .references(() => modelRatifications.voteId, { onDelete: 'cascade' }),
    voterUserId: uuid('voter_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    choice: modelRatificationChoiceEnum('choice').notNull(),
    castAt: tz('cast_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.voteId, t.voterUserId] })],
);
export type ModelRatificationBallotRow = typeof modelRatificationBallots.$inferSelect;

/** The room's machine-readable, community-voted law-pack (WS-U.4.1a; SPEC §17.3.4). */
export const roomLawPacks = knomosisSchema.table(
  'room_law_pack',
  {
    lawPackId: uuid('law_pack_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    version: text('version').notNull(),
    document: jsonb('document').notNull(), // the LawPack
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('room_law_pack_room_idx').on(t.roomId)],
);
export type RoomLawPackRow = typeof roomLawPacks.$inferSelect;

/** The active (model, prompt, law-pack) binding per room (WS-U.2.4a). */
export const roomAgentBindings = knomosisSchema.table('room_agent_binding', {
  roomId: uuid('room_id').primaryKey(), // soft ref; one binding per room
  modelId: uuid('model_id')
    .notNull()
    .references(() => roomGovernanceModels.modelId, { onDelete: 'restrict' }),
  promptId: uuid('prompt_id')
    .notNull()
    .references(() => roomGovernancePrompts.promptId, { onDelete: 'restrict' }),
  lawPackId: uuid('law_pack_id').references(() => roomLawPacks.lawPackId, { onDelete: 'set null' }),
  approvedByElectionId: uuid('approved_by_election_id'), // soft intra-context ref
  capabilityDescriptor: jsonb('capability_descriptor').notNull(), // the derived descriptor
  active: boolean('active').notNull().default(false),
  approvedAt: tz('approved_at').notNull().defaultNow(),
});
export type RoomAgentBindingRow = typeof roomAgentBindings.$inferSelect;

/** Append-only log of every agent action with its provenance triple (WS-U.3.2b). */
export const agentActionLogs = knomosisSchema.table(
  'agent_action_log',
  {
    actionId: uuid('action_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    bindingModelId: uuid('binding_model_id').notNull(), // soft ref to the acting model
    promptHash: text('prompt_hash').notNull(),
    actionType: text('action_type').notNull(),
    subjectRef: text('subject_ref').notNull(), // soft ref to the moderated contribution
    lawPackRuleRef: text('law_pack_rule_ref'),
    statementOfReasons: text('statement_of_reasons').notNull(),
    reversible: boolean('reversible').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('agent_action_log_room_idx').on(t.roomId)],
);
export type AgentActionLogRow = typeof agentActionLogs.$inferSelect;

/** Log of agent-submitted treasury actions and their kernel verdicts (WS-U.5). */
export const agentTreasuryActions = knomosisSchema.table(
  'agent_treasury_action',
  {
    actionId: uuid('action_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    category: text('category').notNull(),
    amount: numeric('amount').notNull(),
    asset: text('asset'),
    accepted: boolean('accepted').notNull(),
    verdict: jsonb('verdict').notNull(), // the kernel Verdict (evidence or rejection)
    executedAt: tz('executed_at').notNull().defaultNow(),
  },
  (t) => [index('agent_treasury_action_room_idx').on(t.roomId)],
);
export type AgentTreasuryActionRow = typeof agentTreasuryActions.$inferSelect;
