// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L Knomosis gateway, wallets, and receipts tables (SPEC §22.2, §23.5), in
// the isolated `knomosis` bounded context established by WS-U.  Isolation rule
// (WS-D.3.2, extended): the ONLY hard foreign keys leaving this context point
// at `public.users` (the identity root) or stay WITHIN the wallet/knomosis
// context (e.g. `wallet.wallet_accounts`).  References to rooms/content are
// **soft** (a bare uuid, no FK constraint), so NO SQL join path can connect
// financial data to the ranking/attention context — the structural
// "no pay-to-rank" guarantee.  Every table here is registered in the
// schema-isolation allowlist (packages/db/src/isolation.ts) — an unlisted
// table fails the fail-closed classification check.
//
// Amount discipline (SPEC §22.2): monetary amounts are `numeric(78,0)` minor
// units read/written as decimal STRINGS (a uint256 cannot round-trip a JS
// double); the kernel and services compare them with exact decimal math.

import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { knomosisSchema } from './governance.js';
import { users } from './user.js';
import { walletAccounts } from './wallet/wallet-account.js';

const tz = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// KnomosisDeployment (WS-L.1.1a-1; SPEC §22.2)
// ---------------------------------------------------------------------------

export const knomosisEnvironmentEnum = knomosisSchema.enum('knomosis_environment', [
  'local',
  'testnet',
  'capped_production',
  'mature_production',
]);

export const knomosisDeploymentStatusEnum = knomosisSchema.enum('knomosis_deployment_status', [
  'provisioning',
  'active',
  'frozen',
  'retired',
]);

