// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J trust & safety durable model (SPEC §16.4/§18.2/§18.3/§25.4).  These
// tables back the report queue, the user-safety controls (block/mute), the
// appeals pipeline, the action palette, and the append-only audit log.
//
// Security/privacy-load-bearing choices:
//   • `moderation_reports.reporter_user_id` is the highest-sensitivity field in
//     the system (SPEC §19.5): reporter identity is reachable ONLY through the
//     role-gated console, never in any user-facing projection, and is dropped
//     (set null) on account deletion.
//   • `moderation_audit` is APPEND-ONLY: there is no UPDATE/DELETE code path,
//     and a DB trigger (added by the migration) rejects mutation — the log is
//     the tamper-evident source of truth for history + transparency.
//   • NO wallet/payment/treasury/donor column exists on any moderation table
//     (the ranking-neutrality "no financial data in moderation" rule, SPEC
//     §13.6) — enforced by the ABSENCE of the column, not by hiding it.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './user.js';

// ---------------------------------------------------------------------------
// Shared enums.
// ---------------------------------------------------------------------------

export const reportTargetTypeEnum = pgEnum('report_target_type', ['content', 'account', 'room']);
export const reportContentKindEnum = pgEnum('report_content_kind', [
  'story',
  'thread',
  'contribution',
]);
export const reportSeverityEnum = pgEnum('report_severity', [
  'minor',
  'moderate',
  'severe',
  'critical',
]);
export const reportRoutedToEnum = pgEnum('report_routed_to', ['emergency', 'standard']);
export const moderationCaseStatusEnum = pgEnum('moderation_case_status', [
  'new',
  'in_progress',
  'resolved',
  'escalated',
]);

// ---------------------------------------------------------------------------
// Cases (one open case per target; aggregates its reports) and reports.
// ---------------------------------------------------------------------------

