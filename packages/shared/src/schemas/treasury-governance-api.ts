// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M treasury-and-governance wire contracts (SPEC §22.2, §23.4;
// docs/planning/14-treasury-and-governance.md).  The real-asset surface that
// composes with the shipped WS-L.4 simulation contracts in `knomosis-api.ts`:
// governance profiles, versioned charters, law-pack registration/validation,
// room treasuries + deposits, the 13-state payment-intent lifecycle, the
// production proposal lifecycle (sign / challenge / execute), grants,
// delegation, action budgets, freeze/pause, reconciliation snapshots, and the
// accounting export.  Monetary amounts are integer minor-unit strings (never
// floats); every response is zod-validated on BOTH sides of the wire.
//
// This file is also the CANONICAL home of the WS-M state vocabularies —
// `@licio/governance` (which depends on this package) imports them for its
// pure transition tables, so the wire and the domain can never drift.

import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import {
  governanceTabResponseSchema,
  hash32Schema,
  lowercaseAddressSchema,
  minorUnitAmountSchema,
  PROPOSAL_CHALLENGE_STATES,
  PROPOSAL_EXECUTION_STATES,
  PROPOSAL_VOTING_STATES,
  positiveMinorUnitAmountSchema,
  READINESS_REQUIREMENTS,
} from './knomosis-api.js';

// ---------------------------------------------------------------------------
// Canonical WS-M state vocabularies (consumed by @licio/governance lifecycle).
// ---------------------------------------------------------------------------

/** The thirteen §22.2 payment-intent execution states (WS-M.3.1a/b). */
export const PAYMENT_INTENT_STATES = [
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
] as const;
export type PaymentIntentState = (typeof PAYMENT_INTENT_STATES)[number];
export const paymentIntentStateSchema = z.enum(PAYMENT_INTENT_STATES);

/** §22.2 payment targets.  `steward_compensation` is the WS-M addition. */
export const PAYMENT_TARGET_TYPES = [
  'treasury_deposit',
  'bounty_contribution',
  'grant_payout',
  'steward_compensation',
] as const;
export type PaymentTargetType = (typeof PAYMENT_TARGET_TYPES)[number];
export const paymentTargetTypeSchema = z.enum(PAYMENT_TARGET_TYPES);

/** WS-M.4.3a challenge taxonomy. */
export const PROPOSAL_CHALLENGE_TYPES = [
  'coi',
  'fraud',
  'capture',
  'legal',
  'evidence_defect',
] as const;
export type ProposalChallengeType = (typeof PROPOSAL_CHALLENGE_TYPES)[number];
export const proposalChallengeTypeSchema = z.enum(PROPOSAL_CHALLENGE_TYPES);

/** Per-challenge lifecycle states (the proposal-level column adds 'none'). */
export const CHALLENGE_RECORD_STATES = ['open', 'upheld', 'dismissed', 'escalated'] as const;
export type ProposalChallengeState = (typeof CHALLENGE_RECORD_STATES)[number];
export const proposalChallengeStateSchema = z.enum(CHALLENGE_RECORD_STATES);

/** WS-M.2.4a freeze trigger sources (authorization differs per source). */
export const TREASURY_FREEZE_SOURCES = [
  'automated_monitoring',
  'platform_security',
  'legal',
  'trust_safety',
  'steward',
] as const;
export type TreasuryFreezeSource = (typeof TREASURY_FREEZE_SOURCES)[number];

/** Grant lifecycle vocabularies (WS-M.5.1a; SPEC §22.2). */
export const GRANT_MILESTONE_STATES = [
  'none',
  'pending',
  'in_progress',
  'submitted',
  'accepted',
  'rejected',
] as const;
export const GRANT_REVIEW_STATES = ['pending', 'independent_review', 'cleared', 'flagged'] as const;
export const GRANT_PAYOUT_STATES = [
  'not_started',
  'scheduled',
  'partially_paid',
  'paid',
  'clawed_back',
] as const;

