// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.1/3/4 Knomosis wire contracts (SPEC §22.2, §23.4, §23.5).  The gateway
// surface (deployments/manifest, preflight, submit, action status), the five
// emergency kill switches (WS-L.3.5), and the K1 governance-simulation surface
// (proposals, simulated treasury, audit log, readiness, comprehension).
//
// Fail-closed vocabulary: every rejection carries a typed reason code from the
// closed KNOMOSIS_REASON_CODES list; the §23.5 submission state machine uses
// exactly the eight ratified state names.  Monetary amounts are decimal strings
// in the asset's minor units (never floats — SPEC §22.2 discipline).

import { z } from 'zod';
import { previewRiskLabelSchema } from '../knomosis/preview.js';
import { knomosisSignedActionTypeSchema } from '../knomosis/typed-data.js';
import { isoTimestampSchema, uuidSchema } from './common.js';

/** Lowercased 0x-prefixed 20-byte address (pin/manifest canonical form). */
export const lowercaseAddressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, { message: 'must be a lowercased 0x hex address' });

/** 0x-prefixed 32-byte hash (manifest / payload / typed-data hashes). */
export const hash32Schema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, { message: 'must be a lowercased 0x 32-byte hash' });

/** Non-negative integer amount string in the asset's minor units. */
export const minorUnitAmountSchema = z
  .string()
  .regex(/^\d{1,78}$/, { message: 'amount must be an integer string (minor units)' });

/** A STRICTLY POSITIVE minor-unit amount (at least one non-zero digit) — for value
 *  transfers where a zero is meaningless and would otherwise let repeated `"0"`
 *  actions pad the §23.4 readiness track record without real governance (WS-L.4.1c). */
export const positiveMinorUnitAmountSchema = minorUnitAmountSchema.refine(
  (amount) => /[1-9]/.test(amount),
  { message: 'amount must be a positive integer (minor units)' },
);

// ---------------------------------------------------------------------------
// Deployments (WS-L.1.1a-1; SPEC §22.2 KnomosisDeployment)
// ---------------------------------------------------------------------------

export const KNOMOSIS_ENVIRONMENTS = [
  'local',
  'testnet',
  'capped_production',
  'mature_production',
] as const;
export type KnomosisEnvironment = (typeof KNOMOSIS_ENVIRONMENTS)[number];
export const knomosisEnvironmentSchema = z.enum(KNOMOSIS_ENVIRONMENTS);

export const KNOMOSIS_DEPLOYMENT_STATUSES = [
  'provisioning',
  'active',
  'frozen',
  'retired',
] as const;
export type KnomosisDeploymentStatus = (typeof KNOMOSIS_DEPLOYMENT_STATUSES)[number];
export const knomosisDeploymentStatusSchema = z.enum(KNOMOSIS_DEPLOYMENT_STATUSES);

export const knomosisDeploymentSchema = z
  .object({
    deployment_id: uuidSchema,
    environment: knomosisEnvironmentSchema,
    chain_id: z.number().int().positive(),
    l1_bridge_address: lowercaseAddressSchema,
    /** Config KEY reference — never a raw endpoint/credential (WS-L.1.1a-1). */
    runtime_endpoint_ref: z.string().min(1).max(128),
    contract_manifest_hash: hash32Schema,
    pinned_knomosis_commit: z.string().regex(/^[0-9a-f]{40}$/),
    status: knomosisDeploymentStatusSchema,
    created_at: isoTimestampSchema,
  })
  .strict();
export type KnomosisDeployment = z.infer<typeof knomosisDeploymentSchema>;

export const knomosisDeploymentListResponseSchema = z
  .object({ deployments: z.array(knomosisDeploymentSchema) })
  .strict();
export type KnomosisDeploymentListResponse = z.infer<typeof knomosisDeploymentListResponseSchema>;

