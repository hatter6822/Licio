// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N — the `compliance` bounded context (SPEC §22.2, §17.10, §21.5;
// docs/planning/15-compliance.md): jurisdiction feature policies + their
// hash-chained change audit (WS-N.1.1a/g), financial-compliance cases + their
// per-case hash-chained review trail (WS-N.2.1a/c), identity-free region
// declarations (WS-N.1.1f), versioned consumer risk disclosures +
// acknowledgments (WS-N.1.2d), wallet-risk pins (WS-N.2.2e), SAR/STR records
// (WS-N.2.1e, counsel-only), and lawful-access requests (WS-N.2.3d).
//
// Isolation (WS-D.3.2 / WS-N.2.2d): every table here is classified in
// `packages/db/src/isolation.ts` and seeds the pay-to-rank BFS proof — no
// FK/view join path may connect compliance state to ranking/attention tables.
// Room/wallet/intent references are SOFT (bare uuid/text, no FK); the only
// hard outward FKs point at `public.users` (the articulation node).
//
// Erasure posture: chained audit rows store NON-REVERSIBLE actor refs (never
// a user id), so right-to-erasure never mutates a hashed column and the
// chains verify forever (WS-N.1.1g).  Case subjects (`user_id_or_room_id`)
// are scrubbed by the WS-D deletion sweep UNLESS a legal hold / counsel
// retention window applies (WS-N.2.1a/d — the legal-obligation carve-out).
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const complianceSchema = pgSchema('compliance');

