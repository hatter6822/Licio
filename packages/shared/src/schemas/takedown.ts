// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Takedown intake contracts (WS-F.1.4f, SPEC §14.2/§18.1). The takedown path
// is MANDATORY platform plumbing: anyone (a rights holder need not hold an
// account) can file a structured request against a story, source, or evidence
// card; requests route to the moderation queue (WS-J.2 seam) and are only
// ACTIONED after review — a fail-open auto-removal path would itself be a
// censorship-abuse vector (WS-F.1.4f security consideration).
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';

export const TAKEDOWN_TARGET_TYPES = ['story', 'source', 'evidence'] as const;
export type TakedownTargetType = (typeof TAKEDOWN_TARGET_TYPES)[number];
export const takedownTargetTypeSchema = z.enum(TAKEDOWN_TARGET_TYPES);

export const TAKEDOWN_LEGAL_BASES = ['copyright', 'privacy', 'court_order', 'other'] as const;
export type TakedownLegalBasis = (typeof TAKEDOWN_LEGAL_BASES)[number];
export const takedownLegalBasisSchema = z.enum(TAKEDOWN_LEGAL_BASES);

export const TAKEDOWN_STATUSES = ['received', 'under_review', 'actioned', 'rejected'] as const;
export type TakedownStatus = (typeof TAKEDOWN_STATUSES)[number];
export const takedownStatusSchema = z.enum(TAKEDOWN_STATUSES);

/** POST /v1/takedowns request (public intake; rate-limited). */
export const takedownCreateRequestSchema = z
  .object({
    target_type: takedownTargetTypeSchema,
    target_id: uuidSchema,
    /** How to reach the requester (email or postal contact, DMCA-style). */
    requester_contact: z.string().min(3).max(320),
    legal_basis: takedownLegalBasisSchema,
    claim_detail: z.string().min(10).max(5_000),
  })
  .strict();
export type TakedownCreateRequest = z.infer<typeof takedownCreateRequestSchema>;

/** 202 acknowledgement: receipt id only — review happens out of band. */
export const takedownCreateResponseSchema = z
  .object({
    takedown_id: uuidSchema,
    status: z.literal('received'),
  })
  .strict();

/** Steward view of a takedown request (admin surface; WS-J.2 seam). */
export const takedownRecordSchema = z
  .object({
    takedown_id: uuidSchema,
    target_type: takedownTargetTypeSchema,
    target_id: uuidSchema,
    requester_contact: z.string().min(3).max(320),
    legal_basis: takedownLegalBasisSchema,
    claim_detail: z.string().min(10).max(5_000),
    status: takedownStatusSchema,
    resolution_note: z.string().max(2_000).nullable(),
    actioned_at: isoTimestampSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type TakedownRecord = z.infer<typeof takedownRecordSchema>;

/** Steward action on a takedown (admin surface). */
export const takedownActionRequestSchema = z
  .object({
    action: z.enum(['under_review', 'actioned', 'rejected']),
    resolution_note: z.string().min(1).max(2_000),
  })
  .strict();
export type TakedownActionRequest = z.infer<typeof takedownActionRequestSchema>;