/** Reconciliation snapshot results (WS-M.5.2a — zero-or-explained). */
export const RECONCILIATION_SNAPSHOT_RESULTS = ['synced', 'explained', 'divergent'] as const;
export type ReconciliationSnapshotResult = (typeof RECONCILIATION_SNAPSHOT_RESULTS)[number];

/** Treasury-level reconciliation states on the dashboard row. */
export const TREASURY_RECONCILIATION_STATES = ['synced', 'pending', 'divergent'] as const;

// ---------------------------------------------------------------------------
// Room governance profile (WS-M.1.1a).
// ---------------------------------------------------------------------------

export const pauseFlagsSchema = z
  .object({
    deposits: z.boolean(),
    proposals: z.boolean(),
    executions: z.boolean(),
  })
  .strict();
export type PauseFlags = z.infer<typeof pauseFlagsSchema>;

export const roomGovernanceProfileSchema = z
  .object({
    room_id: uuidSchema,
    /** The room-row SSOT mode, projected for one-read convenience. */
    governance_mode: z.string().min(1).max(32),
    law_pack_id: uuidSchema.nullable(),
    charter_version_id: uuidSchema.nullable(),
    treasury_id: uuidSchema.nullable(),
    freeze_state: z.enum(['active', 'frozen']),
    /** Safe, non-leaking status text (never investigative detail — §29.7). */
    freeze_reason: z.string().max(500).nullable(),
    pause_flags: pauseFlagsSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type RoomGovernanceProfile = z.infer<typeof roomGovernanceProfileSchema>;

export const roomGovernanceProfileResponseSchema = z
  .object({ profile: roomGovernanceProfileSchema })
  .strict();
export type RoomGovernanceProfileResponse = z.infer<typeof roomGovernanceProfileResponseSchema>;

// ---------------------------------------------------------------------------
// Charter versions (WS-M.1.2a) — plain-language, sectioned, hash-committed.
// ---------------------------------------------------------------------------

/** The required charter sections (WS-M.1.2a + the §16.5 additions: the safety
 *  override acknowledgment and the appeals path to the platform legal floor). */
export const CHARTER_SECTIONS = [
  'purpose',
  'decision_making',
  'fund_management',
  'member_rights',
  'dispute_resolution',
  'amendment_process',
  'safety_override_acknowledgment',
  'appeals_path',
] as const;
export type CharterSection = (typeof CHARTER_SECTIONS)[number];

const charterSectionTextSchema = z.string().trim().min(20).max(10_000);

export const charterSectionsSchema = z
  .object({
    purpose: charterSectionTextSchema,
    decision_making: charterSectionTextSchema,
    fund_management: charterSectionTextSchema,
    member_rights: charterSectionTextSchema,
    dispute_resolution: charterSectionTextSchema,
    amendment_process: charterSectionTextSchema,
    safety_override_acknowledgment: charterSectionTextSchema,
    appeals_path: charterSectionTextSchema,
  })
  .strict();
export type CharterSections = z.infer<typeof charterSectionsSchema>;

export const charterCreateRequestSchema = z.object({ sections: charterSectionsSchema }).strict();
export type CharterCreateRequest = z.infer<typeof charterCreateRequestSchema>;

export const charterVersionSchema = z
  .object({
    charter_version_id: uuidSchema,
    room_id: uuidSchema,
    version: z.number().int().min(1),
    sections: charterSectionsSchema,
    /** SHA-256 of the canonical sections (integrity commitment, WS-M.1.2a). */
    content_hash: hash32Schema,
    created_by_user_id: uuidSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type CharterVersion = z.infer<typeof charterVersionSchema>;

export const charterHistoryResponseSchema = z
  .object({ versions: z.array(charterVersionSchema).max(100) })
  .strict();

// ---------------------------------------------------------------------------
// Law-pack registration + validation (WS-M.1.3a-d).
// ---------------------------------------------------------------------------

export const lawPackProblemSchema = z
  .object({ path: z.string().min(1).max(200), problem: z.string().min(1).max(500) })
  .strict();
export type LawPackProblemWire = z.infer<typeof lawPackProblemSchema>;

export const lawPackRegisterRequestSchema = z
  .object({
    /** The bundle document (validated server-side via @licio/governance). */
    document: z.record(z.string(), z.unknown()),
    /** The fixture corpus proving the pack's behavior (WS-M.1.3c). */
    fixtures: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type LawPackRegisterRequest = z.infer<typeof lawPackRegisterRequestSchema>;

export const lawPackRegisterResponseSchema = z
  .object({
    law_pack_id: uuidSchema,
    version: z.string().min(1).max(64),
    /** Server-computed SHA-256 over the canonical bundle (WS-M.1.3a). */
    hash_commitment: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type LawPackRegisterResponse = z.infer<typeof lawPackRegisterResponseSchema>;

export const lawPackValidationResponseSchema = z
  .object({
    structural_problems: z.array(lawPackProblemSchema).max(256),
    real_asset_problems: z.array(lawPackProblemSchema).max(256),
    fixture_failures: z
      .array(
        z
          .object({
            label: z.string().min(1).max(200),
            expected: z.string().min(1).max(200),
            actual: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(512),
    coverage_problems: z.array(lawPackProblemSchema).max(256),
  })
  .strict();
export type LawPackValidationResponse = z.infer<typeof lawPackValidationResponseSchema>;

export const lawPackVersionSummarySchema = z
  .object({
    law_pack_id: uuidSchema,
    version: z.string().min(1).max(64),
    hash_commitment: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    supersedes_law_pack_id: uuidSchema.nullable(),
    audit_state: z.enum(['draft', 'reviewed', 'audited']),
    published: z.boolean(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type LawPackVersionSummary = z.infer<typeof lawPackVersionSummarySchema>;

export const lawPackHistoryResponseSchema = z
  .object({ versions: z.array(lawPackVersionSummarySchema).max(200) })
  .strict();

// ---------------------------------------------------------------------------
// Room treasury (WS-M.2.1a) + deposits (WS-M.2.2a-c).
// ---------------------------------------------------------------------------

export const depositLimitsSchema = z
  .object({
    /** Max per user per rolling period (minor units). */
    per_user_per_period: positiveMinorUnitAmountSchema,
    /** Max total deposits per room per rolling period. */
    per_room_per_period: positiveMinorUnitAmountSchema,
    /** Max single deposit. */
    per_deposit_max: positiveMinorUnitAmountSchema,
    period_seconds: z.number().int().min(3_600).max(31_536_000),
  })
  .strict();
export type DepositLimits = z.infer<typeof depositLimitsSchema>;

export const treasuryCreateRequestSchema = z
  .object({
    deployment_id: uuidSchema,
    /** The provisioned on-chain treasury contract address (operator-supplied
     *  until a factory contract ships; uniqueness + platform-disjointness are
     *  enforced server-side, WS-M.2.1b). */
    treasury_address: lowercaseAddressSchema,
    accepted_assets: z.array(z.string().min(1).max(32)).min(1).max(16),
    deposit_limits: depositLimitsSchema,
  })
  .strict();
export type TreasuryCreateRequest = z.infer<typeof treasuryCreateRequestSchema>;

export const treasuryBalanceSchema = z
  .object({ asset: z.string().min(1).max(32), amount: minorUnitAmountSchema })
  .strict();

export const roomTreasurySchema = z
  .object({
    treasury_id: uuidSchema,
    room_id: uuidSchema,
    deployment_id: uuidSchema,
    treasury_address: lowercaseAddressSchema,
    accepted_assets: z.array(z.string().min(1).max(32)).max(16),
    /** Balances from the LAST RECONCILED snapshot — never live (WS-M.2.2c). */
    balances: z.array(treasuryBalanceSchema).max(16),
    balances_reconciled_at: isoTimestampSchema.nullable(),
    deposit_limits: depositLimitsSchema,
    freeze_state: z.enum(['active', 'frozen']),
    freeze_reason: z.string().max(500).nullable(),
    pause_flags: pauseFlagsSchema,
    reconciliation_state: z.enum(TREASURY_RECONCILIATION_STATES),
    /** Reserved-but-unexecuted amounts per category (WS-M.2.3a-1). */
    reserved_by_category: z.record(z.string(), minorUnitAmountSchema),
    created_at: isoTimestampSchema,
  })
  .strict();
export type RoomTreasuryWire = z.infer<typeof roomTreasurySchema>;

export const treasuryDashboardResponseSchema = z
  .object({ treasury: roomTreasurySchema.nullable() })
  .strict();

/** Production deposit intent creation (rides the WS-L preflight + submit). */
export const treasuryDepositRequestSchema = z
  .object({
    asset: z.string().min(1).max(32),
    amount: positiveMinorUnitAmountSchema,
    idempotency_key: uuidSchema,
  })
  .strict();
export type TreasuryDepositRequest = z.infer<typeof treasuryDepositRequestSchema>;

// ---------------------------------------------------------------------------
// Payment intents (WS-M.3.1a-d).
// ---------------------------------------------------------------------------

export const paymentIntentSchema = z
  .object({
    payment_intent_id: uuidSchema,
    /** Null once the owner exercised right-to-erasure — the record is never
     *  re-attributed to whoever happens to read it. */
    user_id: uuidSchema.nullable(),
    room_id: uuidSchema,
    target_type: paymentTargetTypeSchema,
    /** Target entity (treasury / grant / proposal), per target_type. */
    target_id: uuidSchema,
    asset: z.string().min(1).max(32),
    amount: positiveMinorUnitAmountSchema,
    jurisdiction_state: z.enum(['allowed', 'restricted', 'blocked']),
    compliance_state: z.enum(['pending', 'cleared', 'flagged', 'blocked']),
    execution_state: paymentIntentStateSchema,
    /** Retries consumed against the bounded retry budget (WS-M.3.1b).  Also
     *  derives the WS-L action idempotency key for the CURRENT attempt: the
     *  intent id when 0, `<intentId>:r<retryCount>` after a retry — a fresh
     *  attempt must never dedup onto a prior attempt's terminal action. */
    retry_count: z.number().int().min(0),
    /** The WS-L action record once submitted (null pre-submission). */
    action_record_id: uuidSchema.nullable(),
    receipt_id: uuidSchema.nullable(),
    expires_at: isoTimestampSchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type PaymentIntentWire = z.infer<typeof paymentIntentSchema>;

export const paymentIntentCreateRequestSchema = z
  .object({
    target_type: paymentTargetTypeSchema,
    target_id: uuidSchema,
    asset: z.string().min(1).max(32),
    amount: positiveMinorUnitAmountSchema,
    /** Client idempotency key, scoped (user, room) with a TTL (WS-M.3.1c). */
    idempotency_key: uuidSchema,
  })
  .strict();
export type PaymentIntentCreateRequest = z.infer<typeof paymentIntentCreateRequestSchema>;

/**
 * The single-intent response ENVELOPE.
 *
 * Exported because the web client validates this exact shape at its TanStack
 * Query boundary; spelling it inline there left the wire contract in two
 * places, so a change to the envelope would update the server while the client
 * went on validating the old shape — and a zod boundary that describes an
 * obsolete contract fails closed on correct data.
 */
export const paymentIntentResponseSchema = z.object({ intent: paymentIntentSchema }).strict();

// ---------------------------------------------------------------------------
// Production proposals (WS-M.4).  The same governance_proposal entity as the
// WS-L.4 simulation rows, with simulation_mode=false and the production
// lifecycle columns (law-pack pin, category, windows, challenge linkage).
// ---------------------------------------------------------------------------

export const productionProposalCreateSchema = z
  .object({
    proposal_type: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    plain_language_summary: z.string().trim().min(1).max(2_000),
    /** Spend fields (null for non-spend proposals). */
    category: z.string().min(1).max(64).nullable(),
    requested_amount: positiveMinorUnitAmountSchema.nullable(),
    asset: z.string().min(1).max(32).nullable(),
    recipient_ref: z.string().min(1).max(128).nullable(),
    /** COI disclosures — required (non-empty) for every spend proposal. */
    conflict_disclosures: z.string().trim().max(2_000).nullable(),
    risk_assessment: z.string().trim().min(1).max(2_000),
    requested_action: z.record(z.string(), z.unknown()),
    expected_deliverable: z.string().trim().min(1).max(1_000),
    idempotency_key: uuidSchema,
  })
  .strict();
export type ProductionProposalCreate = z.infer<typeof productionProposalCreateSchema>;

export const proposalTallyWireSchema = z
  .object({
    outcome: z.enum(['open', 'passed', 'rejected', 'quorum_not_met']),
    quorum_met: z.boolean(),
    approve: z.string().max(100),
    reject: z.string().max(100),
    abstain: z.string().max(100),
    distinct_voters: z.number().int().min(0),
    turnout: z.number().min(0).max(1),
  })
  .strict();
export type ProposalTallyWire = z.infer<typeof proposalTallyWireSchema>;

/** The governance TAB bundle, production-aware (PR #144 review): real-asset
 *  rooms carry their active PRODUCTION proposals in a separate list — the sim
 *  projection's `SIM-*` asset contract cannot hold a USDC spend row, and
 *  mixing shapes in one array would force every client into shape-sniffing.
 *  Exactly one of the two lists is non-empty per mode. */
export const productionProposalSchema = z
  .object({
    proposal_id: uuidSchema,
    room_id: uuidSchema,
    proposer_user_id: uuidSchema.nullable(),
    proposal_type: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    plain_language_summary: z.string().min(1).max(2_000),
    category: z.string().min(1).max(64).nullable(),
    requested_amount: minorUnitAmountSchema.nullable(),
    asset: z.string().min(1).max(32).nullable(),
    recipient_ref: z.string().min(1).max(128).nullable(),
    conflict_disclosures: z.string().max(2_000).nullable(),
    risk_assessment: z.string().min(1).max(2_000),
    requested_action: z.record(z.string(), z.unknown()),
    expected_deliverable: z.string().min(1).max(1_000),
    /** The law-pack version PINNED at publication (WS-M.1.3d). */
    law_pack_version_id: uuidSchema.nullable(),
    preflight_state: z.enum(['pending', 'passed', 'failed']),
    // The three lifecycle unions are DERIVED from the stored vocabularies, not
    // restated.  They were three hand-copies that happened to agree
    // value-for-value, and `toWireProductionProposal` cast across the
    // voting-state one with `as` — so the copies could silently diverge and the
    // cast would keep it compiling, which is exactly the divergence a wire
    // schema exists to catch.  Derived, the projection needs no cast at all and
    // a new stored state is a type error at the wire boundary until it is
    // deliberately handled.
    voting_state: z.enum(PROPOSAL_VOTING_STATES),
    challenge_state: z.enum(PROPOSAL_CHALLENGE_STATES),
    execution_state: z.enum(PROPOSAL_EXECUTION_STATES),
    tally: proposalTallyWireSchema.nullable(),
    deliberation_ends_at: isoTimestampSchema.nullable(),
    voting_ends_at: isoTimestampSchema.nullable(),
    challenge_window_ends_at: isoTimestampSchema.nullable(),
    executable_after: isoTimestampSchema.nullable(),
    created_at: isoTimestampSchema,
    executed_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type ProductionProposal = z.infer<typeof productionProposalSchema>;

export const productionProposalResponseSchema = z
  .object({ proposal: productionProposalSchema })
  .strict();
/** The mode-aware governance tab bundle (PR #144 review): extends the WS-L.4
 *  tab with the room's active PRODUCTION proposals.  Exactly one of
 *  `active_proposals` (sim) / `active_production_proposals` is non-empty. */
export const governanceTabWithProductionSchema = governanceTabResponseSchema.extend({
  active_production_proposals: z.array(productionProposalSchema).max(50),
});
export type GovernanceTabWithProduction = z.infer<typeof governanceTabWithProductionSchema>;

export const productionProposalListResponseSchema = z
  .object({ proposals: z.array(productionProposalSchema).max(100) })
  .strict();

/** Vote/approve on a proposal with a wallet signature (WS-M.2.3b-1).  The
 *  typed data + signature verify through the SAME WS-L verifiers; the server
 *  recomputes the typed-data hash and never trusts a client-supplied one. */
export const proposalSignRequestSchema = z
  .object({
    purpose: z.enum(['vote', 'approval', 'multisig']),
    /** Vote choice (required for purpose=vote; null otherwise). */
    choice: z.enum(['approve', 'reject', 'abstain']).nullable(),
    deployment_id: uuidSchema,
    wallet_account_id: uuidSchema,
    typed_data_message: z.record(z.string(), z.string()),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130,4096}$/),
  })
  .strict();
export type ProposalSignRequest = z.infer<typeof proposalSignRequestSchema>;

export const proposalSignResponseSchema = z
  .object({
    signature_id: uuidSchema,
    /** The capped weight snapshot recorded with the signature (WS-M.4.2c-1). */
    weight_snapshot: z.string().max(100),
    eligibility_reason: z.string().min(1).max(500),
    tally: proposalTallyWireSchema,
  })
  .strict();
export type ProposalSignResponse = z.infer<typeof proposalSignResponseSchema>;

export const proposalChallengeRequestSchema = z
  .object({
    challenge_type: proposalChallengeTypeSchema,
    description: z.string().trim().min(20).max(4_000),
    /** Opaque evidence references (URLs / contribution ids) — never raw files. */
    evidence_refs: z.array(z.string().min(1).max(500)).max(16),
  })
  .strict();
export type ProposalChallengeRequest = z.infer<typeof proposalChallengeRequestSchema>;

export const proposalChallengeSchema = z
  .object({
    challenge_id: uuidSchema,
    proposal_id: uuidSchema,
    challenger_user_id: uuidSchema.nullable(),
    challenge_type: proposalChallengeTypeSchema,
    description: z.string().min(1).max(4_000),
    evidence_refs: z.array(z.string().min(1).max(500)).max(16),
    state: proposalChallengeStateSchema,
    resolution_note: z.string().max(2_000).nullable(),
    created_at: isoTimestampSchema,
    resolved_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type ProposalChallengeWire = z.infer<typeof proposalChallengeSchema>;

export const challengeResolveRequestSchema = z
  .object({
    resolution: z.enum(['upheld', 'dismissed', 'escalated']),
    resolution_note: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type ChallengeResolveRequest = z.infer<typeof challengeResolveRequestSchema>;

export const proposalExecuteRequestSchema = z.object({ idempotency_key: uuidSchema }).strict();
export type ProposalExecuteRequest = z.infer<typeof proposalExecuteRequestSchema>;

// ---------------------------------------------------------------------------
// Grants (WS-M.5.1a).
// ---------------------------------------------------------------------------

export const grantMilestoneSchema = z
  .object({
    milestone_id: uuidSchema,
    description: z.string().min(1).max(1_000),
    amount: positiveMinorUnitAmountSchema,
    state: z.enum(GRANT_MILESTONE_STATES),
    payment_intent_id: uuidSchema.nullable(),
  })
  .strict();
export type GrantMilestone = z.infer<typeof grantMilestoneSchema>;

export const treasuryGrantSchema = z
  .object({
    grant_id: uuidSchema,
    room_id: uuidSchema,
    treasury_id: uuidSchema,
    proposal_id: uuidSchema,
    recipient_ref: z.string().min(1).max(128),
    purpose: z.string().min(1).max(2_000),
    amount: positiveMinorUnitAmountSchema,
    asset: z.string().min(1).max(32),
    milestones: z.array(grantMilestoneSchema).max(16),
    milestone_state: z.enum(GRANT_MILESTONE_STATES),
    review_state: z.enum(GRANT_REVIEW_STATES),
    payout_state: z.enum(GRANT_PAYOUT_STATES),
    audit_summary: z.string().max(2_000).nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type TreasuryGrantWire = z.infer<typeof treasuryGrantSchema>;

export const grantCreateRequestSchema = z
  .object({
    proposal_id: uuidSchema,
    recipient_ref: z.string().min(1).max(128),
    purpose: z.string().trim().min(1).max(2_000),
    /** Per-milestone tranches; their sum must equal the proposal's amount. */
    milestones: z
      .array(
        z
          .object({
            description: z.string().trim().min(1).max(1_000),
            amount: positiveMinorUnitAmountSchema,
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type GrantCreateRequest = z.infer<typeof grantCreateRequestSchema>;

export const grantMilestoneUpdateRequestSchema = z
  .object({
    state: z.enum(['in_progress', 'submitted', 'accepted', 'rejected']),
    note: z.string().trim().max(2_000).nullable(),
  })
  .strict();
export type GrantMilestoneUpdateRequest = z.infer<typeof grantMilestoneUpdateRequestSchema>;

export const grantListResponseSchema = z
  .object({ grants: z.array(treasuryGrantSchema).max(100) })
  .strict();

// ---------------------------------------------------------------------------
// Delegation (WS-M.4.2c-3) + action budgets (WS-M.3.2a).
// ---------------------------------------------------------------------------

export const delegationScopeSchema = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ proposal_type: z.string().min(1).max(64) }).strict(),
]);

export const delegationSchema = z
  .object({
    delegation_id: uuidSchema,
    room_id: uuidSchema,
    delegator_user_id: uuidSchema.nullable(),
    delegate_user_id: uuidSchema.nullable(),
    scope: delegationScopeSchema,
    state: z.enum(['active', 'revoked']),
    created_at: isoTimestampSchema,
    revoked_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type DelegationWire = z.infer<typeof delegationSchema>;

export const delegationCreateRequestSchema = z
  .object({
    delegate_user_id: uuidSchema,
    scope: delegationScopeSchema,
  })
  .strict();
export type DelegationCreateRequest = z.infer<typeof delegationCreateRequestSchema>;

export const delegationListResponseSchema = z
  .object({ delegations: z.array(delegationSchema).max(200) })
  .strict();

export const actionBudgetStatusSchema = z
  .object({
    room_id: uuidSchema,
    available_units: z.number().int().min(0),
    /** Cost of each budgeted action type for display before signing (§17.7). */
    costs: z.record(z.string(), z.number().int().min(0)),
    /** Budgets are capacity, never status: no transfer path exists. */
    transferable: z.literal(false),
  })
  .strict();
export type ActionBudgetStatus = z.infer<typeof actionBudgetStatusSchema>;

// ---------------------------------------------------------------------------
// Freeze / pause (WS-M.2.4a/b) + readiness attestations (WS-M.1.2d/e).
// ---------------------------------------------------------------------------

export const treasuryFreezeRequestSchema = z
  .object({
    action: z.enum(['freeze', 'unfreeze']),
    scope: z.enum(['treasury', 'room']),
    source: z.enum(TREASURY_FREEZE_SOURCES),
    /** Capped at the READ schemas' 500 (profile/dashboard `freeze_reason`) —
     *  a longer stored reason would fail every subsequent response parse. */
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type TreasuryFreezeRequest = z.infer<typeof treasuryFreezeRequestSchema>;

export const treasuryPauseRequestSchema = z
  .object({
    /** Partial: only the named scopes change (WS-M.2.4b granular pause). */
    deposits: z.boolean().optional(),
    proposals: z.boolean().optional(),
    executions: z.boolean().optional(),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type TreasuryPauseRequest = z.infer<typeof treasuryPauseRequestSchema>;

/** Attestable readiness items: the steward's safety-override acknowledgment
 *  (WS-M.1.2d) and the platform-recorded external audit (WS-M.1.2e). */
export const readinessAttestationRequestSchema = z
  .object({
    item: z.enum(['safety_override_acknowledged', 'external_audit_passed']),
    note: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type ReadinessAttestationRequest = z.infer<typeof readinessAttestationRequestSchema>;

// ---------------------------------------------------------------------------
// Reconciliation snapshots (WS-M.5.2a) + accounting export (WS-M.5.2b).
// ---------------------------------------------------------------------------

export const treasuryReconciliationSnapshotSchema = z
  .object({
    snapshot_id: uuidSchema,
    treasury_id: uuidSchema,
    asset: z.string().min(1).max(32),
    product_ledger_balance: minorUnitAmountSchema,
    receipts_balance: minorUnitAmountSchema,
    onchain_observed_balance: minorUnitAmountSchema,
    /** Max pairwise absolute difference (minor units). */
    gap: minorUnitAmountSchema,
    /** Required (non-null) whenever the result is `explained`. */
    explanation: z.record(z.string(), z.unknown()).nullable(),
    result: z.enum(RECONCILIATION_SNAPSHOT_RESULTS),
    observed_at: isoTimestampSchema,
  })
  .strict();
export type TreasuryReconciliationSnapshot = z.infer<typeof treasuryReconciliationSnapshotSchema>;

export const accountingExportRowSchema = z
  .object({
    event_kind: z.enum(['deposit', 'disbursement', 'fee', 'reversal']),
    receipt_id: uuidSchema.nullable(),
    tx_hash: z.string().max(66).nullable(),
    asset: z.string().min(1).max(32),
    amount: minorUnitAmountSchema,
    /** USD equivalent AT EVENT TIME from the recorded quote (never live). */
    usd_equivalent_at_event: z.string().max(40).nullable(),
    category: z.string().min(1).max(64).nullable(),
    reconciliation_result: z.enum(RECONCILIATION_SNAPSHOT_RESULTS),
    occurred_at: isoTimestampSchema,
  })
  .strict();
export type AccountingExportRow = z.infer<typeof accountingExportRowSchema>;

export const accountingExportResponseSchema = z
  .object({
    treasury_id: uuidSchema,
    period_start: isoTimestampSchema,
    period_end: isoTimestampSchema,
    /** Versioned export schema (WS-M.5.2b — stable + documented). */
    export_schema_version: z.literal(1),
    rows: z.array(accountingExportRowSchema).max(10_000),
    /** Divergent/unreconciled events are flagged separately, never silent. */
    excluded_unreconciled: z.number().int().min(0),
  })
  .strict();
export type AccountingExportResponse = z.infer<typeof accountingExportResponseSchema>;

// ---------------------------------------------------------------------------
// Readiness attestation records (read side).
// ---------------------------------------------------------------------------

export const readinessAttestationSchema = z
  .object({
    room_id: uuidSchema,
    item: z.enum(READINESS_REQUIREMENTS),
    attested_by_user_id: uuidSchema.nullable(),
    note: z.string().max(2_000),
    created_at: isoTimestampSchema,
  })
  .strict();
export type ReadinessAttestation = z.infer<typeof readinessAttestationSchema>;
