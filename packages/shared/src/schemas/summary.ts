// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Summary contracts (WS-G.1.4, SPEC §15.4/§24.3).  Three layers: an
// automated draft (always labeled machine-generated, never final), a
// community synthesis (user-written, citing branches and evidence), and a
// steward summary (moderator-approved).  Community and steward layers MUST
// carry a non-empty unresolved-uncertainty note (§24.3: summaries preserve
// uncertainty and identify unresolved questions).
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';

export const SUMMARY_LAYERS = [
  'automated_draft',
  'community_synthesis',
  'steward_summary',
] as const;
export type SummaryLayer = (typeof SUMMARY_LAYERS)[number];
export const summaryLayerSchema = z.enum(SUMMARY_LAYERS);

export const summaryPublicSchema = z
  .object({
    summary_id: uuidSchema,
    thread_id: uuidSchema,
    layer: summaryLayerSchema,
    /** Markdown-lite (rendered through renderUGC, WS-G.4.2b). */
    body: z.string().min(1).max(10_000),
    cited_branch_ids: z.array(uuidSchema).max(50),
    cited_evidence_ids: z.array(uuidSchema).max(50),
    /** Required (non-null, non-empty) for community/steward layers (§24.3). */
    unresolved_uncertainty: z.string().min(1).max(2_000).nullable(),
    minority_views_note: z.string().min(1).max(2_000).nullable(),
    /** Non-removable machine-generated label (true iff automated_draft). */
    machine_generated: z.boolean(),
    /** Author handle (null for automated drafts and tombstoned accounts). */
    authored_by_handle: z.string().min(1).nullable(),
    /** Steward who approved a steward summary (handle; null otherwise). */
    approved_by_handle: z.string().min(1).nullable(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict()
  .refine((value) => value.machine_generated === (value.layer === 'automated_draft'), {
    message: 'machine_generated must be true exactly for automated drafts',
    path: ['machine_generated'],
  })
  .refine((value) => value.layer === 'automated_draft' || value.unresolved_uncertainty !== null, {
    message: 'Community and steward summaries must state unresolved uncertainty (§24.3)',
    path: ['unresolved_uncertainty'],
  });
export type SummaryPublic = z.infer<typeof summaryPublicSchema>;

/**
 * User-submitted summary creation (community synthesis; steward summary when
 * the author holds a steward role).  Automated drafts are system-created
 * (WS-K seam) and have no user-facing creation contract.
 */
export const summaryCreateRequestSchema = z
  .object({
    thread_id: uuidSchema,
    layer: z.enum(['community_synthesis', 'steward_summary']),
    body: z.string().trim().min(1).max(10_000),
    cited_branch_ids: z.array(uuidSchema).max(50).default([]),
    cited_evidence_ids: z.array(uuidSchema).max(50).default([]),
    unresolved_uncertainty: z
      .string()
      .trim()
      .min(1, 'State what remains unresolved (§24.3).')
      .max(2_000),
    minority_views_note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
export type SummaryCreateRequest = z.infer<typeof summaryCreateRequestSchema>;