/** Pinned deployments, written ONLY by the reviewed config-sync (WS-L.1.1a-1). */
export const knomosisDeployments = knomosisSchema.table(
  'knomosis_deployment',
  {
    deploymentId: uuid('deployment_id').primaryKey(),
    environment: knomosisEnvironmentEnum('environment').notNull(),
    chainId: integer('chain_id').notNull(),
    // Lowercased 0x hex forms, CHECK-constrained in the migration.
    l1BridgeAddress: text('l1_bridge_address').notNull(),
    /** Config KEY reference — never a raw endpoint or credential. */
    runtimeEndpointRef: text('runtime_endpoint_ref').notNull(),
    contractManifestHash: text('contract_manifest_hash').notNull(),
    pinnedKnomosisCommit: text('pinned_knomosis_commit').notNull(),
    status: knomosisDeploymentStatusEnum('status').notNull().default('provisioning'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  // (environment, chain_id) is unique among ACTIVE-lifecycle rows only: a
  // RETIRED row (a pin the file rotated away) must not block the replacement pin
  // for the same environment/chain from syncing in (WS-L.1.1a-1).
  (t) => [
    uniqueIndex('knomosis_deployment_env_chain_idx')
      .on(t.environment, t.chainId)
      .where(sql`status <> 'retired'`),
  ],
);
export type KnomosisDeploymentRow = typeof knomosisDeployments.$inferSelect;

// ---------------------------------------------------------------------------
// OnChainEvent (WS-L.3.3c; SPEC §22.2 + gateway-contract alignment)
// ---------------------------------------------------------------------------

export const eventSourceEnum = knomosisSchema.enum('knomosis_event_source', ['chain', 'gateway']);

export const reorgStateEnum = knomosisSchema.enum('knomosis_reorg_state', [
  'pending',
  'confirmed',
  'reorged',
]);

export const onChainEvents = knomosisSchema.table(
  'on_chain_event',
  {
    eventId: uuid('event_id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => knomosisDeployments.deploymentId, { onDelete: 'cascade' }),
    chainId: integer('chain_id').notNull(),
    // L1 coordinates — REQUIRED for `chain` rows (CHECK in the migration).
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    txHash: text('tx_hash'),
    logIndex: integer('log_index'),
    eventType: text('event_type').notNull(),
    decodedPayload: jsonb('decoded_payload').notNull(),
    // Gateway cursor — REQUIRED for `gateway` rows (CHECK in the migration).
    eventSource: eventSourceEnum('event_source').notNull(),
    gatewaySeq: bigint('gateway_seq', { mode: 'bigint' }),
    gatewayIndex: integer('gateway_index'),
    reorgState: reorgStateEnum('reorg_state').notNull().default('pending'),
    reorgDetectedAt: tz('reorg_detected_at'),
    indexedAt: tz('indexed_at').notNull().defaultNow(),
  },
  (t) => [
    // Per-source idempotency keys (partial unique indexes, WS-L.3.3c): re-seeing
    // an event is a conflict/no-op, never a duplicate.
    uniqueIndex('on_chain_event_chain_key_idx')
      .on(t.deploymentId, t.txHash, t.logIndex)
      .where(sql`event_source = 'chain'`),
    uniqueIndex('on_chain_event_gateway_key_idx')
      .on(t.deploymentId, t.gatewaySeq, t.gatewayIndex)
      .where(sql`event_source = 'gateway'`),
    index('on_chain_event_order_idx').on(t.deploymentId, t.blockNumber, t.logIndex),
    index('on_chain_event_tx_idx').on(t.txHash),
    index('on_chain_event_type_idx').on(t.eventType, t.deploymentId),
  ],
);
export type OnChainEventRow = typeof onChainEvents.$inferSelect;

// ---------------------------------------------------------------------------
// KnomosisActionRecord (WS-L.3.2a/b; SPEC §22.2, §23.5)
// ---------------------------------------------------------------------------

export const knomosisActionTypeEnum = knomosisSchema.enum('knomosis_action_type', [
  'proposal_sign',
  'treasury_deposit',
  'grant_payout',
  'charter_update',
  'bounty_contribution',
  'steward_rotation',
]);

export const submissionStateEnum = knomosisSchema.enum('knomosis_submission_state', [
  // `reserving` is the pre-submit idempotency reservation (WS-L.3.2a): inserted
  // before the single-use preflight token/nonce are consumed, advanced to
  // `submitted` only after every submit gate passes.  Never forwarded to the
  // gateway and never reconciled — an abandoned reservation cannot reach the
  // kernel unvalidated.
  'reserving',
  'submitted',
  'accepted',
  'settled',
  'finalized',
  'challenged',
  'reverted',
  'frozen',
  'failed',
]);

export const reconciliationStateEnum = knomosisSchema.enum('knomosis_reconciliation_state', [
  'pending',
  'matched',
  'mismatch',
  'halted_unsupported_version',
]);

export const knomosisActionRecords = knomosisSchema.table(
  'knomosis_action_record',
  {
    actionRecordId: uuid('action_record_id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => knomosisDeployments.deploymentId, { onDelete: 'restrict' }),
    actionType: knomosisActionTypeEnum('action_type').notNull(),
    roomId: uuid('room_id').notNull(), // soft ref (isolation)
    /** The signing wallet — intra-context FK into the wallet schema. */
    actorWalletAccountId: uuid('actor_wallet_account_id')
      .notNull()
      .references(() => walletAccounts.walletAccountId, { onDelete: 'restrict' }),
    /** The authenticated account that submitted (identity root edge). */
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'restrict' }),
    payloadHash: text('payload_hash').notNull(),
    typedDataHash: text('typed_data_hash').notNull(),
    /** The exact signed payload (typed-data message + signature) for audit,
     *  gateway forwarding, and receipt pairing — the financial record of what
     *  was signed (never joins the social schema; isolation above). */
    signedAction: jsonb('signed_action').notNull(),
    submissionState: submissionStateEnum('submission_state').notNull().default('submitted'),
    failureReason: text('failure_reason'),
    indexedEventRef: uuid('indexed_event_ref').references(() => onChainEvents.eventId, {
      onDelete: 'set null',
    }),
    reconciliationState: reconciliationStateEnum('reconciliation_state')
      .notNull()
      .default('pending'),
    /** Client idempotency key, unique per submitting account (WS-L.3.2a). */
    idempotencyKey: uuid('idempotency_key').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knomosis_action_idem_idx').on(t.actorUserId, t.idempotencyKey),
    index('knomosis_action_room_idx').on(t.roomId),
    index('knomosis_action_state_idx').on(t.submissionState, t.deploymentId),
  ],
);
export type KnomosisActionRecordRow = typeof knomosisActionRecords.$inferSelect;

// ---------------------------------------------------------------------------
// Anti-replay nonces (WS-L.3.2c) — per (user, deployment), durable.
// ---------------------------------------------------------------------------

export const knomosisActionNonces = knomosisSchema.table(
  'knomosis_action_nonce',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => knomosisDeployments.deploymentId, { onDelete: 'cascade' }),
    /** uint256 nonce value (minor-unit-scale numeric; gaps permitted). */
    nonce: numeric('nonce', { precision: 78, scale: 0 }).notNull(),
    usedAt: tz('used_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.deploymentId, t.nonce] })],
);
export type KnomosisActionNonceRow = typeof knomosisActionNonces.$inferSelect;

// ---------------------------------------------------------------------------
// Wallet → gateway actor mapping (WS-L.3.6a) — per (wallet, deployment).
// ---------------------------------------------------------------------------

export const walletActorMappings = knomosisSchema.table(
  'wallet_actor_mapping',
  {
    walletAccountId: uuid('wallet_account_id')
      .notNull()
      .references(() => walletAccounts.walletAccountId, { onDelete: 'cascade' }),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => knomosisDeployments.deploymentId, { onDelete: 'cascade' }),
    /** Opaque Knomosis actor id (decimal string / 0x-hex per gateway contract). */
    actorId: text('actor_id').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.walletAccountId, t.deploymentId] })],
);
export type WalletActorMappingRow = typeof walletActorMappings.$inferSelect;

