// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J user-facing trust & safety wire contracts (SPEC §18.3/§18.4/§23.2): the
// report, block, mute, appeal, support-contact, and user-notice ("statement of
// reasons" + appeal outcome) endpoints.  These are co-located with the Hono BFF
// route types and validated identically on client and server.  The steward
// CONSOLE contracts live in `moderation-console-api.ts`.
//
// Reporter identity is NEVER part of any response shape here — it is recorded
// server-side and surfaced only inside the authorized console (WS-J cross-cutting
// reporter-identity protection; SPEC §19.5).
import { z } from 'zod';
import { type ModerationReasonCode, REPORT_SEVERITIES } from '../constants/moderation.js';
import { httpUrlSchema, isoTimestampSchema, uuidSchema } from './common.js';
import { contributionReasonCodeSchema } from './contribution.js';
import { enforcementActionTypeSchema } from './steward-roles.js';
import { handleSchema } from './user.js';

/** Severity as it appears on the wire (the taxonomy scale, not the event scale). */
export const reportSeveritySchema = z.enum(REPORT_SEVERITIES);

/** An https evidence URL — stored, never fetched at submission time (SSRF). */
export const evidenceUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https:\/\//i.test(value), { message: 'evidence URL must be https' });

// ---------------------------------------------------------------------------
// Reports (WS-J.1.1a, POST /v1/reports).
// ---------------------------------------------------------------------------

/** What a report targets (SPEC §18.3). */
export const reportTargetTypeSchema = z.enum(['content', 'account', 'room']);
export type ReportTargetType = z.infer<typeof reportTargetTypeSchema>;

/** For content targets, the underlying entity (so the console renders context). */
export const reportContentKindSchema = z.enum(['story', 'thread', 'contribution']);
export type ReportContentKind = z.infer<typeof reportContentKindSchema>;

/** The WS-E `moderation.case.created` target-type scale. */
export type ModerationEventTargetType = 'contribution' | 'thread' | 'story' | 'user' | 'room';

/**
 * Map a report's (target_type, content_kind) onto the WS-E
 * `moderation.case.created` `target_type` scale, so the event carries the
 * precise entity (account→user, content→its content_kind) without inventing a
 * second SSOT.  A content target with an unknown content_kind falls back to
 * `contribution` (the most common content report).
 */
export function toEventTargetType(
  targetType: ReportTargetType,
  contentKind: ReportContentKind | null,
): ModerationEventTargetType {
  if (targetType === 'account') return 'user';
  if (targetType === 'room') return 'room';
  // content:
  if (contentKind === 'story') return 'story';
  if (contentKind === 'thread') return 'thread';
  return 'contribution';
}

/** Whether a report was routed to the emergency or the standard queue. */
export const reportRoutedToSchema = z.enum(['emergency', 'standard']);
export type ReportRoutedTo = z.infer<typeof reportRoutedToSchema>;

/** Report case lifecycle status (WS-J.2.1a). */
export const REPORT_CASE_STATUSES = ['new', 'in_progress', 'resolved', 'escalated'] as const;
export const reportCaseStatusSchema = z.enum(REPORT_CASE_STATUSES);
export type ReportCaseStatus = z.infer<typeof reportCaseStatusSchema>;

/**
 * `POST /v1/reports` request.  `reason_code` is taxonomy-bound (WS-A.1.2);
 * `local_operation_id` is the client-supplied idempotency key (it also lets the
 * offline queue replay a report safely — a re-submit returns the original
 * report, never a duplicate, WS-J.1.1a idempotency).
 */
export const createReportRequestSchema = z
  .object({
    target_type: reportTargetTypeSchema,
    target_id: uuidSchema,
    content_kind: reportContentKindSchema.optional(),
    reason_code: contributionReasonCodeSchema,
    context: z.string().trim().max(500).optional(),
    evidence_urls: z.array(evidenceUrlSchema).max(5).optional(),
    local_operation_id: z.string().min(1).max(200),
  })
  .strict();
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;