const tz = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Enums (closed vocabularies; the JSONB sub-shapes are zod-validated in
// @licio/shared schemas/jurisdiction.ts + compliance-api.ts).
// ---------------------------------------------------------------------------

export const caseTriggerTypeEnum = complianceSchema.enum('case_trigger_type', [
  'velocity',
  'pattern',
  'sanctions',
  'manual',
  'fraud',
  'scam',
  'impersonation',
  'bribery',
  'coercion',
]);

export const caseRiskLevelEnum = complianceSchema.enum('case_risk_level', [
  'low',
  'medium',
  'high',
  'critical',
]);

export const caseReviewStateEnum = complianceSchema.enum('case_review_state', [
  'open',
  'assigned',
  'investigating',
  'resolved',
  'escalated',
]);

export const caseSubjectKindEnum = complianceSchema.enum('case_subject_kind', [
  'user',
  'room',
  'address',
  'transaction',
]);

export const declarationStatusEnum = complianceSchema.enum('region_declaration_status', [
  'pending',
  'verified',
  'revoked',
]);

export const declarationVerificationEnum = complianceSchema.enum(
  'region_declaration_verification',
  ['unverified', 'reviewer_verified'],
);

export const sarStatusEnum = complianceSchema.enum('sar_status', ['draft', 'approved', 'filed']);

export const lawfulAccessBasisEnum = complianceSchema.enum('lawful_access_basis', [
  'warrant',
  'subpoena',
  'court_order',
  'emergency',
]);

export const lawfulAccessStatusEnum = complianceSchema.enum('lawful_access_status', [
  'received',
  'under_review',
  'approved',
  'denied',
  'produced',
]);

// ---------------------------------------------------------------------------
// WS-N.1.1a — JurisdictionFeaturePolicy (SPEC §22.2 field list, exactly).
// Versioned by (country_or_region, effective_at); the engine reads the latest
// row with effective_at <= now.  JSONB sub-shapes are validated by
// `validatePolicy` on every write; a nonconforming row is treated as ABSENT
// by the engine (fail-closed), never partially honored.
// ---------------------------------------------------------------------------

export const jurisdictionFeaturePolicies = complianceSchema.table(
  'jurisdiction_feature_policy',
  {
    policyId: uuid('policy_id').primaryKey().defaultRandom(),
    /** ISO 3166-1 alpha-2, sub-national (`US-CA`), or matrix grouping key. */
    countryOrRegion: text('country_or_region').notNull(),
    /** { [cryptoFeatureCell]: the closed six-value matrix vocabulary }. */
    featureFlags: jsonb('feature_flags').notNull(),
    assetFlags: jsonb('asset_flags').notNull().default({}),
    /** Band-based (§19.4): { [cell]: { required_band: 'adult', assurance? } }. */
    ageGatePolicy: jsonb('age_gate_policy').notNull(),
    kycPolicy: jsonb('kyc_policy').notNull().default({}),
    disclosureRefs: jsonb('disclosure_refs').notNull().default([]),
    /** Null until legal sign-off is recorded; an `enabled` cell REQUIRES it. */
    legalApprovalRef: text('legal_approval_ref'),
    effectiveAt: tz('effective_at').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('jfp_region_effective_uq').on(t.countryOrRegion, t.effectiveAt),
    index('jfp_region_idx').on(t.countryOrRegion),
  ],
);

// ---------------------------------------------------------------------------
// WS-N.1.1g — the append-only, hash-chained policy change audit.  ONE global
// chain: `chain_key` is a CHECK-pinned constant so the fork-proof partial
// uniques (one child per parent, one genesis) have a column to key on —
// exactly the `governance_audit_log` pattern with the room replaced by the
// constant.  `changed_by_ref` is a NON-REVERSIBLE account ref: erasure never
// mutates a hashed column, so the chain verifies forever.
// ---------------------------------------------------------------------------

export const jurisdictionPolicyAudits = complianceSchema.table(
  'jurisdiction_policy_audit',
  {
    changeId: uuid('change_id').primaryKey().defaultRandom(),
    chainKey: text('chain_key').notNull().default('jurisdiction-policy'),
    policyId: uuid('policy_id').notNull(),
    countryOrRegion: text('country_or_region').notNull(),
    changeType: text('change_type').notNull(),
    changedByRef: text('changed_by_ref').notNull(),
    previousValue: jsonb('previous_value'),
    newValue: jsonb('new_value').notNull(),
    reason: text('reason').notNull(),
    approvalRef: text('approval_ref'),
    prevHash: text('prev_hash'),
    integrityHash: text('integrity_hash').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('jpa_chain_parent_uq')
      .on(t.chainKey, t.prevHash)
      .where(sql`${t.prevHash} IS NOT NULL`),
    uniqueIndex('jpa_chain_genesis_uq').on(t.chainKey).where(sql`${t.prevHash} IS NULL`),
    index('jpa_policy_idx').on(t.policyId),
  ],
);

// ---------------------------------------------------------------------------
// WS-N.2.1a — FinancialComplianceCase (SPEC §22.2 field list + subject_kind
// and assignment).  `user_id_or_room_id` is a polymorphic SOFT ref (no FK);
// null after a right-to-erasure scrub of a user subject (legal holds skip the
// scrub — the audited carve-out).  `assigned_to` is a reviewer FK (SET NULL).
// ---------------------------------------------------------------------------

export const financialComplianceCases = complianceSchema.table(
  'financial_compliance_case',
  {
    caseId: uuid('case_id').primaryKey().defaultRandom(),
    userIdOrRoomId: text('user_id_or_room_id'),
    subjectKind: caseSubjectKindEnum('subject_kind').notNull(),
    triggerType: caseTriggerTypeEnum('trigger_type').notNull(),
    riskLevel: caseRiskLevelEnum('risk_level').notNull(),
    partnerCaseRef: text('partner_case_ref'),
    reviewState: caseReviewStateEnum('review_state').notNull().default('open'),
    assignedTo: uuid('assigned_to').references(() => users.userId, { onDelete: 'set null' }),
    resolution: jsonb('resolution'),
    retentionPolicy: jsonb('retention_policy').notNull(),
    /** Trigger-scoped dedup key: the same incident never opens two cases. */
    idempotencyKey: text('idempotency_key'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('fcc_review_state_idx').on(t.reviewState),
    index('fcc_trigger_idx').on(t.triggerType),
    index('fcc_subject_created_idx').on(t.userIdOrRoomId, t.createdAt),
    uniqueIndex('fcc_idempotency_uq')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// WS-N.2.1c — the per-case append-only, hash-chained review trail (assign /
// begin / resolve / escalate / reopen / note / retention actions).  Chain per
// case (fork-proof partial uniques); actor stored as a non-reversible ref.
// UPDATE is always rejected; DELETE only via the sanctioned retention GUC
// (`licio.compliance_retention`) so "deletion is thorough" (WS-N.2.1d) while
// casual tampering stays impossible.
// ---------------------------------------------------------------------------

export const complianceCaseAudits = complianceSchema.table(
  'compliance_case_audit',
  {
    auditId: uuid('audit_id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => financialComplianceCases.caseId),
    action: text('action').notNull(),
    actorRef: text('actor_ref').notNull(),
    beforeState: text('before_state'),
    afterState: text('after_state'),
    note: text('note'),
    prevHash: text('prev_hash'),
    integrityHash: text('integrity_hash').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cca_chain_parent_uq')
      .on(t.caseId, t.prevHash)
      .where(sql`${t.prevHash} IS NOT NULL`),
    uniqueIndex('cca_chain_genesis_uq').on(t.caseId).where(sql`${t.prevHash} IS NULL`),
    index('cca_case_idx').on(t.caseId),
  ],
);

// ---------------------------------------------------------------------------
// WS-N.1.1f — the identity-free region declaration (the PRIMARY region basis;
// §19.1: never geolocation).  One row per user; deleted with the account
// (CASCADE — a declaration is the user's own personal data, no retention
// obligation attaches to it).  Verification is policy-scaled: an unverified
// declaration is never a resolution basis (fail-closed).
// ---------------------------------------------------------------------------

export const regionDeclarations = complianceSchema.table('region_declaration', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.userId, { onDelete: 'cascade' }),
  declaredRegion: text('declared_region').notNull(),
  status: declarationStatusEnum('status').notNull().default('pending'),
  verificationLevel: declarationVerificationEnum('verification_level')
    .notNull()
    .default('unverified'),
  /** Opaque evidence reference — never a raw document (data minimization). */
  evidenceRef: text('evidence_ref'),
  verifiedAt: tz('verified_at'),
  verifiedBy: uuid('verified_by').references(() => users.userId, { onDelete: 'set null' }),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// WS-N.1.2d — versioned consumer risk disclosures (publish-immutable: a new
// version is a new row; UPDATE/DELETE are trigger-rejected) and the audited
// acknowledgment records (append-only; the user ref NULLs on erasure — the
// consent evidence survives anonymized, per the counsel retention schedule).
// ---------------------------------------------------------------------------

export const disclosureVersions = complianceSchema.table(
  'disclosure_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    disclosureId: text('disclosure_id').notNull(),
    region: text('region').notNull(),
    version: integer('version').notNull(),
    locale: text('locale').notNull(),
    title: text('title').notNull(),
    contentMd: text('content_md').notNull(),
    requiresAcknowledgment: boolean('requires_acknowledgment').notNull().default(true),
    publishedAt: tz('published_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dv_identity_uq').on(t.disclosureId, t.region, t.version, t.locale),
    index('dv_region_idx').on(t.region),
  ],
);

export const disclosureAcknowledgments = complianceSchema.table(
  'disclosure_acknowledgment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NULL after a right-to-erasure scrub (anonymized consent evidence). */
    userId: uuid('user_id').references(() => users.userId, { onDelete: 'set null' }),
    disclosureId: text('disclosure_id').notNull(),
    version: integer('version').notNull(),
    region: text('region').notNull(),
    acknowledgedAt: tz('acknowledged_at').notNull().defaultNow(),
  },
  (t) => [
    // Region is part of the key: the same (disclosure_id, version) carries
    // DIFFERENT counsel-authored text per region, so an acknowledgment is only
    // evidence for the region it was given in — one ack per user per version
    // per region, and the gate asks per region (WS-N.1.2d).
    uniqueIndex('da_user_version_uq')
      .on(t.userId, t.disclosureId, t.version, t.region)
      .where(sql`${t.userId} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// WS-N.2.2e / WS-N.2.3b — wallet-risk pins (the compromise response).  At most
// one ACTIVE pin per wallet (partial unique); released pins survive as audit.
// The wallet id is a SOFT ref (the wallet row lives in the `wallet` schema and
// is purged on account deletion; pins are purged alongside by the sweep).
// ---------------------------------------------------------------------------

export const walletRiskPins = complianceSchema.table(
  'wallet_risk_pin',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletAccountId: uuid('wallet_account_id').notNull(),
    reason: text('reason').notNull(),
    pinnedByRef: text('pinned_by_ref').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    releasedAt: tz('released_at'),
    releasedByRef: text('released_by_ref'),
  },
  (t) => [uniqueIndex('wrp_active_uq').on(t.walletAccountId).where(sql`${t.releasedAt} IS NULL`)],
);

// ---------------------------------------------------------------------------
// WS-N.2.1e — SAR/STR records.  Counsel-only (READ included — anti-tipping-
// off); the case FK is RESTRICT-by-default, so a case with a SAR can never be
// retention-deleted while the report exists (the legal hold, enforced twice).
// Actor refs are non-reversible.
// ---------------------------------------------------------------------------

export const sarReports = complianceSchema.table(
  'sar_report',
  {
    sarId: uuid('sar_id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => financialComplianceCases.caseId),
    jurisdiction: text('jurisdiction').notNull(),
    status: sarStatusEnum('status').notNull().default('draft'),
    narrative: text('narrative').notNull(),
    filingRef: text('filing_ref'),
    filedAt: tz('filed_at'),
    partnerFiled: boolean('partner_filed').notNull().default(false),
    createdByRef: text('created_by_ref').notNull(),
    approvedByRef: text('approved_by_ref'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('sar_case_idx').on(t.caseId)],
);

// ---------------------------------------------------------------------------
// WS-N.2.3d — lawful-access requests: structured intake, mandatory counsel
// review, scoped production log, and the honest-limits determination for
// `private_p2p` scopes (the server can only produce what it holds).
// ---------------------------------------------------------------------------

export const lawfulAccessRequests = complianceSchema.table(
  'lawful_access_request',
  {
    requestId: uuid('request_id').primaryKey().defaultRandom(),
    agency: text('agency').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    legalBasis: lawfulAccessBasisEnum('legal_basis').notNull(),
    scope: jsonb('scope').notNull(),
    contact: text('contact').notNull(),
    status: lawfulAccessStatusEnum('status').notNull().default('received'),
    reviewNote: text('review_note'),
    reviewedByRef: text('reviewed_by_ref'),
    productionSummary: text('production_summary'),
    userNotifiedAt: tz('user_notified_at'),
    caseId: uuid('case_id').references(() => financialComplianceCases.caseId, {
      onDelete: 'set null',
    }),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('lar_status_idx').on(t.status)],
);
