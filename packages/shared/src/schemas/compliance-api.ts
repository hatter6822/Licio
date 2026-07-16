// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N compliance wire contracts + the FinancialComplianceCase entity
// (SPEC §22.2, §17.10; docs/planning/15-compliance.md): feature availability,
// identity-free region declaration, consumer risk disclosures +
// acknowledgments, financial-compliance cases (the WS-N.2.1c review state
// machine vocabulary), the fraud queue, SAR/STR records (counsel-only,
// anti-tipping-off), lawful-access requests, and wallet-risk pins.
//
// Privacy boundary (WS-N.2.2d): NO schema in this file carries an attention,
// reading, ranking, personalization, or social-graph field — compliance
// surfaces are transaction-derived only, by construction.
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import {
  featureDisableReasonSchema,
  jurisdictionCellStateSchema,
  jurisdictionFeaturePolicySchema,
  regionCodeSchema,
  regionResolutionBasisSchema,
} from './jurisdiction.js';

// ---------------------------------------------------------------------------
// FinancialComplianceCase (SPEC §22.2 field list, exactly + subject_kind).
// ---------------------------------------------------------------------------

/** Exactly the nine spec trigger types (SPEC §22.2). */
export const CASE_TRIGGER_TYPES = [
  'velocity',
  'pattern',
  'sanctions',
  'manual',
  'fraud',
  'scam',
  'impersonation',
  'bribery',
  'coercion',
] as const;
export type CaseTriggerType = (typeof CASE_TRIGGER_TYPES)[number];
export const caseTriggerTypeSchema = z.enum(CASE_TRIGGER_TYPES);

export const CASE_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type CaseRiskLevel = (typeof CASE_RISK_LEVELS)[number];
export const caseRiskLevelSchema = z.enum(CASE_RISK_LEVELS);

export const CASE_REVIEW_STATES = [
  'open',
  'assigned',
  'investigating',
  'resolved',
  'escalated',
] as const;
export type CaseReviewState = (typeof CASE_REVIEW_STATES)[number];
export const caseReviewStateSchema = z.enum(CASE_REVIEW_STATES);

export const CASE_RESOLUTION_OUTCOMES = [
  'cleared',
  'restricted',
  'escalated',
  'referred_to_law_enforcement',
  'account_suspended',
] as const;
export type CaseResolutionOutcome = (typeof CASE_RESOLUTION_OUTCOMES)[number];

export const caseResolutionSchema = z
  .object({
    outcome: z.enum(CASE_RESOLUTION_OUTCOMES),
    notes: z.string().min(1).max(4000),
    resolved_by: uuidSchema,
    resolved_at: isoTimestampSchema,
  })
  .strict();
export type CaseResolution = z.infer<typeof caseResolutionSchema>;

export const caseRetentionPolicySchema = z
  .object({
    retention_period_days: z.number().int().min(1).max(36_500),
    deletion_date: isoTimestampSchema,
    /** Whether ANY legal obligation currently holds this case.  DERIVED from
     *  `legal_hold_refs` — never set on its own (`setLegalHold` is the only
     *  writer, and it computes both together).  It stays a first-class field
     *  because every reader and the `NOT_HELD` SQL predicate ask exactly this
     *  question. */
    legal_hold: z.boolean(),
    /** The obligations holding this case, one OPAQUE ref each (WS-N.2.1e).
     *
     *  A hold is not a boolean: a SAR and a lawful-access request can hold the
     *  same case at once, and each must release only ITS OWN — a denied
     *  lawful-access request clearing a shared flag would drop the retention
     *  protection an outstanding SAR still needs, letting account deletion
     *  scrub the subject and the retention sweep anonymize the case.
     *
     *  The refs are opaque (`opaqueRef`) BECAUSE this policy is visible to
     *  compliance reviewers: a readable `sar:<id>` would announce the report's
     *  existence to the very reviewers it must be kept from (anti-tipping-off).
     *  A count is not a disclosure — a held case already shows its hold. */
    legal_hold_refs: z.array(z.string().min(1).max(128)).default([]),
    /** Set when the retention sweep ANONYMIZED this case in place instead of
     *  deleting it (WS-N.2.1d): the schedule's obligation is discharged and
     *  the stripped row is kept indefinitely.  It marks the case done, so the
     *  sweep stops re-selecting a row whose `deletion_date` is forever in the
     *  past — which would re-anonymize it and re-audit it every round. */
    anonymized_at: isoTimestampSchema.nullish(),
    /** Set when the right-to-erasure scrub reached this case and a legal hold
     *  held it back (WS-N.2.1a).  The obligation does not evaporate with the
     *  sweep that found it: the subject asked to be erased and only the hold
     *  defers that, so the case carries the debt until the retention sweep can
     *  discharge it — the account is tombstoned by then and no later WS-D sweep
     *  will ever come back for it. */
    erasure_pending: z.boolean().optional(),
  })
  .strict();