/** `POST /v1/reports` 201 response (WS-J.1.1a). */
export const reportCreatedResponseSchema = z
  .object({
    report_id: uuidSchema,
    status: z.literal('new'),
    severity: reportSeveritySchema,
    routed_to: reportRoutedToSchema,
    created_at: isoTimestampSchema,
    /** True when an existing report (same op-id, or same reporter+target+reason
     *  within the cooldown) was returned instead of creating a new record. */
    idempotent: z.boolean(),
  })
  .strict();
export type ReportCreatedResponse = z.infer<typeof reportCreatedResponseSchema>;

// ---------------------------------------------------------------------------
// Blocks (WS-J.1.2a) — bilateral, API-enforced.
// ---------------------------------------------------------------------------

/**
 * Name the block target either by user id or by PUBLIC HANDLE — exactly one.
 *
 * The handle form is what the product actually needs: the public contribution
 * projection deliberately withholds `author_user_id` (§19.5), so a reader looking
 * at a comment holds the author's HANDLE and nothing else.  Without it the
 * SPEC §B "two-tap report/block/mute" affordance has no identifier to act on and
 * blocking is unreachable from every content surface.  The id form is retained
 * for callers that already hold one (the console, tests, offline replay).
 *
 * `.strict()` on each member means supplying BOTH is a validation error rather
 * than a silent precedence rule.
 */
export const createBlockRequestSchema = z.union([
  z.object({ blocked_user_id: uuidSchema }).strict(),
  z.object({ blocked_user_handle: handleSchema }).strict(),
]);
export type CreateBlockRequest = z.infer<typeof createBlockRequestSchema>;

export const blockRecordSchema = z
  .object({
    block_id: uuidSchema,
    blocked_user_id: uuidSchema,
    /** The blocked account's public handle, so the management list can name who
     *  is blocked instead of rendering a truncated opaque id. */
    blocked_user_handle: handleSchema,
    created_at: isoTimestampSchema,
  })
  .strict();
export type BlockRecordView = z.infer<typeof blockRecordSchema>;

