// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2 moderation-console wire contracts (SPEC §18.2/§18.3, §16.4, §25.4):
// the report queue + filters (WS-J.2.1), the full-context review panel with
// user history / invariant signals / side-by-side diff (WS-J.2.2), the action
// palette + revert (WS-J.2.3), the appeal review interface (WS-J.2.4), and the
// audit log viewer + transparency export (WS-J.2.5).
//
// Two invariants are STRUCTURAL here, not merely convention:
//   • No financial field exists on the user-history projection (the
//     ranking-neutrality "no financial data in moderation" rule; SPEC §13.6).
//   • Reporter identity is carried only on the role-gated review projection,
//     never on the queue rows or any user-facing shape (SPEC §19.5).
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import {
  citationSchema,
  citationUrlSchema,
  contributionPublicSchema,
  contributionReasonCodeSchema,
  contributionTypeSchema,
  MAX_CITATIONS,
} from './contribution.js';
import {
  appealStatusSchema,
  reportCaseStatusSchema,
  reportContentKindSchema,
  reportRoutedToSchema,
  reportSeveritySchema,
  reportTargetTypeSchema,
} from './moderation-api.js';
import { appealDecisionSchema, stewardRoleIdSchema } from './steward-roles.js';

// ---------------------------------------------------------------------------
// The console action vocabulary (POST /v1/moderation/actions).
// ---------------------------------------------------------------------------

/**
 * The verbs the action palette accepts.  `warn|hide|remove|restrict|escalate|
 * clear` are the WS-J.2.3a content/account palette; `shadow|suspend|ban` are the
 * account-level safety actions (STEWARD_ROLES.md).
 */
export const CONSOLE_ACTIONS = [
  'warn',
  'hide',
  'remove',
  'restrict',
  'shadow',
  'suspend',
  'ban',
  'escalate',
  'clear',
] as const;
export const consoleActionSchema = z.enum(CONSOLE_ACTIONS);
export type ConsoleAction = z.infer<typeof consoleActionSchema>;

/** SLA urgency band derived from time-remaining (WS-J.2.1a highlight). */
export const slaStateSchema = z.enum(['ok', 'approaching', 'breached']);
export type SlaState = z.infer<typeof slaStateSchema>;

// ---------------------------------------------------------------------------
// Report queue (WS-J.2.1a) — one row per CASE (aggregated reports per target).
// ---------------------------------------------------------------------------

export const moderationCaseRowSchema = z
  .object({
    case_id: uuidSchema,
    target_type: reportTargetTypeSchema,
    // Nullable: a right-to-erasure purge scrubs an `account` target's UUID.
    target_id: uuidSchema.nullable(),
    content_kind: reportContentKindSchema.nullable(),
    /** Distinct reason codes across the aggregated reports. */
    reason_codes: z.array(contributionReasonCodeSchema).min(1),
    severity: reportSeveritySchema,
    status: reportCaseStatusSchema,
    routed_to: reportRoutedToSchema,
    /** Number of reports aggregated against this target. */
    report_count: z.number().int().min(1),
    /** Assigned reviewer handle, or null when unassigned. */
    assigned_to_handle: z.string().min(1).nullable(),
    assigned_to_id: uuidSchema.nullable(),
    /** Truncated content preview (never reporter identity). */
    preview: z.string().max(280).nullable(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    sla_due_at: isoTimestampSchema,
    sla_state: slaStateSchema,
  })
  .strict();
export type ModerationCaseRow = z.infer<typeof moderationCaseRowSchema>;

export const reportQueueResponseSchema = z
  .object({
    /** The emergency section, always sorted on top (WS-J.2.1a). */
    emergency: z.array(moderationCaseRowSchema),
    /** The standard, priority-sorted section. */
    standard: z.array(moderationCaseRowSchema),
    next_cursor: z.string().min(1).max(512).nullable(),
    /** Count matching the active filter (WS-J.2.1b). */
    filtered_total: z.number().int().min(0),
  })
  .strict();
export type ReportQueueResponse = z.infer<typeof reportQueueResponseSchema>;

/** A repeatable query filter arrives as a SCALAR for a single value
 *  (`?severity=moderate`) or an ARRAY for repeats
 *  (`?severity=moderate&severity=severe`).  Normalize a lone scalar into a
 *  one-element array so both URL forms satisfy the array filter — otherwise a
 *  single-value filter (the common case) fails validation. */
const arrayQueryParam = <T extends z.ZodTypeAny>(item: T) =>
  z
    .preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]), z.array(item))
    .optional();