/** Manifest — the client's source of truth for domain separation (WS-L.1.1a-1). */
export const knomosisManifestResponseSchema = z
  .object({
    deployment_id: uuidSchema,
    environment: knomosisEnvironmentSchema,
    chain_id: z.number().int().positive(),
    chain_name: z.string().min(1).max(64),
    l1_bridge_address: lowercaseAddressSchema,
    /** The EIP-712 `verifyingContract` for Licio signed actions (WS-L.2.4c). */
    verifying_contract_address: lowercaseAddressSchema,
    contract_manifest_hash: hash32Schema,
    abi_manifest_hash: hash32Schema,
    pinned_knomosis_commit: z.string().regex(/^[0-9a-f]{40}$/),
    /** EIP-712 domain `version` for this deployment. */
    eip712_domain_version: z.string().min(1).max(16),
    typed_data_registry_version: z.string().min(1).max(16),
    /** Every contract address the gateway may interact with (WS-L.3.1b-1). */
    contract_allowlist: z.array(lowercaseAddressSchema).max(256),
    /** Confirmation depth from the validated finality memo (WS-L.1.1b-1). */
    confirmation_depth: z.number().int().min(0),
  })
  .strict();
export type KnomosisManifestResponse = z.infer<typeof knomosisManifestResponseSchema>;

// ---------------------------------------------------------------------------
// Reason codes + preflight pipeline (WS-L.3.1a-c)
// ---------------------------------------------------------------------------

export const KNOMOSIS_REASON_CODES = [
  'ACTION_TYPE_UNKNOWN',
  'GOVERNANCE_MODE_INVALID',
  'GOVERNANCE_FROZEN',
  'SIGNATURE_INVALID',
  'DOMAIN_MISMATCH',
  'ROLE_INSUFFICIENT',
  'CAP_EXCEEDED',
  'POLICY_CONFLICT',
  'SANCTIONS_BLOCKED',
  'FRAUD_RISK',
  'CONTRACT_NOT_ALLOWED',
  'JURISDICTION_BLOCKED',
  'JURISDICTION_UNKNOWN',
  'NONCE_REUSED',
  'EXPIRED',
  'KILL_SWITCH_ACTIVE',
  'PREFLIGHT_REQUIRED',
  'PREFLIGHT_EXPIRED',
  'PREFLIGHT_USED',
  'PAYLOAD_MISMATCH',
  'WALLET_NOT_ACTIVE',
  'WALLET_CHAIN_MISMATCH',
  'RISK_BLOCKED',
  'DEPLOYMENT_UNKNOWN',
  'CRYPTO_DISABLED',
  'GATEWAY_UNAVAILABLE',
  'IDEMPOTENCY_REQUIRED',
] as const;
export type KnomosisReasonCode = (typeof KNOMOSIS_REASON_CODES)[number];
export const knomosisReasonCodeSchema = z.enum(KNOMOSIS_REASON_CODES);

/** The ordered preflight pipeline steps (WS-L.3.1a; short-circuit on first fail). */
export const PREFLIGHT_STEPS = [
  'action_type',
  'governance_mode',
  'signature',
  'role_permission',
  'caps',
  'policy_conflict',
  'sanctions',
  'fraud_risk',
  'contract_allowlist',
] as const;
export type PreflightStep = (typeof PREFLIGHT_STEPS)[number];
export const preflightStepSchema = z.enum(PREFLIGHT_STEPS);

export const knomosisPreflightRequestSchema = z
  .object({
    action_type: z.string().min(1).max(64),
    /** The WS-M payment intent this action settles, when it has one.  A
     *  deposit/payout is reviewed ONCE: the intent preflight and this action
     *  are two legs of one attempt, and naming the intent lets the compliance
     *  engine treat them as such (a fraud-queue release then unblocks the
     *  signed leg instead of meeting a second, unclearable review).  Absent
     *  for an action minted outside an intent — which is reviewed on its own.
     *  Unverified by itself: the review key binds the SESSION user and the
     *  signed amount, so a borrowed intent id buys nothing. */
    payment_intent_id: uuidSchema.optional(),
    room_id: uuidSchema,
    deployment_id: uuidSchema,
    wallet_account_id: uuidSchema,
    /** The EIP-712 message object exactly as it will be signed (registry-shaped). */
    typed_data_message: z.record(z.string(), z.string()),
    /** The wallet signature over the typed data (0x hex). */
    signature: z.string().regex(/^0x[0-9a-fA-F]{130,4096}$/),
  })
  .strict();
export type KnomosisPreflightRequest = z.infer<typeof knomosisPreflightRequestSchema>;

