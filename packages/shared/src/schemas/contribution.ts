// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contribution contracts (SPEC §23.3 CreateContributionRequest). The eight
// structured participation types mirror the WS-B.2.10 composer modes — there is
// no "react/like/vote" type anywhere (no-applause doctrine, SIGNAL_MATRIX).
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { branchIdSchema } from './thread.js';

/** The eight structured contribution types (WS-B.2.10 composer modes). */
export const CONTRIBUTION_TYPES = [
  'ask',
  'evidence',
  'correction',
  'synthesis',
  'counterexample',
  'experience',
  'explain',
  'flag',
] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];
export const contributionTypeSchema = z.enum(CONTRIBUTION_TYPES);

export const moderationStateSchema = z.enum(['visible', 'pending', 'under-review', 'removed']);

/**
 * Create-contribution request. `local_draft_id` ties the server result back to
 * the offline draft so the pending-queue (WS-C.2.3) can reconcile it; the
 * request is queued offline and synced on reconnect (topic contribution.created).
 */
export const createContributionRequestSchema = z.object({
  thread_id: uuidSchema,
  branch: branchIdSchema,
  type: contributionTypeSchema,
  body: z.string().min(1).max(20_000),
  parent_id: uuidSchema.optional(),
  target_claim_id: uuidSchema.optional(),
  citations: z.array(z.string().url()).default([]),
  /** Local IndexedDB draft id (WS-C.2.2a draft-contributions store). */
  local_draft_id: z.string().min(1),
});
export type CreateContributionRequest = z.infer<typeof createContributionRequestSchema>;

export const contributionSchema = z.object({
  contribution_id: uuidSchema,
  thread_id: uuidSchema,
  type: contributionTypeSchema,
  body: z.string(),
  moderation_state: moderationStateSchema,
  created_at: isoTimestampSchema,
  /** Echoed back so the client can match the server row to its local draft. */
  local_draft_id: z.string().nullable(),
});
export type Contribution = z.infer<typeof contributionSchema>;

/** Safety report (SPEC §23.2 /reports; topic moderation.case.created). */
export const createReportRequestSchema = z.object({
  target_type: z.enum(['story', 'thread', 'contribution', 'account']),
  target_id: uuidSchema,
  reason: z.string().min(1).max(2_000),
  local_operation_id: z.string().min(1),
});
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;

/** Acknowledgement that a safety report was received (queued for review). */
export const reportAckSchema = z.object({
  status: z.literal('received'),
  local_operation_id: z.string().min(1),
});
export type ReportAck = z.infer<typeof reportAckSchema>;
