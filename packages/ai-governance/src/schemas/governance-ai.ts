// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI around Knomosis governance (WS-K.2.2a, SPEC §24.5). The permitted/prohibited
// CAPABILITY split lives in ./prohibited-use.ts (the same pre-execution guard
// enforces it). This module defines the structured output of a governance
// proposal summary: every summary cites the specific proposal fields it draws
// from, flags material uncertainty explicitly, carries the machine-generated
// label, and is contestable/editable by stewards — never final, never autonomous
// (§24.1/§24.5). COI highlights and scam-pattern detection are advisory to
// stewards only.
import { z } from 'zod';
import { proseSchema, refIdSchema, semverSchema, shortTextSchema } from './common.js';

export const governanceProposalSummarySchema = z
  .object({
    summary_id: refIdSchema,
    proposal_ref: refIdSchema,
    /** The specific proposal fields the summary draws from — at least one, so a
     *  summary always cites its sources (WS-K.2.2a acceptance). */
    cited_fields: z.array(shortTextSchema).min(1),
    body: proseSchema,
    /** Material uncertainty stated explicitly, or null when none is material.
     *  `uncertainty_flagged` records whether any was flagged. */
    material_uncertainty: proseSchema.nullable(),
    uncertainty_flagged: z.boolean(),
    /** Pinned label — governance summaries are machine-generated. */
    label: z.literal('machine-generated'),
    /** Pinned true — governance AI output is always contestable (§24.5). */
    contestable: z.literal(true),
    /** Whether a steward has edited/contested this summary. */
    steward_edited: z.boolean(),
    output_id: refIdSchema,
    model_name: shortTextSchema,
    model_version: semverSchema,
    generated_at: z.string().datetime(),
  })
  .strict()
  .refine((s) => s.uncertainty_flagged === (s.material_uncertainty !== null), {
    message: 'uncertainty_flagged must match the presence of material_uncertainty',
    path: ['uncertainty_flagged'],
  });
export type GovernanceProposalSummary = z.infer<typeof governanceProposalSummarySchema>;

/** A governance advisory finding (COI highlight / scam-pattern), advisory to
 *  stewards only — never enforcement (WS-K.2.2a). */
export const GOVERNANCE_ADVISORY_KINDS = ['coi_highlight', 'scam_pattern'] as const;
export type GovernanceAdvisoryKind = (typeof GOVERNANCE_ADVISORY_KINDS)[number];
export const governanceAdvisoryKindSchema = z.enum(GOVERNANCE_ADVISORY_KINDS);

export const governanceAdvisorySchema = z
  .object({
    advisory_id: refIdSchema,
    proposal_ref: refIdSchema,
    kind: governanceAdvisoryKindSchema,
    detail: proseSchema,
    /** Pinned true — advisories never enforce; a steward decides (§24.5). */
    advisory_only: z.literal(true),
    output_id: refIdSchema,
    generated_at: z.string().datetime(),
  })
  .strict();
export type GovernanceAdvisory = z.infer<typeof governanceAdvisorySchema>;
