// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M treasury-and-governance tables (SPEC §22.2;
// docs/planning/14-treasury-and-governance.md), in the isolated `knomosis`
// bounded context.  Isolation rule (WS-D.3.2, extended): the ONLY hard foreign
// keys leaving this context point at `public.users` (the identity root) or stay
// WITHIN the wallet/knomosis context — room references are SOFT (bare uuid, no
// FK), so no SQL join path can connect financial data to the ranking/attention
// context (the structural "no pay-to-rank" guarantee).  Every table here is
// registered in the schema-isolation allowlist (packages/db/src/isolation.ts).
//
// Amount discipline (SPEC §22.2): monetary amounts are `numeric(78,0)` minor
// units read/written as decimal STRINGS; services compare them with the exact
// decimal math in @licio/governance — never IEEE floats.

import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { knomosisSchema, roomLawPacks } from './governance.js';
import {
  governanceProposals,
  knomosisActionRecords,
  knomosisDeployments,
} from './knomosis-gateway.js';
import { users } from './user.js';

const tz = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Enums.
// ---------------------------------------------------------------------------

export const treasuryFreezeStateEnum = knomosisSchema.enum('treasury_freeze_state', [
  'active',
  'frozen',
]);

export const treasuryReconciliationStateEnum = knomosisSchema.enum(
  'treasury_reconciliation_state',
  ['synced', 'pending', 'divergent'],
);

export const paymentTargetTypeEnum = knomosisSchema.enum('payment_target_type', [
  'treasury_deposit',
  'bounty_contribution',
  'grant_payout',
  'steward_compensation',
]);

/** The thirteen §22.2 payment-intent execution states (WS-M.3.1a/b). */
export const paymentExecutionStateEnum = knomosisSchema.enum('payment_execution_state', [
  'created',
  'preflighted',
  'quoted',
  'signed',
  'submitted',
  'pending',
  'confirmed',
  'finalized',
  'reverted',
  'reorged',
  'disputed',
  'abandoned',
  'failed',
]);

export const paymentJurisdictionStateEnum = knomosisSchema.enum('payment_jurisdiction_state', [
  'allowed',
  'restricted',
  'blocked',
]);

export const paymentComplianceStateEnum = knomosisSchema.enum('payment_compliance_state', [
  'pending',
  'cleared',
  'flagged',
  'blocked',
]);

export const treasuryReservationStateEnum = knomosisSchema.enum('treasury_reservation_state', [
  'reserved',
  'consumed',
  'released',
]);

export const grantMilestoneStateEnum = knomosisSchema.enum('grant_milestone_state', [
  'none',
  'pending',
  'in_progress',
  'submitted',
  'accepted',
  'rejected',
]);

export const grantReviewStateEnum = knomosisSchema.enum('grant_review_state', [
  'pending',
  'independent_review',
  'cleared',
  'flagged',
]);

export const grantPayoutStateEnum = knomosisSchema.enum('grant_payout_state', [
  'not_started',
  'scheduled',
  'partially_paid',
  'paid',
  'clawed_back',
]);

export const governanceChallengeTypeEnum = knomosisSchema.enum('governance_challenge_type', [
  'coi',
  'fraud',
  'capture',
  'legal',
  'evidence_defect',
]);

export const governanceChallengeRecordStateEnum = knomosisSchema.enum(
  'governance_challenge_record_state',
  ['open', 'upheld', 'dismissed', 'escalated'],
);

export const delegationStateEnum = knomosisSchema.enum('delegation_state', ['active', 'revoked']);

export const treasurySnapshotResultEnum = knomosisSchema.enum('treasury_snapshot_result', [
  'synced',
  'explained',
  'divergent',
]);

// ---------------------------------------------------------------------------
// RoomGovernanceProfile (WS-M.1.1a).  `governance_mode` stays the SSOT on the
// `public.rooms` row (written only through the WS-L.4.1g transition gate); the
// profile carries everything else (§22.2) keyed by the soft room id.
// ---------------------------------------------------------------------------

export const roomGovernanceProfiles = knomosisSchema.table('room_governance_profile', {
  roomId: uuid('room_id').primaryKey(), // soft ref (isolation)
  lawPackId: uuid('law_pack_id').references(() => roomLawPacks.lawPackId, {
    onDelete: 'set null',
  }),
  charterVersionId: uuid('charter_version_id').references(
    () => governanceCharterVersions.charterVersionId,
    { onDelete: 'set null' },
  ),
  treasuryId: uuid('treasury_id').references(() => roomTreasuries.treasuryId, {
    onDelete: 'set null',
  }),
  /** §22.2 policy refs — `{ lawPackId, section }` derived at law-pack adoption. */
  quorumPolicyRef: jsonb('quorum_policy_ref'),
  thresholdPolicyRef: jsonb('threshold_policy_ref'),
  timelockPolicyRef: jsonb('timelock_policy_ref'),
  freezeState: treasuryFreezeStateEnum('freeze_state').notNull().default('active'),
  /** Safe, non-leaking status text — never investigative detail (§29.7). */
  freezeReason: text('freeze_reason'),
  pauseFlags: jsonb('pause_flags')
    .notNull()
    .default(sql`'{"deposits":false,"proposals":false,"executions":false}'::jsonb`),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});