// ---------------------------------------------------------------------------
// GovernanceProposal + votes + signatures (WS-L.4.1b/d; SPEC §22.2)
// ---------------------------------------------------------------------------

export const proposalTypeEnum = knomosisSchema.enum('governance_proposal_type', [
  'charter_update',
  'bounty',
  'capped_grant',
]);

export const proposalPreflightStateEnum = knomosisSchema.enum('proposal_preflight_state', [
  'pending',
  'passed',
  'failed',
]);
export const proposalVotingStateEnum = knomosisSchema.enum('proposal_voting_state', [
  'open',
  'passed',
  'rejected',
  'quorum_not_met',
]);
export const proposalChallengeStateEnum = knomosisSchema.enum('proposal_challenge_state', [
  'none',
  'open',
  'upheld',
  'dismissed',
]);
export const proposalExecutionStateEnum = knomosisSchema.enum('proposal_execution_state', [
  'not_executed',
  'timelocked',
  // `executing` is the RECOVERABLE in-progress state (WS-L.4.1c): a proposal is
  // claimed `timelocked`→`executing` before the simulated debit and advanced to
  // `executed` only after the debit + ledger are durable, so a crash mid-execution
  // never leaves a falsely-`executed` proposal with no debit.
  'executing',
  'executed',
  'blocked',
]);