/** Report-queue filter query (WS-J.2.1b; combinable AND filters). */
export const reportQueueFilterSchema = z
  .object({
    severity: arrayQueryParam(reportSeveritySchema),
    status: arrayQueryParam(reportCaseStatusSchema),
    category: arrayQueryParam(z.string().min(1).max(32)),
    created_after: isoTimestampSchema.optional(),
    created_before: isoTimestampSchema.optional(),
    /** User ids (the queue predicates compare UUID columns: `subject_user_id` /
     *  `reporter_user_id`).  Role-gated: only roles permitted to see reporter
     *  identity may filter by `reporter`. */
    reporter: uuidSchema.optional(),
    target_user: uuidSchema.optional(),
    assignment: z.enum(['unassigned', 'mine', 'reviewer']).optional(),
    assignee_id: uuidSchema.optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type ReportQueueFilter = z.infer<typeof reportQueueFilterSchema>;

// ---------------------------------------------------------------------------
// Full-context review panel (WS-J.2.2a/b/c/d).
// ---------------------------------------------------------------------------

/** One report inside a case, as seen by an authorized reviewer (WS-J.2.2a). */
export const caseReportDetailSchema = z
  .object({
    report_id: uuidSchema,
    reason_code: contributionReasonCodeSchema,
    context: z.string().max(500).nullable(),
    evidence_urls: z.array(z.string().max(2048)),
    created_at: isoTimestampSchema,
    /** Reporter handle — present ONLY for roles authorized to see it; else null
     *  (reporter-identity protection, SPEC §19.5). */
    reporter_handle: z.string().min(1).nullable(),
  })
  .strict();
export type CaseReportDetail = z.infer<typeof caseReportDetailSchema>;

/** Past moderation action against the reviewed user (WS-J.2.2b). */
export const userHistoryActionSchema = z
  .object({
    action_id: uuidSchema,
    action: z.string().min(1).max(40),
    reason_code: contributionReasonCodeSchema.nullable(),
    created_at: isoTimestampSchema,
    reverted: z.boolean(),
  })
  .strict();
export type UserHistoryAction = z.infer<typeof userHistoryActionSchema>;

/**
 * The user-history sidebar (WS-J.2.2b).  There is NO wallet/payment/treasury/
 * donor field by construction (ranking neutrality, SPEC §13.6) — the rule is
 * enforced by the absence of the field, not by hiding it.
 */
export const userHistorySchema = z
  .object({
    user_id: uuidSchema.nullable(),
    account_age_days: z.number().int().min(0).nullable(),
    /** Reports filed against this user, grouped by reason category, with the
     *  outcome distribution — counts only, never reporter identities. */
    reports_by_category: z.record(z.string(), z.number().int().min(0)),
    past_actions: z.array(userHistoryActionSchema),
    /** Bounded internal contribution stats (never a public score, SPEC §5.16). */
    contribution_count: z.number().int().min(0),
    contribution_types: z.record(z.string(), z.number().int().min(0)),
    rooms_active_in: z.number().int().min(0),
  })
  .strict();
export type UserHistory = z.infer<typeof userHistorySchema>;

/** One invariant decision-support signal (WS-J.2.2c) — informational only. */
export const invariantSignalSchema = z
  .object({
    /** False ⇒ the invariant is unavailable (cold start / outage): show an
     *  explicit "signal unavailable", never a misleading zero. */
    available: z.boolean(),
    /** Plain-language state label (e.g. SCOI "weaponized"); null if unavailable. */
    state: z.string().min(1).max(40).nullable(),
    /** Optional elaboration (e.g. the coordination-pattern summary). */
    detail: z.string().max(500).nullable(),
  })
  .strict();
export type InvariantSignal = z.infer<typeof invariantSignalSchema>;

export const invariantSignalsPanelSchema = z
  .object({
    mfci: invariantSignalSchema,
    scoi: invariantSignalSchema,
    phi: invariantSignalSchema,
    hodge: invariantSignalSchema,
    /** Always present: "These signals inform review but do not determine outcomes." */
    disclaimer: z.string().min(1).max(200),
  })
  .strict();
export type InvariantSignalsPanel = z.infer<typeof invariantSignalsPanelSchema>;

/** Side-by-side edit diff (WS-J.2.2d) — present only for edited content. */
export const sideBySideViewSchema = z
  .object({
    /** Report-time snapshot (the original offending text). */
    original_body: z.string().max(5000),
    /** Current body (empty if the content was since removed → tombstone right). */
    current_body: z.string().max(5000),
    original_at: isoTimestampSchema,
    current_at: isoTimestampSchema,
    /** True when an edit happened AFTER the report (edit-to-evade signal). */
    edited_after_report: z.boolean(),
  })
  .strict();
export type SideBySideView = z.infer<typeof sideBySideViewSchema>;

export const caseReviewResponseSchema = z
  .object({
    case_id: uuidSchema,
    target_type: reportTargetTypeSchema,
    // Nullable: a right-to-erasure purge scrubs an `account` target's UUID.
    target_id: uuidSchema.nullable(),
    content_kind: reportContentKindSchema.nullable(),
    status: reportCaseStatusSchema,
    severity: reportSeveritySchema,
    routed_to: reportRoutedToSchema,
    assigned_to_id: uuidSchema.nullable(),
    reports: z.array(caseReportDetailSchema),
    /** Thread context centered on the reported item (WS-J.2.2a); empty for
     *  account/room targets. The reported item carries `is_author=false` and is
     *  marked separately by `reported_contribution_id`. */
    thread_context: z.array(contributionPublicSchema),
    reported_contribution_id: uuidSchema.nullable(),
    /** Preserved report-time snapshot when the live content is gone (tombstone). */
    snapshot_body: z.string().max(5000).nullable(),
    user_history: userHistorySchema,
    invariant_signals: invariantSignalsPanelSchema,
    side_by_side: sideBySideViewSchema.nullable(),
    /** The console actions the requesting reviewer's role may take here. */
    available_actions: z.array(consoleActionSchema),
  })
  .strict();
export type CaseReviewResponse = z.infer<typeof caseReviewResponseSchema>;

// ---------------------------------------------------------------------------
// Action palette + revert (WS-J.2.3a/b).
// ---------------------------------------------------------------------------

export const moderationActionRequestSchema = z
  .object({
    // `room` is accepted so a reviewer can clear/escalate a room report case
    // (POST /v1/reports accepts room targets); enforcement verbs on a room are
    // rejected server-side until room-level enforcement ships (WS-J residual).
    target_type: z.enum(['content', 'account', 'room']),
    target_id: uuidSchema,
    action: consoleActionSchema,
    reason_code: contributionReasonCodeSchema,
    /** ISO-8601 duration-ish window for restrict/suspend (e.g. "7d"); free text
     *  bounded, interpreted server-side. */
    duration: z.string().min(1).max(16).optional(),
    /** Internal note — never shown to the user. */
    reviewer_note: z.string().max(2000).optional(),
    /** Reports this action resolves (move to resolved). */
    report_ids: z.array(uuidSchema).max(500).optional(),
    /** The case this action resolves (optional convenience). */
    case_id: uuidSchema.optional(),
  })
  .strict();
export type ModerationActionRequest = z.infer<typeof moderationActionRequestSchema>;

export const moderationActionResponseSchema = z
  .object({
    action_id: uuidSchema,
    action: consoleActionSchema,
    reversible: z.boolean(),
    notice_sent: z.boolean(),
    appealable: z.boolean(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type ModerationActionResponse = z.infer<typeof moderationActionResponseSchema>;

export const revertActionRequestSchema = z
  .object({
    reason_code: contributionReasonCodeSchema,
    reviewer_note: z.string().max(2000).optional(),
  })
  .strict();
export type RevertActionRequest = z.infer<typeof revertActionRequestSchema>;

export const revertActionResponseSchema = z
  .object({
    revert_action_id: uuidSchema,
    reverted_action_id: uuidSchema,
    notice_sent: z.boolean(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type RevertActionResponse = z.infer<typeof revertActionResponseSchema>;

// ---------------------------------------------------------------------------
// Assignment + reviewer availability (WS-J.2.1d).
// ---------------------------------------------------------------------------

export const assignCaseRequestSchema = z
  .object({ reviewer_id: uuidSchema, reason: z.string().max(280).optional() })
  .strict();
export type AssignCaseRequest = z.infer<typeof assignCaseRequestSchema>;

export const REVIEWER_AVAILABILITY = ['available', 'busy', 'offline'] as const;
export const reviewerAvailabilitySchema = z.enum(REVIEWER_AVAILABILITY);
export type ReviewerAvailability = z.infer<typeof reviewerAvailabilitySchema>;

export const reviewerStatusRequestSchema = z
  .object({ status: reviewerAvailabilitySchema })
  .strict();
export type ReviewerStatusRequest = z.infer<typeof reviewerStatusRequestSchema>;

// ---------------------------------------------------------------------------
// Bulk actions (WS-J.2.1c) — per-item audit + reversible.
// ---------------------------------------------------------------------------

export const bulkActionRequestSchema = z
  .object({
    case_ids: z.array(uuidSchema).min(1).max(100),
    action: z.enum(['dismiss', 'remove', 'assign']),
    reason_code: contributionReasonCodeSchema,
    reviewer_id: uuidSchema.optional(),
  })
  .strict();
export type BulkActionRequest = z.infer<typeof bulkActionRequestSchema>;

export const bulkActionResultSchema = z
  .object({
    case_id: uuidSchema,
    ok: z.boolean(),
    error: z.string().max(120).nullable(),
  })
  .strict();
export const bulkActionResponseSchema = z
  .object({ results: z.array(bulkActionResultSchema) })
  .strict();
export type BulkActionResponse = z.infer<typeof bulkActionResponseSchema>;

// ---------------------------------------------------------------------------
// Appeal queue + review + decision (WS-J.1.3c, WS-J.2.4a, WS-J.1.3d).
// ---------------------------------------------------------------------------

export const appealQueueRowSchema = z
  .object({
    appeal_id: uuidSchema,
    action_id: uuidSchema,
    original_action: z.string().min(1).max(40),
    original_reason_code: contributionReasonCodeSchema.nullable(),
    status: appealStatusSchema,
    /** True ⇒ a ban appeal (24h SLA, visually distinguished from 72h standard). */
    is_ban_appeal: z.boolean(),
    assigned_to_id: uuidSchema.nullable(),
    created_at: isoTimestampSchema,
    sla_due_at: isoTimestampSchema,
    sla_state: slaStateSchema,
  })
  .strict();
export type AppealQueueRow = z.infer<typeof appealQueueRowSchema>;

export const appealQueueResponseSchema = z
  .object({
    items: z.array(appealQueueRowSchema),
    next_cursor: z.string().min(1).max(512).nullable(),
    filtered_total: z.number().int().min(0),
  })
  .strict();
export type AppealQueueResponse = z.infer<typeof appealQueueResponseSchema>;

export const appealReviewResponseSchema = z
  .object({
    appeal_id: uuidSchema,
    action_id: uuidSchema,
    status: appealStatusSchema,
    original_action: z.string().min(1).max(40),
    original_reason_code: contributionReasonCodeSchema.nullable(),
    /** The original decision-maker (independence display); never assignable to
     *  the appeal (WS-J.1.3c). */
    original_reviewer_handle: z.string().min(1).nullable(),
    original_created_at: isoTimestampSchema,
    appellant_statement: z.string().max(2000),
    new_evidence: z.array(z.string().max(2048)),
    target_type: reportTargetTypeSchema,
    // Nullable: a right-to-erasure purge scrubs an `account` target's UUID.
    target_id: uuidSchema.nullable(),
    snapshot_body: z.string().max(5000).nullable(),
    user_history: userHistorySchema,
    side_by_side: sideBySideViewSchema.nullable(),
  })
  .strict();
export type AppealReviewResponse = z.infer<typeof appealReviewResponseSchema>;

export const appealDecisionRequestSchema = z
  .object({
    decision: appealDecisionSchema,
    reason_code: contributionReasonCodeSchema,
    explanation: z.string().trim().min(1).max(2000),
    /** For `modify`: the new, less-severe action to apply. */
    modified_action: consoleActionSchema.optional(),
  })
  .strict();
export type AppealDecisionRequest = z.infer<typeof appealDecisionRequestSchema>;

export const appealDecisionResponseSchema = z
  .object({
    appeal_id: uuidSchema,
    status: appealStatusSchema,
    notice_sent: z.boolean(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type AppealDecisionResponse = z.infer<typeof appealDecisionResponseSchema>;

// ---------------------------------------------------------------------------
// Audit log viewer + transparency export (WS-J.2.5a/b).
// ---------------------------------------------------------------------------

export const auditRecordViewSchema = z
  .object({
    audit_id: uuidSchema,
    event_time: isoTimestampSchema,
    /** Actor handle, or null for `system` (automated blocks). */
    actor_handle: z.string().min(1).nullable(),
    actor_role: stewardRoleIdSchema.nullable(),
    action: z.string().min(1).max(40),
    reason_code: contributionReasonCodeSchema.nullable(),
    target_type: z.string().min(1).max(20),
    target_id: uuidSchema.nullable(),
    prior_state: z.string().max(40).nullable(),
    next_state: z.string().max(40).nullable(),
    reversible: z.boolean(),
    linked_action_id: uuidSchema.nullable(),
    report_ids: z.array(uuidSchema),
    co_approver_handle: z.string().min(1).nullable(),
    /** Internal note — visible to authorized roles only. */
    notes: z.string().max(2000).nullable(),
  })
  .strict();
export type AuditRecordView = z.infer<typeof auditRecordViewSchema>;

export const auditQuerySchema = z
  .object({
    actor_id: uuidSchema.optional(),
    target_user: uuidSchema.optional(),
    action: z.string().min(1).max(40).optional(),
    reason_code: contributionReasonCodeSchema.optional(),
    created_after: isoTimestampSchema.optional(),
    created_before: isoTimestampSchema.optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditListResponseSchema = z
  .object({
    items: z.array(auditRecordViewSchema),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type AuditListResponse = z.infer<typeof auditListResponseSchema>;

/** A transparency-export cell: a count, or null when small-cell suppressed. */
export const transparencyCellSchema = z
  .object({
    key: z.string().min(1).max(80),
    count: z.number().int().min(0).nullable(),
    suppressed: z.boolean(),
  })
  .strict();
export type TransparencyCell = z.infer<typeof transparencyCellSchema>;

export const auditExportResponseSchema = z
  .object({
    generated_at: isoTimestampSchema,
    period_start: isoTimestampSchema,
    period_end: isoTimestampSchema,
    /** Suppression threshold applied (cells below it are suppressed). */
    suppression_threshold: z.number().int().min(1),
    by_action: z.array(transparencyCellSchema),
    by_reason_code: z.array(transparencyCellSchema),
    by_severity: z.array(transparencyCellSchema),
    /** Total actions in the period (suppressed if below threshold). */
    total: transparencyCellSchema,
  })
  .strict();
export type AuditExportResponse = z.infer<typeof auditExportResponseSchema>;

// ---------------------------------------------------------------------------
// Evidence queue + decisions (STEWARD_ROLES.md ROLE_EVIDENCE; SPEC §16.3).
//
// The queue is the stream of citation-bearing contributions (sourced comments
// + corrections) awaiting an evidence steward's review.  A DECISION is
// evidence METADATA — never a content action (ROLE_EVIDENCE holds no
// content-removal power by doctrine): `mark-primary-source` and
// `flag-citation` annotate ONE citation; `clear` marks the contribution
// reviewed with no annotation.  Every decision is audited and reviewable.
// ---------------------------------------------------------------------------

export const EVIDENCE_DECISION_ACTIONS = ['mark-primary-source', 'flag-citation', 'clear'] as const;
export const evidenceDecisionActionSchema = z.enum(EVIDENCE_DECISION_ACTIONS);
export type EvidenceDecisionAction = z.infer<typeof evidenceDecisionActionSchema>;

export const evidenceQueueRowSchema = z
  .object({
    contribution_id: uuidSchema,
    thread_id: uuidSchema,
    story_id: uuidSchema.nullable(),
    /** The anchoring story's title (review context), or null when unresolvable. */
    story_title: z.string().min(1).max(300).nullable(),
    type: contributionTypeSchema,
    /** Truncated body (review context; the full text lives on the thread). */
    body_preview: z.string().max(280),
    citations: z.array(citationSchema).min(1).max(MAX_CITATIONS),
    created_at: isoTimestampSchema,
  })
  .strict();
export type EvidenceQueueRow = z.infer<typeof evidenceQueueRowSchema>;

export const evidenceQueueResponseSchema = z
  .object({
    /** Oldest first (FIFO review); rows leave the queue once ANY decision
     *  (including `clear`) exists for the contribution. */
    items: z.array(evidenceQueueRowSchema),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type EvidenceQueueResponse = z.infer<typeof evidenceQueueResponseSchema>;

export const evidenceDecisionRequestSchema = z
  .object({
    contribution_id: uuidSchema,
    action: evidenceDecisionActionSchema,
    /** The annotated citation — REQUIRED for the two citation actions and must
     *  be one of the contribution's own citation URLs (validated server-side). */
    citation_url: citationUrlSchema.optional(),
    /** Why a citation is weak/misleading — REQUIRED for `flag-citation`
     *  (evidence decisions are reviewable; a flag without a ratified reason is
     *  not reviewable).  Optional context for the other actions. */
    reason_code: contributionReasonCodeSchema.optional(),
    /** Internal reviewer note — never shown to the author. */
    note: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'clear') {
      if (value.citation_url !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['citation_url'],
          message: 'A clear reviews the whole contribution — it takes no citation target.',
        });
      }
      return;
    }
    if (value.citation_url === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['citation_url'],
        message: 'This action annotates exactly one of the contribution’s citations.',
      });
    }
    if (value.action === 'flag-citation' && value.reason_code === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason_code'],
        message: 'Flagging a citation requires a ratified reason code.',
      });
    }
  });
export type EvidenceDecisionRequest = z.infer<typeof evidenceDecisionRequestSchema>;

export const evidenceDecisionViewSchema = z
  .object({
    decision_id: uuidSchema,
    contribution_id: uuidSchema,
    story_id: uuidSchema.nullable(),
    action: evidenceDecisionActionSchema,
    citation_url: citationUrlSchema.nullable(),
    reason_code: contributionReasonCodeSchema.nullable(),
    /** Internal note — console-visible only. */
    note: z.string().max(2000).nullable(),
    decided_by_handle: z.string().min(1).nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type EvidenceDecisionView = z.infer<typeof evidenceDecisionViewSchema>;

export const evidenceDecisionsResponseSchema = z
  .object({
    /** Newest first. */
    items: z.array(evidenceDecisionViewSchema),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type EvidenceDecisionsResponse = z.infer<typeof evidenceDecisionsResponseSchema>;

// ---------------------------------------------------------------------------
// Coordinated-report incidents (WS-J.2.6e / MFCI-2) — the integrity queue.
// ---------------------------------------------------------------------------

export const coordinatedIncidentStatusSchema = z.enum(['open', 'cleared', 'confirmed']);
export type CoordinatedIncidentStatus = z.infer<typeof coordinatedIncidentStatusSchema>;

/** An incident view for the integrity queue.  The summary is AGGREGATE and
 *  base-rate-conditioned — never per-reporter identity (SPEC §19.5). */
export const coordinatedIncidentViewSchema = z
  .object({
    incident_id: uuidSchema,
    case_id: uuidSchema.nullable(),
    target_type: reportTargetTypeSchema,
    // Nullable: a right-to-erasure purge scrubs an `account` target's UUID.
    target_id: uuidSchema.nullable(),
    report_count: z.number().int().min(0),
    window_seconds: z.number().int().min(0),
    coordination_score: z.number().min(0).max(1),
    severity: reportSeveritySchema,
    status: coordinatedIncidentStatusSchema,
    summary: z.string(),
    created_at: isoTimestampSchema,
    reviewed_at: isoTimestampSchema.nullable(),
    reviewed_by: uuidSchema.nullable(),
  })
  .strict();
export type CoordinatedIncidentView = z.infer<typeof coordinatedIncidentViewSchema>;

export const incidentQueueResponseSchema = z
  .object({
    incidents: z.array(coordinatedIncidentViewSchema),
    /** TRUE open-incident total (independent of the returned page). */
    count: z.number().int().min(0),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type IncidentQueueResponse = z.infer<typeof incidentQueueResponseSchema>;

/** Resolve an incident: `cleared` (reports legitimate — lift the enforcement
 *  delay) or `confirmed` (a coordinated false-report attack — dismiss the case,
 *  protecting the target). */
export const incidentResolveRequestSchema = z
  .object({
    resolution: z.enum(['cleared', 'confirmed']),
    note: z.string().max(2_000).optional(),
  })
  .strict();
export type IncidentResolveRequest = z.infer<typeof incidentResolveRequestSchema>;

export const incidentResolveResponseSchema = z
  .object({
    incident: coordinatedIncidentViewSchema,
    /** The linked case's status after resolution (null when no linked case). */
    case_status: reportCaseStatusSchema.nullable(),
  })
  .strict();
export type IncidentResolveResponse = z.infer<typeof incidentResolveResponseSchema>;

/** WS-J.2.6b — the reviewer link-OPENING malware check.  Evidence URLs are
 *  stored, never fetched at submission time (SSRF avoidance); a reviewer
 *  resolves the redirect-chain verdict through this contract BEFORE navigating
 *  (the fetch runs server-side over the SSRF-hardened WS-F fetcher). */
export const urlVerdictRequestSchema = z
  .object({
    url: z.string().url().max(2048),
  })
  .strict();
export type UrlVerdictRequest = z.infer<typeof urlVerdictRequestSchema>;

export const urlVerdictResponseSchema = z
  .object({
    /** `malicious` blocks navigation; `unavailable` warns (fail toward
     *  flagging, never trusting); `clear` opens. */
    verdict: z.enum(['clear', 'malicious', 'unavailable']),
  })
  .strict();
export type UrlVerdictResponse = z.infer<typeof urlVerdictResponseSchema>;