export type RoomGovernanceProfileRow = typeof roomGovernanceProfiles.$inferSelect;

// ---------------------------------------------------------------------------
// Charter versions (WS-M.1.2a) — immutable, hash-committed (append-only
// trigger in the migration).
// ---------------------------------------------------------------------------

export const governanceCharterVersions = knomosisSchema.table(
  'governance_charter_version',
  {
    charterVersionId: uuid('charter_version_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    version: integer('version').notNull(),
    /** The eight required plain-language sections (charterSectionsSchema). */
    sections: jsonb('sections').notNull(),
    /** 0x-prefixed SHA-256 over the canonical sections (WS-M.1.2a). */
    contentHash: text('content_hash').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('charter_version_room_version_uq').on(t.roomId, t.version)],
);
export type GovernanceCharterVersionRow = typeof governanceCharterVersions.$inferSelect;

// ---------------------------------------------------------------------------
// RoomTreasury (WS-M.2.1a) — the REAL-asset treasury (the simulated one lives
// in `sim_treasury`, deliberately separate).
// ---------------------------------------------------------------------------

export const roomTreasuries = knomosisSchema.table(
  'room_treasury',
  {
    treasuryId: uuid('treasury_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref; unique below (one per room)
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => knomosisDeployments.deploymentId, { onDelete: 'restrict' }),
    /** Unique on-chain address; disjointness from platform operating addresses
     *  is enforced at insert time by the service (WS-M.2.1b). */
    treasuryAddress: text('treasury_address').notNull(),
    acceptedAssets: jsonb('accepted_assets').notNull(), // string[]
    /** Latest RECONCILED balances (asset → minor-unit string); never live. */
    balanceSnapshot: jsonb('balance_snapshot'),
    balancesReconciledAt: tz('balances_reconciled_at'),
    /** depositLimitsSchema: per-user/per-room/per-deposit + period. */
    depositLimits: jsonb('deposit_limits').notNull(),
    freezeState: treasuryFreezeStateEnum('freeze_state').notNull().default('active'),
    freezeReason: text('freeze_reason'),
    /** True when the freeze is a room-scope CASCADE (migration 0085): the
     *  structural marker room unfreezes clear by — never reason-text equality. */
    freezeCascade: boolean('freeze_cascaded').notNull().default(false),
    pauseFlags: jsonb('pause_flags')
      .notNull()
      .default(sql`'{"deposits":false,"proposals":false,"executions":false}'::jsonb`),
    reconciliationState: treasuryReconciliationStateEnum('reconciliation_state')
      .notNull()
      .default('pending'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('room_treasury_room_uq').on(t.roomId),
    uniqueIndex('room_treasury_address_uq').on(t.treasuryAddress),
  ],
);
export type RoomTreasuryRow = typeof roomTreasuries.$inferSelect;

// ---------------------------------------------------------------------------
// Reservation sub-ledger (WS-M.2.3a-1): cap headroom = cap − consumed − reserved.
// One reservation per proposal (idempotent by construction).
// ---------------------------------------------------------------------------

export const treasuryReservations = knomosisSchema.table(
  'treasury_reservation',
  {
    reservationId: uuid('reservation_id').primaryKey().defaultRandom(),
    treasuryId: uuid('treasury_id')
      .notNull()
      .references(() => roomTreasuries.treasuryId, { onDelete: 'restrict' }),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => governanceProposals.proposalId, { onDelete: 'restrict' }),
    category: text('category').notNull(),
    asset: text('asset').notNull(),
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    state: treasuryReservationStateEnum('state').notNull().default('reserved'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // One reservation per proposal: a double-approval races into this index,
    // never into a double-count (WS-M.2.3a-1 idempotency).
    uniqueIndex('treasury_reservation_proposal_uq').on(t.proposalId),
    index('treasury_reservation_headroom_idx').on(t.treasuryId, t.category, t.state),
  ],
);
export type TreasuryReservationRow = typeof treasuryReservations.$inferSelect;

// ---------------------------------------------------------------------------
// PaymentIntent (WS-M.3.1a) — 13-state lifecycle, fail-closed compliance.
// ---------------------------------------------------------------------------

export const paymentIntents = knomosisSchema.table(
  'payment_intent',
  {
    paymentIntentId: uuid('payment_intent_id').primaryKey().defaultRandom(),
    // Nullable + set-null: the intent is room financial history and must survive
    // the actor's account erasure (the WS-L data-rights purge nulls it).
    userId: uuid('user_id').references(() => users.userId, { onDelete: 'set null' }),
    roomId: uuid('room_id').notNull(), // soft ref
    treasuryId: uuid('treasury_id')
      .notNull()
      .references(() => roomTreasuries.treasuryId, { onDelete: 'restrict' }),
    targetType: paymentTargetTypeEnum('target_type').notNull(),
    /** Soft target ref (treasury / grant milestone / proposal id). */
    targetId: uuid('target_id').notNull(),
    asset: text('asset').notNull(),
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    /** Fail-closed defaults: an intent that skips preflight cannot proceed. */
    jurisdictionState: paymentJurisdictionStateEnum('jurisdiction_state')
      .notNull()
      .default('blocked'),
    complianceState: paymentComplianceStateEnum('compliance_state').notNull().default('pending'),
    executionState: paymentExecutionStateEnum('execution_state').notNull().default('created'),
    retryCount: integer('retry_count').notNull().default(0),
    quoteRef: jsonb('quote_ref'),
    /** The WS-L action record once signed + submitted (intra-context FK). */
    actionRecordId: uuid('action_record_id').references(
      () => knomosisActionRecords.actionRecordId,
      { onDelete: 'set null' },
    ),
    /** Soft ref to the knomosis receipt once finalized. */
    receiptId: uuid('receipt_id'),
    idempotencyKey: uuid('idempotency_key').notNull(),
    expiresAt: tz('expires_at').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Idempotency scope (user, room, key) — WS-M.3.1c.  The key row is written
    // in the same transaction as the intent (the unique index IS the record).
    uniqueIndex('payment_intent_idem_uq').on(t.userId, t.roomId, t.idempotencyKey),
    // ROOM-owned intents (user_id NULL by DESIGN: the payout classes) scope
    // idempotency to (room, key) — NULLs are distinct under the index above,
    // so the milestone-keyed dedup needs its own partial unique.  Scoped to
    // the payout target types (0086): account erasure also nulls user_id on
    // member deposits, which must never join this uniqueness.
    uniqueIndex('payment_intent_room_idem_uq')
      .on(t.roomId, t.idempotencyKey)
      .where(
        sql`${t.userId} IS NULL AND ${t.targetType} IN ('grant_payout', 'steward_compensation')`,
      ),
    index('payment_intent_room_idx').on(t.roomId, t.createdAt),
    index('payment_intent_state_idx').on(t.executionState, t.expiresAt),
    index('payment_intent_treasury_idx').on(t.treasuryId, t.targetType),
  ],
);
export type PaymentIntentRow = typeof paymentIntents.$inferSelect;

// ---------------------------------------------------------------------------
// TreasuryGrant (WS-M.5.1a) — milestone-gated disbursement.
// ---------------------------------------------------------------------------

export const treasuryGrants = knomosisSchema.table(
  'treasury_grant',
  {
    grantId: uuid('grant_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    treasuryId: uuid('treasury_id')
      .notNull()
      .references(() => roomTreasuries.treasuryId, { onDelete: 'restrict' }),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => governanceProposals.proposalId, { onDelete: 'restrict' }),
    /** Opaque recipient reference (user id / entity ref) — soft. */
    recipientRef: text('recipient_ref').notNull(),
    purpose: text('purpose').notNull(),
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    asset: text('asset').notNull(),
    /** grantMilestoneSchema[] — per-tranche state + payment-intent linkage. */
    milestones: jsonb('milestones').notNull(),
    milestoneState: grantMilestoneStateEnum('milestone_state').notNull().default('none'),
    reviewState: grantReviewStateEnum('review_state').notNull().default('pending'),
    payoutState: grantPayoutStateEnum('payout_state').notNull().default('not_started'),
    auditSummary: text('audit_summary'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // One grant per approving proposal (the proposal IS the authorization).
    uniqueIndex('treasury_grant_proposal_uq').on(t.proposalId),
    index('treasury_grant_room_idx').on(t.roomId, t.createdAt),
  ],
);
export type TreasuryGrantRow = typeof treasuryGrants.$inferSelect;

// ---------------------------------------------------------------------------
// ActionBudget (WS-M.3.2a; §17.7) — capacity units, NEVER transferable, and
// structurally invisible to ranking (no path out of this schema).
// ---------------------------------------------------------------------------

export const actionBudgets = knomosisSchema.table(
  'action_budget',
  {
    budgetId: uuid('budget_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    /** `user:<uuid>` or `workflow:<name>` — the budget subject. */
    actorKey: text('actor_key').notNull(),
    availableUnits: bigint('available_units', { mode: 'number' }).notNull().default(0),
    lastRefillAt: tz('last_refill_at').notNull().defaultNow(),
    /** Abuse-team imposed limits/freezes (documented policy, WS-M.3.2a). */
    rateLimitState: jsonb('rate_limit_state'),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('action_budget_actor_uq').on(t.roomId, t.actorKey)],
);
export type ActionBudgetRow = typeof actionBudgets.$inferSelect;

// ---------------------------------------------------------------------------
// DelegationRecord (WS-M.4.2c-3) — revocable, public-audit-logged.
// ---------------------------------------------------------------------------

export const delegationRecords = knomosisSchema.table(
  'delegation_record',
  {
    delegationId: uuid('delegation_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(), // soft ref
    delegatorUserId: uuid('delegator_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    delegateUserId: uuid('delegate_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    /** delegationScopeSchema ({all:true} | {proposal_type}). */
    scope: jsonb('scope').notNull(),
    /** Deterministic scope key (`all` | `type:<x>`) backing the active-uniqueness. */
    scopeKey: text('scope_key').notNull(),
    state: delegationStateEnum('state').notNull().default('active'),
    createdAt: tz('created_at').notNull().defaultNow(),
    revokedAt: tz('revoked_at'),
  },
  (t) => [
    // One ACTIVE delegation per (room, delegator, scope): re-delegating the same
    // scope requires revoking first (no silent supersede races).
    uniqueIndex('delegation_active_uq')
      .on(t.roomId, t.delegatorUserId, t.scopeKey)
      .where(sql`${t.state} = 'active'`),
    index('delegation_delegate_idx').on(t.roomId, t.delegateUserId, t.state),
  ],
);
export type DelegationRecordRow = typeof delegationRecords.$inferSelect;

// ---------------------------------------------------------------------------
// GovernanceChallenge (WS-M.4.3a).
// ---------------------------------------------------------------------------

export const governanceChallenges = knomosisSchema.table(
  'governance_challenge',
  {
    challengeId: uuid('challenge_id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => governanceProposals.proposalId, { onDelete: 'cascade' }),
    challengerUserId: uuid('challenger_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    challengeType: governanceChallengeTypeEnum('challenge_type').notNull(),
    description: text('description').notNull(),
    evidenceRefs: jsonb('evidence_refs').notNull(), // string[]
    state: governanceChallengeRecordStateEnum('state').notNull().default('open'),
    resolutionNote: text('resolution_note'),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    createdAt: tz('created_at').notNull().defaultNow(),
    resolvedAt: tz('resolved_at'),
  },
  (t) => [index('governance_challenge_proposal_idx').on(t.proposalId, t.state)],
);
export type GovernanceChallengeRow = typeof governanceChallenges.$inferSelect;

// ---------------------------------------------------------------------------
// TreasuryReconciliationSnapshot (WS-M.5.2a) — zero-or-explained, immutable
// (append-only trigger in the migration).
// ---------------------------------------------------------------------------

export const treasuryReconciliationSnapshots = knomosisSchema.table(
  'treasury_reconciliation_snapshot',
  {
    snapshotId: uuid('snapshot_id').primaryKey().defaultRandom(),
    treasuryId: uuid('treasury_id')
      .notNull()
      .references(() => roomTreasuries.treasuryId, { onDelete: 'cascade' }),
    asset: text('asset').notNull(),
    productLedgerBalance: numeric('product_ledger_balance', { precision: 78, scale: 0 }).notNull(),
    receiptsBalance: numeric('receipts_balance', { precision: 78, scale: 0 }).notNull(),
    onchainObservedBalance: numeric('onchain_observed_balance', {
      precision: 78,
      scale: 0,
    }).notNull(),
    /** Max pairwise absolute difference. */
    gap: numeric('gap', { precision: 78, scale: 0 }).notNull(),
    /** Non-null REQUIRED when result = 'explained' (CHECK in the migration). */
    explanation: jsonb('explanation'),
    result: treasurySnapshotResultEnum('result').notNull(),
    observedAt: tz('observed_at').notNull().defaultNow(),
  },
  (t) => [index('treasury_snapshot_treasury_idx').on(t.treasuryId, t.observedAt)],
);
export type TreasuryReconciliationSnapshotRow = typeof treasuryReconciliationSnapshots.$inferSelect;

// ---------------------------------------------------------------------------
// Readiness attestations (WS-M.1.2d/e): the steward's safety-override
// acknowledgment and the platform-recorded external audit.
// ---------------------------------------------------------------------------

export const roomReadinessAttestations = knomosisSchema.table(
  'room_readiness_attestation',
  {
    roomId: uuid('room_id').notNull(), // soft ref
    /** ReadinessRequirement id ('safety_override_acknowledged' | 'external_audit_passed'). */
    item: text('item').notNull(),
    attestedByUserId: uuid('attested_by_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    note: text('note').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.item] })],
);
export type RoomReadinessAttestationRow = typeof roomReadinessAttestations.$inferSelect;