export const blockListResponseSchema = z
  .object({
    blocks: z.array(blockRecordSchema),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type BlockListResponse = z.infer<typeof blockListResponseSchema>;

// ---------------------------------------------------------------------------
// Mutes (WS-J.1.2b) — one-directional viewing filter.
// ---------------------------------------------------------------------------

export const MUTE_DURATIONS = ['1d', '7d', '30d', 'forever'] as const;
export const muteDurationSchema = z.enum(MUTE_DURATIONS);
export type MuteDuration = z.infer<typeof muteDurationSchema>;

/** Id-or-handle target, exactly as {@link createBlockRequestSchema} (same rationale). */
export const createMuteRequestSchema = z.union([
  z.object({ muted_user_id: uuidSchema, duration: muteDurationSchema.optional() }).strict(),
  z.object({ muted_user_handle: handleSchema, duration: muteDurationSchema.optional() }).strict(),
]);
export type CreateMuteRequest = z.infer<typeof createMuteRequestSchema>;

export const muteRecordSchema = z
  .object({
    mute_id: uuidSchema,
    muted_user_id: uuidSchema,
    /** The muted account's public handle — see {@link blockRecordSchema}. */
    muted_user_handle: handleSchema,
    expires_at: isoTimestampSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type MuteRecordView = z.infer<typeof muteRecordSchema>;

export const muteListResponseSchema = z
  .object({
    mutes: z.array(muteRecordSchema),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type MuteListResponse = z.infer<typeof muteListResponseSchema>;

/** A simple ok ack for unblock/unmute. */
export const okResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type OkResponse = z.infer<typeof okResponseSchema>;

// ---------------------------------------------------------------------------
// Appeals (WS-J.1.3b, POST /v1/appeals).
// ---------------------------------------------------------------------------

export const createAppealRequestSchema = z
  .object({
    action_id: uuidSchema,
    user_statement: z.string().trim().min(1).max(2000),
    new_evidence: z.array(evidenceUrlSchema).max(5).optional(),
  })
  .strict();
export type CreateAppealRequest = z.infer<typeof createAppealRequestSchema>;

export const APPEAL_STATUSES = ['pending', 'overturned', 'upheld', 'modified'] as const;
export const appealStatusSchema = z.enum(APPEAL_STATUSES);
export type AppealStatus = z.infer<typeof appealStatusSchema>;

export const appealCreatedResponseSchema = z
  .object({
    appeal_id: uuidSchema,
    status: z.literal('pending'),
    action_id: uuidSchema,
    sla_due_at: isoTimestampSchema,
    created_at: isoTimestampSchema,
  })
  .strict();
export type AppealCreatedResponse = z.infer<typeof appealCreatedResponseSchema>;

/**
 * The user-visible appeal-eligibility check for one of THEIR OWN actions
 * (WS-J.1.3a; shown before the appeal form).  `available_at` is present for a
 * ban still in its cooldown.
 */
export const appealEligibilityViewSchema = z
  .object({
    action_id: uuidSchema,
    action_type: enforcementActionTypeSchema,
    appealable: z.boolean(),
    /** Why it is not (yet) appealable — for the explanatory message. */
    ineligible_reason: z
      .enum(['ban_cooldown', 'emergency_deferred', 'lawful_basis', 'shadow_notice_pending'])
      .nullable(),
    available_at: isoTimestampSchema.nullable(),
    /** True when an appeal already exists for this action (one appeal per action). */
    already_appealed: z.boolean(),
  })
  .strict();
export type AppealEligibilityView = z.infer<typeof appealEligibilityViewSchema>;

// ---------------------------------------------------------------------------
// Support contact (WS-J.1.1e) — unauthenticated, every-screen reachable.
// ---------------------------------------------------------------------------

export const emergencyResourceSchema = z
  .object({
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(240),
    url: httpUrlSchema.nullable(),
    phone: z.string().min(1).max(40).nullable(),
  })
  .strict();
export type EmergencyResource = z.infer<typeof emergencyResourceSchema>;

export const supportContactResponseSchema = z
  .object({
    safety_email: z.string().email(),
    help_center_url: httpUrlSchema,
    /** Jurisdiction whose resources are shown (null = the safe default set). */
    jurisdiction: z.string().min(2).max(8).nullable(),
    emergency_resources: z.array(emergencyResourceSchema).max(20),
  })
  .strict();
export type SupportContactResponse = z.infer<typeof supportContactResponseSchema>;

// ---------------------------------------------------------------------------
// User moderation notices (WS-J.1.3d) — the "statement of reasons" + appeal
// outcome inbox the user reads.  Never silent (cross-cutting invariant 2).
// ---------------------------------------------------------------------------

export const MODERATION_NOTICE_KINDS = ['action', 'appeal_outcome'] as const;
export const moderationNoticeKindSchema = z.enum(MODERATION_NOTICE_KINDS);
export type ModerationNoticeKind = z.infer<typeof moderationNoticeKindSchema>;

export const moderationNoticeSchema = z
  .object({
    notice_id: uuidSchema,
    kind: moderationNoticeKindSchema,
    /** The action this notice concerns (the appeal target, when an outcome). */
    action_id: uuidSchema,
    /** Statement-of-reasons heading, e.g. "Your contribution was hidden". */
    title: z.string().min(1).max(200),
    /** Human-readable statement of reasons / outcome explanation. */
    body: z.string().min(1).max(4000),
    reason_code: contributionReasonCodeSchema.nullable(),
    /** Whether the user may appeal this action right now. */
    appealable: z.boolean(),
    /** For an appeal-outcome notice: the resolution. */
    appeal_status: appealStatusSchema.nullable(),
    created_at: isoTimestampSchema,
    read_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type ModerationNoticeView = z.infer<typeof moderationNoticeSchema>;

export const moderationNoticeListResponseSchema = z
  .object({
    notices: z.array(moderationNoticeSchema),
    next_cursor: z.string().min(1).max(512).nullable(),
    unread_count: z.number().int().min(0),
  })
  .strict();
export type ModerationNoticeListResponse = z.infer<typeof moderationNoticeListResponseSchema>;

/** Re-export of the reason-code type so route modules import one place. */
export type { ModerationReasonCode };