export type CaseRetentionPolicy = z.infer<typeof caseRetentionPolicySchema>;

/** Case subjects: a user, a room, an EXTERNAL counterparty address (a
 *  sanctions screening hit has no user/room subject — the address is the
 *  investigation subject; §19.5 treats it as personal data, confined here),
 *  or a transaction (a lawful-access request may target one; typing it as a
 *  user would make the queue, holds, erasure, and subject searches all treat
 *  a transaction id as an account — WS-N.2.3d). */
export const CASE_SUBJECT_KINDS = ['user', 'room', 'address', 'transaction'] as const;
export type CaseSubjectKind = (typeof CASE_SUBJECT_KINDS)[number];

export const financialComplianceCaseSchema = z
  .object({
    case_id: uuidSchema,
    /** Polymorphic SOFT subject ref (user/room id or counterparty address; no
     *  FK — house convention).  Null after a right-to-erasure scrub. */
    user_id_or_room_id: z.string().min(1).max(128).nullable(),
    subject_kind: z.enum(CASE_SUBJECT_KINDS),
    trigger_type: caseTriggerTypeSchema,
    risk_level: caseRiskLevelSchema,
    partner_case_ref: z.string().min(1).max(256).nullable(),
    review_state: caseReviewStateSchema,
    /** Reviewer assignment (mutable); the audit chain records every change. */
    assigned_to: uuidSchema.nullable(),
    resolution: caseResolutionSchema.nullable(),
    retention_policy: caseRetentionPolicySchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type FinancialComplianceCase = z.infer<typeof financialComplianceCaseSchema>;

// ---------------------------------------------------------------------------
// Feature availability (WS-N.1.1c) — the /v1/compliance/availability response.
// ---------------------------------------------------------------------------

export const featureAvailabilityEntrySchema = z
  .object({
    /** The policy cell state, or null when no policy row exists. */
    state: jurisdictionCellStateSchema.nullable(),
    available: z.boolean(),
    disable_reason: featureDisableReasonSchema.nullable(),
  })
  .strict();
export type FeatureAvailabilityEntry = z.infer<typeof featureAvailabilityEntrySchema>;

export const featureAvailabilityResponseSchema = z
  .object({
    region: regionCodeSchema.nullable(),
    basis: regionResolutionBasisSchema,
    policy_id: uuidSchema.nullable(),
    crypto_enabled: z.boolean(),
    governance_enabled: z.boolean(),
    features: z
      .object({
        wallet_connection: featureAvailabilityEntrySchema,
        testnet_transactions: featureAvailabilityEntrySchema,
        production_payments: featureAvailabilityEntrySchema,
        treasury_operations: featureAvailabilityEntrySchema,
        governance: featureAvailabilityEntrySchema,
      })
      .strict(),
    assets: z.record(z.string().min(1).max(32), z.boolean()),
    evaluated_at: isoTimestampSchema,
  })
  .strict();
export type FeatureAvailabilityResponse = z.infer<typeof featureAvailabilityResponseSchema>;

// ---------------------------------------------------------------------------
// Region declaration (WS-N.1.1f) — the PRIMARY region-establishment flow.
// ---------------------------------------------------------------------------

export const DECLARATION_STATUSES = ['pending', 'verified', 'revoked'] as const;
export type DeclarationStatus = (typeof DECLARATION_STATUSES)[number];

export const DECLARATION_VERIFICATION_LEVELS = ['unverified', 'reviewer_verified'] as const;
export type DeclarationVerificationLevel = (typeof DECLARATION_VERIFICATION_LEVELS)[number];

export const regionDeclarationRequestSchema = z
  .object({
    declared_region: regionCodeSchema,
    /** An opaque reference to verification evidence held elsewhere — never a
     *  raw document (data minimization; the privacy boundary applies). */
    evidence_ref: z.string().min(1).max(256).optional(),
  })
  .strict();
export type RegionDeclarationRequest = z.infer<typeof regionDeclarationRequestSchema>;

export const regionDeclarationViewSchema = z
  .object({
    declared_region: regionCodeSchema,
    status: z.enum(DECLARATION_STATUSES),
    verification_level: z.enum(DECLARATION_VERIFICATION_LEVELS),
    verified_at: isoTimestampSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type RegionDeclarationView = z.infer<typeof regionDeclarationViewSchema>;

export const regionResolutionResponseSchema = z
  .object({
    region: regionCodeSchema.nullable(),
    basis: regionResolutionBasisSchema,
    declaration: regionDeclarationViewSchema.nullable(),
  })
  .strict();
export type RegionResolutionResponse = z.infer<typeof regionResolutionResponseSchema>;

/** Admin (WS-N.1.1f): the compliance reviewer verifies/rejects a pending
 *  declaration after reviewing the referenced evidence. */
export const declarationVerifyRequestSchema = z
  .object({
    decision: z.enum(['verify', 'reject']),
    note: z.string().min(1).max(2000),
  })
  .strict();
export type DeclarationVerifyRequest = z.infer<typeof declarationVerifyRequestSchema>;

// ---------------------------------------------------------------------------
// Consumer risk disclosures (WS-N.1.2d) — versioned, localized, acknowledged.
// ---------------------------------------------------------------------------

export const disclosureVersionSchema = z
  .object({
    disclosure_id: z.string().min(1).max(64),
    region: regionCodeSchema,
    version: z.number().int().min(1),
    locale: z.string().min(2).max(35),
    title: z.string().min(1).max(200),
    content_md: z.string().min(1).max(100_000),
    requires_acknowledgment: z.boolean(),
    published_at: isoTimestampSchema,
  })
  .strict();
export type DisclosureVersion = z.infer<typeof disclosureVersionSchema>;

export const disclosureListResponseSchema = z
  .object({
    disclosures: z.array(
      disclosureVersionSchema
        .extend({
          acknowledged: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type DisclosureListResponse = z.infer<typeof disclosureListResponseSchema>;

export const disclosureAcknowledgeRequestSchema = z
  .object({
    disclosure_id: z.string().min(1).max(64),
    version: z.number().int().min(1),
  })
  .strict();
export type DisclosureAcknowledgeRequest = z.infer<typeof disclosureAcknowledgeRequestSchema>;

// ---------------------------------------------------------------------------
// Admin: jurisdiction policies (WS-N.1.1e) — compliance-role gated.
// ---------------------------------------------------------------------------

export const policyCreateRequestSchema = jurisdictionFeaturePolicySchema
  .omit({ policy_id: true })
  .extend({
    /** Required reason for the audit chain (WS-N.1.1g). */
    reason: z.string().min(1).max(1000),
    /** Counsel four-eyes approval ref — REQUIRED when any cell is `enabled`
     *  (relative to nothing: enabling is the dangerous direction). */
    approval_ref: z.string().min(1).max(256).optional(),
  })
  .strict();
export type PolicyCreateRequest = z.infer<typeof policyCreateRequestSchema>;

export const policyListResponseSchema = z
  .object({
    policies: z.array(jurisdictionFeaturePolicySchema),
  })
  .strict();
export type PolicyListResponse = z.infer<typeof policyListResponseSchema>;

// ---------------------------------------------------------------------------
// Admin: cases + fraud queue (WS-N.2.1c / WS-N.2.2c) — compliance-role gated.
// The reviewer view is transaction-derived ONLY (WS-N.2.2d).
// ---------------------------------------------------------------------------

export const caseCreateRequestSchema = z
  .object({
    subject_kind: z.enum(CASE_SUBJECT_KINDS),
    user_id_or_room_id: z.string().min(1).max(128),
    trigger_type: caseTriggerTypeSchema,
    risk_level: caseRiskLevelSchema,
    note: z.string().min(1).max(4000),
    partner_case_ref: z.string().min(1).max(256).optional(),
  })
  .strict();
export type CaseCreateRequest = z.infer<typeof caseCreateRequestSchema>;

export const caseAssignRequestSchema = z.object({ assignee_user_id: uuidSchema }).strict();
export const caseResolveRequestSchema = z
  .object({
    outcome: z.enum(CASE_RESOLUTION_OUTCOMES),
    notes: z.string().min(1).max(4000),
  })
  .strict();
export const caseReasonRequestSchema = z.object({ reason: z.string().min(1).max(4000) }).strict();
export const caseNoteRequestSchema = z.object({ note: z.string().min(1).max(4000) }).strict();

export const caseListResponseSchema = z
  .object({
    cases: z.array(financialComplianceCaseSchema),
  })
  .strict();
export type CaseListResponse = z.infer<typeof caseListResponseSchema>;

/** One fraud-queue row: the case plus its linked payment intent (when any). */
export const fraudQueueItemSchema = z
  .object({
    case: financialComplianceCaseSchema,
    payment_intent_id: uuidSchema.nullable(),
    payment_compliance_state: z.enum(['pending', 'cleared', 'flagged', 'blocked']).nullable(),
    sla_due_at: isoTimestampSchema,
  })
  .strict();
export const fraudQueueResponseSchema = z.object({ items: z.array(fraudQueueItemSchema) }).strict();
export type FraudQueueResponse = z.infer<typeof fraudQueueResponseSchema>;

export const intentReviewRequestSchema = z
  .object({
    payment_intent_id: uuidSchema,
    reason: z.string().min(1).max(2000),
  })
  .strict();
export type IntentReviewRequest = z.infer<typeof intentReviewRequestSchema>;

// ---------------------------------------------------------------------------
// SAR/STR (WS-N.2.1e) — counsel-only, READ included (anti-tipping-off).
// ---------------------------------------------------------------------------

export const SAR_STATUSES = ['draft', 'approved', 'filed'] as const;
export type SarStatus = (typeof SAR_STATUSES)[number];

export const sarReportSchema = z
  .object({
    sar_id: uuidSchema,
    case_id: uuidSchema,
    jurisdiction: regionCodeSchema,
    status: z.enum(SAR_STATUSES),
    /** Assembled from case/transaction data only — never attention data. */
    narrative: z.string().min(1).max(20_000),
    filing_ref: z.string().min(1).max(256).nullable(),
    filed_at: isoTimestampSchema.nullable(),
    partner_filed: z.boolean(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type SarReport = z.infer<typeof sarReportSchema>;

export const sarCreateRequestSchema = z
  .object({
    jurisdiction: regionCodeSchema,
    narrative: z.string().min(1).max(20_000),
  })
  .strict();
export const sarFileRequestSchema = z
  .object({
    filing_ref: z.string().min(1).max(256),
    partner_filed: z.boolean(),
  })
  .strict();
export const sarListResponseSchema = z.object({ reports: z.array(sarReportSchema) }).strict();

// ---------------------------------------------------------------------------
// Lawful-access requests (WS-N.2.3d) — counsel-gated intake/review/production.
// ---------------------------------------------------------------------------

export const LAWFUL_ACCESS_BASES = ['warrant', 'subpoena', 'court_order', 'emergency'] as const;
export type LawfulAccessBasis = (typeof LAWFUL_ACCESS_BASES)[number];

export const LAWFUL_ACCESS_STATUSES = [
  'received',
  'under_review',
  'approved',
  'denied',
  'produced',
] as const;
export type LawfulAccessStatus = (typeof LAWFUL_ACCESS_STATUSES)[number];

export const lawfulAccessScopeSchema = z
  .object({
    subject_kind: z.enum(['user', 'room', 'transaction']),
    subject_ref: z.string().min(1).max(128),
    time_range_start: isoTimestampSchema.nullable(),
    time_range_end: isoTimestampSchema.nullable(),
  })
  .strict();

export const lawfulAccessRequestSchema = z
  .object({
    request_id: uuidSchema,
    agency: z.string().min(1).max(200),
    jurisdiction: regionCodeSchema,
    legal_basis: z.enum(LAWFUL_ACCESS_BASES),
    scope: lawfulAccessScopeSchema,
    contact: z.string().min(1).max(500),
    status: z.enum(LAWFUL_ACCESS_STATUSES),
    /** What was actually produced (structured summary; scoped, never over-produced).
     *  For `private_p2p` scopes this records the honest non-production
     *  determination (server non-storage contract, PRIVATE_SPEC §8/§11.4). */
    production_summary: z.string().min(1).max(10_000).nullable(),
    user_notified_at: isoTimestampSchema.nullable(),
    case_id: uuidSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type LawfulAccessRequest = z.infer<typeof lawfulAccessRequestSchema>;

export const lawfulAccessCreateRequestSchema = lawfulAccessRequestSchema
  .pick({ agency: true, jurisdiction: true, legal_basis: true, scope: true, contact: true })
  .strict();
export const lawfulAccessReviewRequestSchema = z
  .object({
    decision: z.enum(['approved', 'denied']),
    note: z.string().min(1).max(4000),
  })
  .strict();
export const lawfulAccessProduceRequestSchema = z
  .object({
    production_summary: z.string().min(1).max(10_000),
    user_notified: z.boolean(),
  })
  .strict();
export const lawfulAccessListResponseSchema = z
  .object({ requests: z.array(lawfulAccessRequestSchema) })
  .strict();

// ---------------------------------------------------------------------------
// Wallet-risk pins (WS-N.2.2e / WS-N.2.3b) — the compromise response.
// ---------------------------------------------------------------------------

export const walletPinRequestSchema = z.object({ reason: z.string().min(1).max(2000) }).strict();
export type WalletPinRequest = z.infer<typeof walletPinRequestSchema>;