export const governanceProposals = knomosisSchema.table(
  'governance_proposal',
  {
    proposalId: uuid('proposal_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref (isolation)
    // Nullable: set NULL when the proposer's account is erased (the proposal +
    // other members' votes/signatures survive; WS-L data-rights).
    proposerUserId: uuid('proposer_user_id').references(() => users.userId, {
      onDelete: 'restrict',
    }),
    proposalType: proposalTypeEnum('proposal_type').notNull(),
    title: text('title').notNull(),
    plainLanguageSummary: text('plain_language_summary').notNull(),
    requestedAmount: numeric('requested_amount', { precision: 78, scale: 0 }),
    asset: text('asset'),
    recipientRef: text('recipient_ref'),
    conflictDisclosures: text('conflict_disclosures'),
    riskAssessment: text('risk_assessment').notNull(),
    requestedAction: jsonb('requested_action').notNull(),
    expectedDeliverable: text('expected_deliverable').notNull(),
    preflightState: proposalPreflightStateEnum('preflight_state').notNull().default('pending'),
    votingState: proposalVotingStateEnum('voting_state').notNull().default('open'),
    challengeState: proposalChallengeStateEnum('challenge_state').notNull().default('none'),
    executionState: proposalExecutionStateEnum('execution_state').notNull().default('not_executed'),
    /** True for K1 simulated-governance proposals (no on-chain effect ever). */
    simulationMode: boolean('simulation_mode').notNull().default(true),
    executableAfter: tz('executable_after'),
    createdAt: tz('created_at').notNull().defaultNow(),
    executedAt: tz('executed_at'),
    /** When `claimForExecution` CAS'd this row `timelocked`→`executing`.  The
     *  recovery sweep only re-drives a claim OLDER than its stale cutoff, so a
     *  live manual execution is never raced (and its `execution_simulated` audit
     *  row never mis-attributed to the null-actor sweep) — WS-L.4.1c / N2. */
    executionClaimedAt: tz('execution_claimed_at'),
  },
  (t) => [
    index('governance_proposal_room_idx').on(t.roomId, t.createdAt),
    // Serves the recovery-sweep query: stranded (`executing`) proposals by claim age.
    index('governance_proposal_recovery_idx').on(t.executionState, t.executionClaimedAt),
  ],
);
export type GovernanceProposalRow = typeof governanceProposals.$inferSelect;

/** One-account-one-vote simulated ballots (WS-L.4.1d). */
export const governanceProposalVotes = knomosisSchema.table(
  'governance_proposal_vote',
  {
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => governanceProposals.proposalId, { onDelete: 'cascade' }),
    voterUserId: uuid('voter_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    choice: text('choice').notNull(), // approve | reject | abstain (CHECK in migration)
    castAt: tz('cast_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.voterUserId] })],
);
export type GovernanceProposalVoteRow = typeof governanceProposalVotes.$inferSelect;

/** Wallet signatures over proposals (SPEC §22.2 GovernanceSignature). */
export const governanceSignatures = knomosisSchema.table(
  'governance_signature',
  {
    signatureId: uuid('signature_id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => governanceProposals.proposalId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'restrict' }),
    walletAccountId: uuid('wallet_account_id')
      .notNull()
      .references(() => walletAccounts.walletAccountId, { onDelete: 'restrict' }),
    signatureType: text('signature_type').notNull(), // eip712_ecdsa | eip712_eip1271
    typedDataHash: text('typed_data_hash').notNull(),
    signatureRef: text('signature_ref').notNull(),
    weightSnapshot: numeric('weight_snapshot'),
    eligibilityReason: text('eligibility_reason').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('governance_signature_unique_idx').on(t.proposalId, t.walletAccountId)],
);
export type GovernanceSignatureRow = typeof governanceSignatures.$inferSelect;

// ---------------------------------------------------------------------------
// Simulated treasury (WS-L.4.1c) — SEPARATE from any real treasury table.
// ---------------------------------------------------------------------------

export const simTreasuries = knomosisSchema.table('sim_treasury', {
  roomId: uuid('room_id').primaryKey(), // soft ref (isolation)
  /** asset (SIM-*) → minor-unit amount string.  Never negative (service + entries). */
  balances: jsonb('balances').notNull(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});
export type SimTreasuryRow = typeof simTreasuries.$inferSelect;

export const simTreasuryEntries = knomosisSchema.table(
  'sim_treasury_entry',
  {
    entryId: uuid('entry_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    kind: text('kind').notNull(), // deposit | grant_execution (CHECK in migration)
    asset: text('asset').notNull(),
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.userId, { onDelete: 'set null' }),
    proposalId: uuid('proposal_id').references(() => governanceProposals.proposalId, {
      onDelete: 'set null',
    }),
    // Natural dedup key for the atomic balance+ledger write (WS-L.4.1c): the
    // proposalId for a grant_execution, a client key for a deposit.  Partial-unique
    // (below) so a crash-retry can never double-apply.
    idempotencyKey: text('idempotency_key'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('sim_treasury_entry_room_idx').on(t.roomId, t.createdAt),
    uniqueIndex('sim_treasury_entry_idem_idx')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);
export type SimTreasuryEntryRow = typeof simTreasuryEntries.$inferSelect;

// ---------------------------------------------------------------------------
// Governance audit log (WS-L.4.1f) — append-only (trigger in the migration).
// ---------------------------------------------------------------------------

export const governanceAuditLogs = knomosisSchema.table(
  'governance_audit_log',
  {
    entryId: uuid('entry_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    actionType: text('action_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.userId, { onDelete: 'set null' }),
    actionDetails: jsonb('action_details').notNull(),
    simulationMode: boolean('simulation_mode').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  // (room_id, created_at, entry_id): the entry_id tail makes the keyset page
  // cursor a STRICT total order, so `ORDER BY created_at DESC, entry_id DESC`
  // over a room is served by a backward index scan with no same-ms ambiguity
  // (WS-L.4.1f).
  (t) => [index('governance_audit_log_room_idx').on(t.roomId, t.createdAt, t.entryId)],
);
export type GovernanceAuditLogRow = typeof governanceAuditLogs.$inferSelect;

// ---------------------------------------------------------------------------
// Reconciliation results (WS-L.3.4a/b) + receipts (WS-L.3.4c)
// ---------------------------------------------------------------------------

export const reconciliationOutcomeEnum = knomosisSchema.enum('knomosis_reconciliation_outcome', [
  'match',
  'mismatch',
  'halted_unsupported_version',
  // A gateway event-retention gap: an unknown range was lost, so reconciliation
  // HALTS (like an unsupported version) until `rebuildFromSnapshot` re-anchors.
  'halted_event_gap',
]);

export const divergenceSeverityEnum = knomosisSchema.enum('knomosis_divergence_severity', [
  'informational',
  'warning',
  'critical',
]);

export const reconciliationResults = knomosisSchema.table(
  'knomosis_reconciliation_result',
  {
    resultId: uuid('result_id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => knomosisDeployments.deploymentId, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(), // treasury | proposal | grant | action
    entityRef: text('entity_ref').notNull(),
    outcome: reconciliationOutcomeEnum('outcome').notNull(),
    /** Divergence severity for mismatches (null for matches). */
    severity: divergenceSeverityEnum('severity'),
    /** The three-source values + context for audit (WS-L.3.4b). */
    details: jsonb('details').notNull(),
    /** The common low-watermark X-Knomosis-Seq the comparison was made at. */
    lowWatermarkSeq: bigint('low_watermark_seq', { mode: 'bigint' }),
    createdAt: tz('created_at').notNull().defaultNow(),
    /** Monotonic INSERTION order — the strict tiebreaker for "latest per entity":
     *  a resolving `match` and its mismatch can share a `created_at`, and only an
     *  insertion sequence deterministically keeps the later row (WS-L.3.4b). */
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
  },
  // (entity_type, entity_ref, created_at DESC, seq DESC) backs the latest-per-
  // entity DISTINCT ON / ORDER BY with the tiebreaker in the index.
  (t) => [
    index('knomosis_reconciliation_entity_idx').on(t.entityType, t.entityRef, t.createdAt, t.seq),
  ],
);
export type ReconciliationResultRow = typeof reconciliationResults.$inferSelect;

export const receiptKindEnum = knomosisSchema.enum('knomosis_receipt_kind', ['public', 'private']);

export const knomosisReceipts = knomosisSchema.table(
  'knomosis_receipt',
  {
    receiptId: uuid('receipt_id').primaryKey().defaultRandom(),
    // SOFT reference (no FK): a PUBLIC receipt is the public transparency ledger
    // and must SURVIVE the owner's account deletion, so it cannot cascade with the
    // signed action row.  Data-rights purges the owner's PRIVATE receipts + actions
    // directly; the ownerless public receipt keeps its own payload/hash (WS-L.3.4c).
    actionRecordId: uuid('action_record_id').notNull(),
    kind: receiptKindEnum('kind').notNull(),
    /** Public receipts carry ONLY the allowlisted fields (WS-L.3.4c). */
    payload: jsonb('payload').notNull(),
    /** sha-256 pairing of the human summary to the machine payload (§23.5). */
    summaryPayloadHash: text('summary_payload_hash').notNull(),
    /** Private receipts are owner-scoped; null for public receipts. */
    ownerUserId: uuid('owner_user_id').references(() => users.userId, { onDelete: 'cascade' }),
    finalState: text('final_state').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('knomosis_receipt_action_kind_idx').on(t.actionRecordId, t.kind)],
);
export type KnomosisReceiptRow = typeof knomosisReceipts.$inferSelect;

// ---------------------------------------------------------------------------
// Comprehension results (WS-L.4.1e) — pass/fail metric, no answer content.
// ---------------------------------------------------------------------------

export const comprehensionResults = knomosisSchema.table(
  'comprehension_result',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    quizVersion: text('quiz_version').notNull(),
    passed: boolean('passed').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    passedAt: tz('passed_at'),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.quizVersion] })],
);
export type ComprehensionResultRow = typeof comprehensionResults.$inferSelect;

/** The gateway ingestion RESUME cursor per deployment (WS-L.3.3b).  Distinct from
 *  the derived max-stored seq: a retention-gap rebuild re-anchors it FORWARD past
 *  events that were dropped and never stored, so ingestion resumes without
 *  re-gapping.  `latestGatewaySeq()` returns the max of this and the stored seq. */
export const knomosisGatewayCursor = knomosisSchema.table('knomosis_gateway_cursor', {
  deploymentId: uuid('deployment_id').primaryKey(),
  seq: numeric('seq').notNull(),
});
export type KnomosisGatewayCursorRow = typeof knomosisGatewayCursor.$inferSelect;