export const moderationCases = pgTable(
  'moderation_cases',
  {
    caseId: uuid('case_id').primaryKey().defaultRandom(),
    targetType: reportTargetTypeEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    contentKind: reportContentKindEnum('content_kind'),
    status: moderationCaseStatusEnum('status').notNull().default('new'),
    severity: reportSeverityEnum('severity').notNull(),
    routedTo: reportRoutedToEnum('routed_to').notNull(),
    /** Reviewer currently handling the case (WS-J.2.1d). */
    assignedTo: uuid('assigned_to').references(() => users.userId, { onDelete: 'set null' }),
    reportCount: integer('report_count').notNull().default(1),
    /** True while volume-driven enforcement is delayed pending integrity review
     *  (coordinated-report protection, MFCI-2 / WS-J.2.6e). */
    enforcementDelayed: boolean('enforcement_delayed').notNull().default(false),
    /** The action that resolved the case, when resolved by enforcement. */
    resolvedActionId: uuid('resolved_action_id'),
    slaDueAt: timestamp('sla_due_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one OPEN case per target (a new report joins it; a resolved case
    // can be superseded by a later one).
    uniqueIndex('moderation_cases_open_target_uq')
      .on(t.targetType, t.targetId)
      .where(sql`${t.status} <> 'resolved'`),
    index('moderation_cases_queue_idx').on(t.status, t.routedTo, t.severity, t.slaDueAt),
    index('moderation_cases_assigned_idx').on(t.assignedTo),
    index('moderation_cases_target_idx').on(t.targetType, t.targetId),
  ],
);
export type ModerationCaseRowDb = typeof moderationCases.$inferSelect;
export type ModerationCaseInsert = typeof moderationCases.$inferInsert;

export const moderationReports = pgTable(
  'moderation_reports',
  {
    reportId: uuid('report_id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => moderationCases.caseId, { onDelete: 'cascade' }),
    /** Reporter identity — restricted; dropped on the reporter's deletion. */
    reporterUserId: uuid('reporter_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    targetType: reportTargetTypeEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    contentKind: reportContentKindEnum('content_kind'),
    reasonCode: text('reason_code').notNull(),
    severity: reportSeverityEnum('severity').notNull(),
    context: text('context'),
    /** Stored, never fetched server-side at submission (SSRF avoidance). */
    evidenceUrls: jsonb('evidence_urls').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Client-supplied idempotency key (offline-queue replay safe). */
    localOperationId: text('local_operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('moderation_reports_case_idx').on(t.caseId),
    // Offline-replay idempotency: a re-sent report with the same op-id is a no-op.
    uniqueIndex('moderation_reports_op_uq').on(t.reporterUserId, t.localOperationId),
    // Reporter+target+reason cooldown idempotency lookup.
    index('moderation_reports_dedup_idx').on(
      t.reporterUserId,
      t.targetType,
      t.targetId,
      t.reasonCode,
    ),
  ],
);
export type ModerationReportRowDb = typeof moderationReports.$inferSelect;
export type ModerationReportInsert = typeof moderationReports.$inferInsert;

// ---------------------------------------------------------------------------
// Actions (live enforcement state) — the audit log mirrors each as an event.
// ---------------------------------------------------------------------------

export const moderationActions = pgTable(
  'moderation_actions',
  {
    actionId: uuid('action_id').primaryKey().defaultRandom(),
    /** Null actor ⇒ an automated (system) action. */
    actorUserId: uuid('actor_user_id').references(() => users.userId, { onDelete: 'set null' }),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    /** The user the action acts against (notice recipient / appeal owner / history). */
    subjectUserId: uuid('subject_user_id').references(() => users.userId, { onDelete: 'set null' }),
    reasonCode: text('reason_code'),
    duration: text('duration'),
    reviewerNote: text('reviewer_note'),
    priorState: text('prior_state'),
    nextState: text('next_state'),
    reversible: boolean('reversible').notNull().default(true),
    reverted: boolean('reverted').notNull().default(false),
    /** Revert→original, or appeal-applied→original. */
    linkedActionId: uuid('linked_action_id'),
    caseId: uuid('case_id').references(() => moderationCases.caseId, { onDelete: 'set null' }),
    coApproverUserId: uuid('co_approver_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    reportIds: jsonb('report_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('moderation_actions_subject_idx').on(t.subjectUserId, t.createdAt),
    index('moderation_actions_target_idx').on(t.targetType, t.targetId),
    index('moderation_actions_actor_idx').on(t.actorUserId),
  ],
);
export type ModerationActionRowDb = typeof moderationActions.$inferSelect;
export type ModerationActionInsert = typeof moderationActions.$inferInsert;

// ---------------------------------------------------------------------------
// Append-only audit log (WS-J.2.5a) — tamper-evident; no UPDATE/DELETE path.
// ---------------------------------------------------------------------------

export const moderationAudit = pgTable(
  'moderation_audit',
  {
    auditId: uuid('audit_id').primaryKey().defaultRandom(),
    eventTime: timestamp('event_time', { withTimezone: true }).notNull().defaultNow(),
    /** Null actor ⇒ `system` (automated block). */
    actorUserId: uuid('actor_user_id').references(() => users.userId, { onDelete: 'set null' }),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    reasonCode: text('reason_code'),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    subjectUserId: uuid('subject_user_id').references(() => users.userId, { onDelete: 'set null' }),
    priorState: text('prior_state'),
    nextState: text('next_state'),
    reversible: boolean('reversible').notNull().default(false),
    linkedActionId: uuid('linked_action_id'),
    reportIds: jsonb('report_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    coApproverUserId: uuid('co_approver_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('moderation_audit_actor_idx').on(t.actorUserId),
    index('moderation_audit_subject_idx').on(t.subjectUserId),
    index('moderation_audit_action_idx').on(t.action),
    index('moderation_audit_reason_idx').on(t.reasonCode),
    index('moderation_audit_time_idx').on(t.eventTime),
  ],
);
export type ModerationAuditRowDb = typeof moderationAudit.$inferSelect;
export type ModerationAuditInsert = typeof moderationAudit.$inferInsert;

// ---------------------------------------------------------------------------
// User-safety controls: blocks (bilateral) and mutes (one-directional).
// ---------------------------------------------------------------------------

export const accountBlocks = pgTable(
  'account_blocks',
  {
    blockId: uuid('block_id').primaryKey().defaultRandom(),
    blockerUserId: uuid('blocker_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    blockedUserId: uuid('blocked_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('account_blocks_pair_uq').on(t.blockerUserId, t.blockedUserId),
    index('account_blocks_blocker_idx').on(t.blockerUserId, t.createdAt),
    index('account_blocks_blocked_idx').on(t.blockedUserId),
    // A user cannot block themselves.
    check('account_blocks_not_self', sql`${t.blockerUserId} <> ${t.blockedUserId}`),
  ],
);
export type AccountBlockRowDb = typeof accountBlocks.$inferSelect;
export type AccountBlockInsert = typeof accountBlocks.$inferInsert;

export const accountMutes = pgTable(
  'account_mutes',
  {
    muteId: uuid('mute_id').primaryKey().defaultRandom(),
    muterUserId: uuid('muter_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    mutedUserId: uuid('muted_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    /** Null ⇒ "forever"; otherwise the auto-lift time. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('account_mutes_pair_uq').on(t.muterUserId, t.mutedUserId),
    index('account_mutes_muter_idx').on(t.muterUserId, t.createdAt),
    index('account_mutes_expiry_idx').on(t.expiresAt),
    check('account_mutes_not_self', sql`${t.muterUserId} <> ${t.mutedUserId}`),
  ],
);
export type AccountMuteRowDb = typeof accountMutes.$inferSelect;
export type AccountMuteInsert = typeof accountMutes.$inferInsert;

// ---------------------------------------------------------------------------
// Appeals (WS-J.1.3) — one appeal per action; independent reviewer enforced.
// ---------------------------------------------------------------------------

export const appealStatusEnum = pgEnum('appeal_status', [
  'pending',
  'overturned',
  'upheld',
  'modified',
]);

export const moderationAppeals = pgTable(
  'moderation_appeals',
  {
    appealId: uuid('appeal_id').primaryKey().defaultRandom(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => moderationActions.actionId, { onDelete: 'cascade' }),
    appellantUserId: uuid('appellant_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    statement: text('statement').notNull(),
    newEvidence: jsonb('new_evidence').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: appealStatusEnum('status').notNull().default('pending'),
    /** Independent reviewer (never the original decision-maker, WS-J.1.3c). */
    assignedReviewerId: uuid('assigned_reviewer_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    isBanAppeal: boolean('is_ban_appeal').notNull().default(false),
    slaDueAt: timestamp('sla_due_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => users.userId, { onDelete: 'set null' }),
    decisionReasonCode: text('decision_reason_code'),
    decisionExplanation: text('decision_explanation'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One appeal per action (WS-J.1.3b 409 on duplicate).
    uniqueIndex('moderation_appeals_action_uq').on(t.actionId),
    index('moderation_appeals_queue_idx').on(t.status, t.slaDueAt),
    index('moderation_appeals_reviewer_idx').on(t.assignedReviewerId),
    index('moderation_appeals_appellant_idx').on(t.appellantUserId),
  ],
);
export type ModerationAppealRowDb = typeof moderationAppeals.$inferSelect;
export type ModerationAppealInsert = typeof moderationAppeals.$inferInsert;

// ---------------------------------------------------------------------------
// User-facing notices (WS-J.1.3d) — statement of reasons + appeal outcome.
// ---------------------------------------------------------------------------

export const moderationNoticeKindEnum = pgEnum('moderation_notice_kind', [
  'action',
  'appeal_outcome',
]);

export const moderationNotices = pgTable(
  'moderation_notices',
  {
    noticeId: uuid('notice_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    kind: moderationNoticeKindEnum('kind').notNull(),
    actionId: uuid('action_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    reasonCode: text('reason_code'),
    appealable: boolean('appealable').notNull().default(false),
    appealStatus: appealStatusEnum('appeal_status'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('moderation_notices_user_idx').on(t.userId, t.createdAt),
    index('moderation_notices_unread_idx').on(t.userId, t.readAt),
    index('moderation_notices_action_idx').on(t.actionId),
  ],
);
export type ModerationNoticeRowDb = typeof moderationNotices.$inferSelect;
export type ModerationNoticeInsert = typeof moderationNotices.$inferInsert;

// ---------------------------------------------------------------------------
// Reviewer availability (WS-J.2.1d) + coordinated-report incidents (WS-J.2.6e).
// ---------------------------------------------------------------------------

export const reviewerAvailabilityEnum = pgEnum('reviewer_availability', [
  'available',
  'busy',
  'offline',
]);

export const reviewerStatus = pgTable('reviewer_status', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.userId, { onDelete: 'cascade' }),
  status: reviewerAvailabilityEnum('status').notNull().default('offline'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type ReviewerStatusRowDb = typeof reviewerStatus.$inferSelect;
export type ReviewerStatusInsert = typeof reviewerStatus.$inferInsert;

export const coordinatedReportIncidentStatusEnum = pgEnum('coordinated_report_incident_status', [
  'open',
  'cleared',
  'confirmed',
]);

export const coordinatedReportIncidents = pgTable(
  'coordinated_report_incidents',
  {
    incidentId: uuid('incident_id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').references(() => moderationCases.caseId, { onDelete: 'set null' }),
    targetType: reportTargetTypeEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    reportCount: integer('report_count').notNull(),
    windowSeconds: integer('window_seconds').notNull(),
    /** Coordination score in [0,1]; cheap statistics until MFCI confirms. */
    coordinationScore: numeric('coordination_score', { precision: 5, scale: 4 }).notNull(),
    severity: reportSeverityEnum('severity').notNull(),
    status: coordinatedReportIncidentStatusEnum('status').notNull().default('open'),
    /** Aggregate, base-rate-conditioned summary — never per-reporter identity. */
    summary: text('summary').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => users.userId, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('coordinated_report_incidents_status_idx').on(t.status, t.createdAt),
    index('coordinated_report_incidents_target_idx').on(t.targetType, t.targetId),
  ],
);
export type CoordinatedReportIncidentRowDb = typeof coordinatedReportIncidents.$inferSelect;
export type CoordinatedReportIncidentInsert = typeof coordinatedReportIncidents.$inferInsert;