export const knomosisPreflightPassSchema = z
  .object({
    result: z.literal('pass'),
    action_type: knomosisSignedActionTypeSchema,
    room_id: uuidSchema,
    /** Single-use preflight token the submission endpoint requires (WS-L.3.1c). */
    preflight_token: z.string().min(16).max(128),
    expires_at: isoTimestampSchema,
    /** EIP-712 digest of the preflighted payload (binds preflight → submit). */
    typed_data_hash: hash32Schema,
    /** sha-256 pairing of the human summary to the machine payload (§23.5). */
    summary_payload_hash: hash32Schema,
    /** The plain-language summary the hash covers. */
    human_summary: z.string().min(1).max(2_000),
    /** WS-L.2.6e — the signed amount is at/above the high-value threshold, so the
     *  submission requires a FRESH step-up assertion (not merely a session inside
     *  the general step-up window).  Clients gate `TransactionPreview` on it; the
     *  submit endpoint enforces it server-side. */
    high_value_step_up_required: z.boolean().default(false),
    timestamp: isoTimestampSchema,
  })
  .strict();
export type KnomosisPreflightPass = z.infer<typeof knomosisPreflightPassSchema>;

export const knomosisPreflightFailSchema = z
  .object({
    result: z.literal('fail'),
    reason_code: knomosisReasonCodeSchema,
    human_message: z.string().min(1).max(1_000),
    failed_step: preflightStepSchema,
    action_type: z.string().min(1).max(64),
    room_id: uuidSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type KnomosisPreflightFail = z.infer<typeof knomosisPreflightFailSchema>;

export const knomosisPreflightResponseSchema = z.discriminatedUnion('result', [
  knomosisPreflightPassSchema,
  knomosisPreflightFailSchema,
]);
export type KnomosisPreflightResponse = z.infer<typeof knomosisPreflightResponseSchema>;

// ---------------------------------------------------------------------------
// Submission + action status (WS-L.3.2a/b; §23.5 state machine)
// ---------------------------------------------------------------------------

/**
 * The §23.5 submission states.  `reserving` is the pre-submit idempotency
 * reservation state (WS-L.3.2a): the action row is inserted `reserving` BEFORE
 * the single-use preflight token / nonce are consumed, and advances to
 * `submitted` ONLY after every submit gate passes.  A `reserving` row is never
 * forwarded to the gateway (the retry sweep lists `submitted` only) and is never
 * reconciled, so a submission abandoned mid-validation (e.g. a process crash)
 * cannot reach the kernel without completing verification.  The other eight are
 * the ratified post-submit lifecycle states; `finalized`/`reverted`/`failed`
 * are terminal.
 */
export const SUBMISSION_STATES = [
  'reserving',
  'submitted',
  'accepted',
  'settled',
  'finalized',
  'challenged',
  'reverted',
  'frozen',
  'failed',
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];
export const submissionStateSchema = z.enum(SUBMISSION_STATES);

export const RECONCILIATION_STATES = [
  'pending',
  'matched',
  'mismatch',
  /** Reconciliation halted fail-closed on an unknown gateway event affecting
   *  this deployment (WS-L.3 contract note) until the schema is updated. */
  'halted_unsupported_version',
] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];
export const reconciliationStateSchema = z.enum(RECONCILIATION_STATES);

export const knomosisSubmitRequestSchema = z
  .object({
    preflight_token: z.string().min(16).max(128),
    /** Client-generated idempotency key (WS-L.3.2a). */
    idempotency_key: uuidSchema,
    action_type: z.string().min(1).max(64),
    /** The intent this action settles — see the preflight request.  Submit
     *  re-runs the same compliance gates, so it names the same attempt. */
    payment_intent_id: uuidSchema.optional(),
    room_id: uuidSchema,
    deployment_id: uuidSchema,
    wallet_account_id: uuidSchema,
    typed_data_message: z.record(z.string(), z.string()),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130,4096}$/),
  })
  .strict();
export type KnomosisSubmitRequest = z.infer<typeof knomosisSubmitRequestSchema>;

