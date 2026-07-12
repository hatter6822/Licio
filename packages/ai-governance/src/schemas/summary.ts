// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI summary draft + quality + correction (WS-K.1.4a/b/c, SPEC §15.4/§24.3). The
// automated draft is the FIRST layer of the WS-G three-layer summary system and
// is "never final". It is STRUCTURED — statements tagged fact/claim/
// interpretation, explicit unresolved questions, and explicit minority views —
// so the §24.3 quality constraints are mechanically checkable (../summary-quality.ts)
// rather than a matter of prose inspection. Every draft cites source
// contributions and their citations (verifiable links) and carries the
// machine-generated label; reports and steward corrections feed the WS-K.1.3c
// model-improvement loop.
import { z } from 'zod';
import { proseSchema, refIdSchema, semverSchema, shortTextSchema } from './common.js';

/** How a summary statement relates to the thread's epistemic status (§24.3). */
export const STATEMENT_KINDS = ['fact', 'claim', 'interpretation'] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];
export const statementKindSchema = z.enum(STATEMENT_KINDS);

/**
 * One summary statement. A `claim` MUST carry attribution ("User X argues
 * that…", §24.3: disputed claims use attribution, not declarative language); a
 * `fact` must NOT (declarative). Each statement cites the contributions/evidence
 * it draws from (verifiable links).
 */
export const summaryStatementSchema = z
  .object({
    kind: statementKindSchema,
    text: z.string().min(1).max(2_000),
    /** Required (non-null) for claims, null for facts/interpretations. */
    attribution: shortTextSchema.nullable(),
    cited_contribution_ids: z.array(refIdSchema).max(50),
  })
  .strict()
  .refine((s) => (s.kind === 'claim') === (s.attribution !== null), {
    message: 'claims must carry attribution; facts/interpretations must not',
    path: ['attribution'],
  });
export type SummaryStatement = z.infer<typeof summaryStatementSchema>;

/** A minority view that adds substantive information (§15.4). */
export const minorityViewSchema = z
  .object({
    text: z.string().min(1).max(2_000),
    cited_contribution_ids: z.array(refIdSchema).max(50),
  })
  .strict();
export type MinorityView = z.infer<typeof minorityViewSchema>;

export const aiSummaryDraftSchema = z
  .object({
    thread_id: refIdSchema,
    statements: z.array(summaryStatementSchema),
    /** Open questions the thread has not resolved (§24.3: preserve uncertainty). */
    unresolved_questions: z.array(z.string().min(1).max(2_000)),
    /** Relevant minority/dissenting views (§15.4). */
    minority_views: z.array(minorityViewSchema),
    /** The distinct thread branches (root contributions) the draft covers. */
    covered_contribution_ids: z.array(refIdSchema),
    model_name: shortTextSchema,
    model_version: semverSchema,
    output_id: refIdSchema,
    generated_at: z.string().datetime(),
  })
  .strict();
export type AiSummaryDraft = z.infer<typeof aiSummaryDraftSchema>;

// --- WS-K.1.4b quality constraints ------------------------------------------

export const SUMMARY_QUALITY_CONSTRAINTS = [
  'distinguish_facts_claims_interpretations',
  'preserve_uncertainty',
  'include_minority_views',
  'avoid_majority_as_truth',
  'avoid_slur_synthesis',
] as const;
export type SummaryQualityConstraint = (typeof SUMMARY_QUALITY_CONSTRAINTS)[number];
export const summaryQualityConstraintSchema = z.enum(SUMMARY_QUALITY_CONSTRAINTS);

export const summaryQualityConstraintResultSchema = z
  .object({
    constraint: summaryQualityConstraintSchema,
    passed: z.boolean(),
    detail: shortTextSchema,
  })
  .strict();
export type SummaryQualityConstraintResult = z.infer<typeof summaryQualityConstraintResultSchema>;

export const summaryQualityResultSchema = z
  .object({
    constraints: z.array(summaryQualityConstraintResultSchema),
    passed: z.boolean(),
  })
  .strict();
export type SummaryQualityResult = z.infer<typeof summaryQualityResultSchema>;

// --- WS-K.1.4c report/correction --------------------------------------------

/** The predefined reasons a user may report a summary (WS-K.1.4c). */
export const SUMMARY_REPORT_REASONS = [
  'factual_error',
  'missing_context',
  'bias',
  'harmful_content',
  'missing_minority_view',
  'fake_citation',
] as const;
export type SummaryReportReason = (typeof SUMMARY_REPORT_REASONS)[number];
export const summaryReportReasonSchema = z.enum(SUMMARY_REPORT_REASONS);

/** A user report of a summary. The reporter's identity is never exposed to
 *  other users (WS-K.1.4c security). */
export const summaryReportSchema = z
  .object({
    report_id: refIdSchema,
    summary_id: refIdSchema,
    reason: summaryReportReasonSchema,
    correction_text: proseSchema.nullable(),
    reported_at: z.string().datetime(),
  })
  .strict();
export type SummaryReport = z.infer<typeof summaryReportSchema>;