export const knomosisActionRecordSchema = z
  .object({
    action_record_id: uuidSchema,
    deployment_id: uuidSchema,
    action_type: knomosisSignedActionTypeSchema,
    room_id: uuidSchema,
    /** Opaque actor reference (wallet account id) — never an address. */
    actor_ref: uuidSchema,
    payload_hash: hash32Schema,
    typed_data_hash: hash32Schema,
    submission_state: submissionStateSchema,
    /** Failure reason when `submission_state = failed` (WS-L.3.2b). */
    failure_reason: z.string().min(1).max(500).nullable(),
    indexed_event_ref: uuidSchema.nullable(),
    reconciliation_state: reconciliationStateSchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type KnomosisActionRecord = z.infer<typeof knomosisActionRecordSchema>;

export const knomosisSubmitResponseSchema = z
  .object({
    action_record_id: uuidSchema,
    submission_state: submissionStateSchema,
    /** Present when the gateway declined the action (200 accepted:false model). */
    reason_code: knomosisReasonCodeSchema.nullable(),
    human_message: z.string().min(1).max(1_000).nullable(),
  })
  .strict();
export type KnomosisSubmitResponse = z.infer<typeof knomosisSubmitResponseSchema>;

export const knomosisActionStatusResponseSchema = z
  .object({ action: knomosisActionRecordSchema })
  .strict();
export type KnomosisActionStatusResponse = z.infer<typeof knomosisActionStatusResponseSchema>;

// ---------------------------------------------------------------------------
// Kill switches (WS-L.3.5a-f)
// ---------------------------------------------------------------------------

export const KILL_SWITCH_IDS = [
  'wallet_connection',
  'payment_intent_creation',
  'action_submission',
  'treasury_execution',
  'governance_voting',
] as const;
export type KillSwitchId = (typeof KILL_SWITCH_IDS)[number];
export const killSwitchIdSchema = z.enum(KILL_SWITCH_IDS);

export const KILL_SWITCH_SCOPE_TYPES = ['global', 'region', 'room'] as const;
export type KillSwitchScopeType = (typeof KILL_SWITCH_SCOPE_TYPES)[number];
export const killSwitchScopeTypeSchema = z.enum(KILL_SWITCH_SCOPE_TYPES);

/** One switch's engaged scopes (empty everywhere ⇒ inactive). */
export const killSwitchScopesSchema = z
  .object({
    global: z.boolean(),
    /** BCP-47 region subtags (self-declared locale regions; §19.1 — no IP). */
    regions: z.array(z.string().min(2).max(8)).max(256),
    room_ids: z.array(uuidSchema).max(1_024),
  })
  .strict();
export type KillSwitchScopes = z.infer<typeof killSwitchScopesSchema>;

/** §30.8 release-card metadata carried by every activation. */
export const killSwitchReleaseCardSchema = z
  .object({
    owner: z.string().min(1).max(128),
    trigger_condition: z.string().min(1).max(512),
    rollback_path: z.string().min(1).max(512),
    review_date: isoTimestampSchema,
  })
  .strict();
export type KillSwitchReleaseCard = z.infer<typeof killSwitchReleaseCardSchema>;

export const killSwitchStateSchema = z
  .object({
    switch_id: killSwitchIdSchema,
    scopes: killSwitchScopesSchema,
    release_card: killSwitchReleaseCardSchema.nullable(),
    engaged_at: isoTimestampSchema.nullable(),
    /** Pending two-person deactivation request (WS-L.3.5f), if any. */
    deactivation_requested_by: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type KillSwitchState = z.infer<typeof killSwitchStateSchema>;

export const killSwitchRegistryResponseSchema = z
  .object({
    switches: z.array(killSwitchStateSchema).length(KILL_SWITCH_IDS.length),
    /** True when the stored registry state was unreadable (fail-closed: all engaged). */
    unreadable: z.boolean(),
  })
  .strict();
export type KillSwitchRegistryResponse = z.infer<typeof killSwitchRegistryResponseSchema>;

export const killSwitchActivateRequestSchema = z
  .object({
    action: z.literal('activate'),
    switch_id: killSwitchIdSchema,
    scopes: killSwitchScopesSchema,
    release_card: killSwitchReleaseCardSchema,
    reason: z.string().min(1).max(1_000),
  })
  .strict();

export const killSwitchDeactivateRequestSchema = z
  .object({
    /** Two-person rule: `request` records intent; `confirm` (by a DIFFERENT
     *  operator) applies it (WS-L.3.5f reviewed deactivation). */
    action: z.enum(['request_deactivation', 'confirm_deactivation']),
    switch_id: killSwitchIdSchema,
    reason: z.string().min(1).max(1_000),
  })
  .strict();

export const killSwitchAdminRequestSchema = z
  .discriminatedUnion('action', [
    killSwitchActivateRequestSchema,
    killSwitchDeactivateRequestSchema,
  ])
  .superRefine((req, ctx) => {
    // An ACTIVATION must engage at least one scope; the all-empty shape means
    // "inactive", so accepting it would record a release card while blocking no
    // request — an operator typo that looks like an emergency pause (WS-L.3.5f).
    if (
      req.action === 'activate' &&
      !req.scopes.global &&
      req.scopes.regions.length === 0 &&
      req.scopes.room_ids.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'An activation must engage at least one scope (global, a region, or a room).',
        path: ['scopes'],
      });
    }
  });
export type KillSwitchAdminRequest = z.infer<typeof killSwitchAdminRequestSchema>;

// ---------------------------------------------------------------------------
// Governance simulation (WS-L.4; SPEC §17.4, §22.2 GovernanceProposal)
// ---------------------------------------------------------------------------

/** The proposal templates: the three K1 sim templates (WS-L.4.1b; §17.3.4 MVP
 *  law pack) plus the WS-M production types (steward rotation, law-pack
 *  upgrade, treasury-policy update). */
export const PROPOSAL_TYPES = [
  'charter_update',
  'bounty',
  'capped_grant',
  'steward_rotation',
  'law_pack_upgrade',
  'treasury_policy_update',
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];
export const proposalTypeSchema = z.enum(PROPOSAL_TYPES);

export const PROPOSAL_PREFLIGHT_STATES = ['pending', 'passed', 'failed'] as const;
/** Sim rows use open→settled; WS-M production rows prefix draft→deliberation. */
export const PROPOSAL_VOTING_STATES = [
  'open',
  'passed',
  'rejected',
  'quorum_not_met',
  'draft',
  'deliberation',
] as const;
export const PROPOSAL_CHALLENGE_STATES = [
  'none',
  'open',
  'upheld',
  'dismissed',
  // WS-M.4.3a platform escalation.
  'escalated',
] as const;
export const PROPOSAL_EXECUTION_STATES = [
  'not_executed',
  'timelocked',
  // `executing` — the recoverable in-progress state: claimed before the simulated
  // debit, advanced to `executed` only once the debit + ledger are durable (WS-L.4.1c).
  'executing',
  'executed',
  'blocked',
  // WS-M: a passed proposal whose execution window lapsed.
  'expired',
] as const;
export type ProposalVotingState = (typeof PROPOSAL_VOTING_STATES)[number];
export type ProposalChallengeColumnState = (typeof PROPOSAL_CHALLENGE_STATES)[number];
export type ProposalExecutionState = (typeof PROPOSAL_EXECUTION_STATES)[number];

/** The simulated asset ledger prefix — fake assets are ALWAYS SIM-* (WS-L.4.1c). */
export const SIM_ASSET_PREFIX = 'SIM-' as const;
/** The persistent simulation banner text (WS-L.4.1c — cannot be dismissed). */
export const SIMULATION_LABEL = 'SIMULATED — NO REAL VALUE' as const;

const simAssetSchema = z
  .string()
  .regex(/^SIM-[A-Z0-9]{1,28}$/, { message: 'simulated assets must use the SIM- prefix' });

export const governanceProposalCreateSchema = z
  .object({
    proposal_type: proposalTypeSchema,
    title: z.string().trim().min(1).max(200),
    plain_language_summary: z.string().trim().min(1).max(2_000),
    /** Budget impact (simulated minor units); required for bounty/capped_grant. */
    requested_amount: minorUnitAmountSchema.nullable(),
    asset: simAssetSchema.nullable(),
    /** Opaque recipient reference (user id / entity ref) for grants/bounties. */
    recipient_ref: z.string().min(1).max(128).nullable(),
    /** Required (non-empty) for bounty and capped_grant templates (WS-L.4.1b). */
    conflict_disclosures: z.string().trim().max(2_000).nullable(),
    risk_assessment: z.string().trim().min(1).max(2_000),
    /** Structured requested action payload (template-shaped). */
    requested_action: z.record(z.string(), z.unknown()),
    expected_deliverable: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type GovernanceProposalCreate = z.infer<typeof governanceProposalCreateSchema>;

export const governanceProposalSchema = z
  .object({
    proposal_id: uuidSchema,
    room_id: uuidSchema,
    // Null once the proposer's account is erased (WS-L data-rights).
    proposer_user_id: uuidSchema.nullable(),
    proposal_type: proposalTypeSchema,
    title: z.string().min(1).max(200),
    plain_language_summary: z.string().min(1).max(2_000),
    requested_amount: minorUnitAmountSchema.nullable(),
    asset: simAssetSchema.nullable(),
    recipient_ref: z.string().min(1).max(128).nullable(),
    conflict_disclosures: z.string().max(2_000).nullable(),
    risk_assessment: z.string().min(1).max(2_000),
    requested_action: z.record(z.string(), z.unknown()),
    expected_deliverable: z.string().min(1).max(1_000),
    preflight_state: z.enum(PROPOSAL_PREFLIGHT_STATES),
    voting_state: z.enum(PROPOSAL_VOTING_STATES),
    challenge_state: z.enum(PROPOSAL_CHALLENGE_STATES),
    execution_state: z.enum(PROPOSAL_EXECUTION_STATES),
    /** Vote tallies (one-account-one-vote simulation default, WS-L.4.1d). */
    votes_approve: z.number().int().min(0),
    votes_reject: z.number().int().min(0),
    votes_abstain: z.number().int().min(0),
    /** When the simulated timelock elapses (null before passing). */
    executable_after: isoTimestampSchema.nullable(),
    simulation_mode: z.boolean(),
    created_at: isoTimestampSchema,
    executed_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type GovernanceProposal = z.infer<typeof governanceProposalSchema>;

export const governanceProposalListResponseSchema = z
  .object({ proposals: z.array(governanceProposalSchema) })
  .strict();
export type GovernanceProposalListResponse = z.infer<typeof governanceProposalListResponseSchema>;

export const proposalVoteRequestSchema = z
  .object({ choice: z.enum(['approve', 'reject', 'abstain']) })
  .strict();
export type ProposalVoteRequest = z.infer<typeof proposalVoteRequestSchema>;

// --- Simulated treasury (WS-L.4.1c) ----------------------------------------

/** Max DISTINCT assets a simulated treasury may hold; a deposit introducing an
 *  asset beyond this is rejected so the response can never violate the schema. */
export const SIM_TREASURY_MAX_ASSETS = 16;

export const simTreasuryBalanceSchema = z
  .object({
    asset: simAssetSchema,
    amount: minorUnitAmountSchema,
  })
  .strict();

export const simTreasuryResponseSchema = z
  .object({
    room_id: uuidSchema,
    /** Always the WS-L.4.1c banner — the client must render it undismissably. */
    simulation_label: z.literal(SIMULATION_LABEL),
    balances: z.array(simTreasuryBalanceSchema).max(SIM_TREASURY_MAX_ASSETS),
    updated_at: isoTimestampSchema,
  })
  .strict();
export type SimTreasuryResponse = z.infer<typeof simTreasuryResponseSchema>;

export const simTreasuryDepositRequestSchema = z
  .object({
    asset: simAssetSchema,
    // A deposit must move real (simulated) value — a zero deposit is rejected so it
    // cannot pad the readiness track record (WS-L.4.1c).
    amount: positiveMinorUnitAmountSchema,
    /** Client-generated idempotency key (WS-L.4.1c) — REQUIRED: a retried deposit
     *  (double-tap or network retry) carrying the SAME key credits the treasury at
     *  most once.  Without it every replay would credit again AND append another
     *  qualifying audit entry, letting a client inflate balances + the readiness track
     *  record by resubmitting the same action. */
    idempotency_key: uuidSchema,
  })
  .strict();
export type SimTreasuryDepositRequest = z.infer<typeof simTreasuryDepositRequestSchema>;

// --- Governance audit log (WS-L.4.1f) --------------------------------------

export const GOVERNANCE_AUDIT_ACTION_TYPES = [
  'proposal_created',
  'vote_cast',
  'proposal_passed',
  'proposal_rejected',
  'execution_simulated',
  'treasury_deposit_simulated',
  'mode_transition_requested',
  'mode_transition_applied',
  'comprehension_passed',
  // --- WS-M production governance (docs/planning/14-treasury-and-governance.md).
  'proposal_published',
  'vote_signature_recorded',
  'proposal_voting_settled',
  'challenge_filed',
  'challenge_resolved',
  'proposal_executed',
  'proposal_execution_failed',
  'treasury_created',
  'deposit_recorded',
  'payment_intent_created',
  'payment_intent_transition',
  'treasury_freeze_set',
  'treasury_freeze_cleared',
  'treasury_pause_changed',
  'grant_created',
  'grant_milestone_updated',
  'law_pack_registered',
  'law_pack_adopted',
  'charter_version_created',
  'readiness_attested',
  'delegation_created',
  'delegation_revoked',
  'reconciliation_snapshot',
] as const;
export type GovernanceAuditActionType = (typeof GOVERNANCE_AUDIT_ACTION_TYPES)[number];

export const governanceAuditEntrySchema = z
  .object({
    entry_id: uuidSchema,
    action_type: z.enum(GOVERNANCE_AUDIT_ACTION_TYPES),
    room_id: uuidSchema,
    actor_user_id: uuidSchema.nullable(),
    action_details: z.record(z.string(), z.unknown()),
    simulation_mode: z.boolean(),
    created_at: isoTimestampSchema,
    /** WS-M.4.3c hash chain (per-room).  Absent on pre-chain (WS-L.4) entries. */
    prev_hash: hash32Schema.nullable().optional(),
    integrity_hash: hash32Schema.nullable().optional(),
    /** WS-M linkage columns (absent on WS-L.4 entries). */
    proposal_id: uuidSchema.nullable().optional(),
    treasury_id: uuidSchema.nullable().optional(),
  })
  .strict();
export type GovernanceAuditEntry = z.infer<typeof governanceAuditEntrySchema>;

export const governanceAuditLogResponseSchema = z
  .object({
    entries: z.array(governanceAuditEntrySchema).max(100),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type GovernanceAuditLogResponse = z.infer<typeof governanceAuditLogResponseSchema>;

// --- Room readiness + mode transitions (WS-L.4.1g) --------------------------

export const READINESS_REQUIREMENTS = [
  'charter_present',
  'stewards_designated',
  'treasury_policy_defined',
  'safety_override_acknowledged',
  'comprehension_passed',
  'simulation_track_record',
  // WS-M.1.2e extensions (docs/planning/14-treasury-and-governance.md):
  'jurisdiction_supported',
  'law_pack_valid',
  'governance_model_ratified',
  'external_audit_passed',
] as const;
export type ReadinessRequirement = (typeof READINESS_REQUIREMENTS)[number];

/** Target modes a readiness item can be required for (WS-M.1.2e `requiredFor`). */
export const READINESS_TARGET_MODES = [
  'simulated',
  'testnet',
  'capped_production',
  'mature_production',
] as const;
export type ReadinessTargetMode = (typeof READINESS_TARGET_MODES)[number];

/** One evaluated checklist item (WS-M.1.2e — the per-item extension of the
 *  shipped `unmet` list; `not_applicable` items never block a transition). */
export const readinessItemSchema = z
  .object({
    requirement: z.enum(READINESS_REQUIREMENTS),
    status: z.enum(['pass', 'fail', 'not_applicable']),
    description: z.string().min(1).max(500),
    required_for: z.array(z.enum(READINESS_TARGET_MODES)).max(READINESS_TARGET_MODES.length),
    evaluated_at: isoTimestampSchema,
  })
  .strict();
export type ReadinessItem = z.infer<typeof readinessItemSchema>;

export const roomReadinessResponseSchema = z
  .object({
    room_id: uuidSchema,
    current_mode: z.string().min(1).max(32),
    /** The evaluated target (WS-M.1.2e); absent on the legacy next-mode read. */
    target_mode: z.enum(READINESS_TARGET_MODES).optional(),
    ready: z.boolean(),
    unmet: z
      .array(
        z
          .object({
            requirement: z.enum(READINESS_REQUIREMENTS),
            description: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(READINESS_REQUIREMENTS.length),
    /** Full per-item checklist (WS-M.1.2e); absent on the legacy shape. */
    items: z.array(readinessItemSchema).max(READINESS_REQUIREMENTS.length).optional(),
  })
  .strict();
export type RoomReadinessResponse = z.infer<typeof roomReadinessResponseSchema>;

/** Every governance mode a transition may target (WS-M.1.1b edge table; the
 *  gate decides which edges are legal from the current mode). */
export const MODE_TRANSITION_TARGETS = [
  'ordinary',
  'simulated',
  'testnet',
  'capped_production',
  'mature_production',
  'frozen',
  'migrating',
] as const;

export const modeTransitionRequestSchema = z
  .object({
    target_mode: z.enum(MODE_TRANSITION_TARGETS),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type ModeTransitionRequest = z.infer<typeof modeTransitionRequestSchema>;

// --- Comprehension testing (WS-L.4.1e) --------------------------------------

export const comprehensionQuestionSchema = z
  .object({
    question_id: z.string().min(1).max(64),
    prompt: z.string().min(1).max(500),
    choices: z.array(z.string().min(1).max(300)).min(2).max(5),
    /** Explanation shown when answered incorrectly (WS-L.4.1e). */
    explanation: z.string().min(1).max(500),
  })
  .strict();
export type ComprehensionQuestion = z.infer<typeof comprehensionQuestionSchema>;

export const comprehensionQuizResponseSchema = z
  .object({
    quiz_version: z.string().min(1).max(16),
    questions: z.array(comprehensionQuestionSchema).min(3).max(5),
    /** Whether the requesting user has already passed (quiz shown only once). */
    already_passed: z.boolean(),
  })
  .strict();
export type ComprehensionQuizResponse = z.infer<typeof comprehensionQuizResponseSchema>;

export const comprehensionSubmitRequestSchema = z
  .object({
    quiz_version: z.string().min(1).max(16),
    /** question_id → selected choice index. */
    answers: z.record(z.string(), z.number().int().min(0).max(4)),
  })
  .strict();
export type ComprehensionSubmitRequest = z.infer<typeof comprehensionSubmitRequestSchema>;

export const comprehensionSubmitResponseSchema = z
  .object({
    passed: z.boolean(),
    /** Per-question corrections for wrong answers (empty when passed). */
    corrections: z
      .array(
        z
          .object({
            question_id: z.string().min(1).max(64),
            correct_choice: z.number().int().min(0).max(4),
            explanation: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type ComprehensionSubmitResponse = z.infer<typeof comprehensionSubmitResponseSchema>;

// --- Governance tab bundle (WS-L.4.1a) ---------------------------------------

export const governanceTabResponseSchema = z
  .object({
    room_id: uuidSchema,
    governance_mode: z.string().min(1).max(32),
    simulation_mode: z.boolean(),
    charter_summary: z.string().max(5_000).nullable(),
    active_proposals: z.array(governanceProposalSchema).max(50),
    treasury: simTreasuryResponseSchema.nullable(),
  })
  .strict();
export type GovernanceTabResponse = z.infer<typeof governanceTabResponseSchema>;

// ---------------------------------------------------------------------------
// Transaction preview wire shape (WS-L.2.6a/b — serialized TransactionPreview)
// ---------------------------------------------------------------------------

export const transactionPreviewSchema = z
  .object({
    action_name: z.string().min(1).max(200),
    room_name: z.string().min(1).max(100),
    room_id: uuidSchema,
    recipient_or_contract: z.string().min(1).max(64),
    asset: z.string().min(1).max(32).nullable(),
    amount: z.string().min(1).max(100).nullable(),
    estimated_fee: z.string().min(1).max(100),
    reversibility_statement: z.string().min(1).max(500),
    timelock: z.string().min(1).max(200).nullable(),
    public_visibility_disclosure: z.string().min(1).max(500),
    jurisdiction_status: z.string().min(1).max(200),
    risk_label: previewRiskLabelSchema,
    wallet_address_truncated: z.string().min(1).max(64),
    chain_id: z.number().int().positive(),
    chain_name: z.string().min(1).max(64),
    contract_domain: z.string().min(1).max(120),
    expiration: z.string().min(1).max(100),
    nonce: z.string().min(1).max(100),
    related_link: z.string().min(1).max(500).nullable(),
    support_contact: z.string().min(1).max(200),
    primary_button_label: z.string().min(1).max(120),
    signed_fields: z
      .array(
        z
          .object({
            label: z.string().min(1).max(120),
            name: z.string().min(1).max(64),
            value: z.string().min(1).max(4_000),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export type TransactionPreviewWire = z.infer<typeof transactionPreviewSchema>;
