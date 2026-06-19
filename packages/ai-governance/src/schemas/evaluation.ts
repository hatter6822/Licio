// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Evaluation result schemas (WS-K.1.2a-e, SPEC §24.2/§30.9). The four
// evaluations — bias/subgroup audit, hallucination detection, safety/privacy
// suite, red-team protocol — each produce a strict result; the harness
// aggregates them into a deploy/block decision (WS-K.1.2e) that gates the
// registry. Results are stored on the model card's `evaluation_results` and the
// harness decision is logged for reproducibility (the dataset versions used are
// recorded so a re-run is verifiable).
import { z } from 'zod';
import { proseSchema, semverSchema, shortTextSchema } from './common.js';

/** A probability / rate in the closed unit interval. */
const unit = z.number().min(0).max(1);

export const EVALUATION_KINDS = [
  'bias_audit',
  'hallucination',
  'safety_privacy',
  'red_team',
] as const;
export type EvaluationKind = (typeof EVALUATION_KINDS)[number];

/** A dataset id@version pair the evaluation ran against (reproducibility). */
export const datasetVersionRefSchema = z
  .object({ dataset_id: shortTextSchema, version: semverSchema })
  .strict();
export type DatasetVersionRef = z.infer<typeof datasetVersionRefSchema>;

// --- WS-K.1.2a bias and subgroup audit --------------------------------------

export const BIAS_SUBGROUP_DIMENSIONS = [
  'language',
  'region',
  'topic_sensitivity',
  'content_length',
  'source_type',
] as const;
export type BiasSubgroupDimension = (typeof BIAS_SUBGROUP_DIMENSIONS)[number];
export const biasSubgroupDimensionSchema = z.enum(BIAS_SUBGROUP_DIMENSIONS);

/** Per-(dimension, subgroup) measured performance. Classification models carry
 *  accuracy/precision/recall; generation models carry quality_score. */
export const subgroupMetricSchema = z
  .object({
    dimension: biasSubgroupDimensionSchema,
    subgroup: shortTextSchema,
    sample_size: z.number().int().nonnegative(),
    accuracy: unit.optional(),
    precision: unit.optional(),
    recall: unit.optional(),
    quality_score: unit.optional(),
  })
  .strict();
export type SubgroupMetric = z.infer<typeof subgroupMetricSchema>;

/** A measured disparity on one (dimension, metric), with significance. */
export const disparitySchema = z
  .object({
    dimension: biasSubgroupDimensionSchema,
    metric: z.enum(['accuracy', 'precision', 'recall', 'quality_score']),
    best_subgroup: shortTextSchema,
    worst_subgroup: shortTextSchema,
    best_value: unit,
    worst_value: unit,
    /** best_value − worst_value (≥ 0). */
    disparity: unit,
    /** Two-proportion z-test p-value for the best/worst gap. */
    p_value: unit,
    significant: z.boolean(),
    /** True ⇒ a significant disparity above threshold that was explicitly
     *  accepted with documentation (does not block deployment). */
    accepted: z.boolean(),
  })
  .strict();
export type Disparity = z.infer<typeof disparitySchema>;

export const biasAuditResultSchema = z
  .object({
    eval_kind: z.literal('bias_audit'),
    subgroup_metrics: z.array(subgroupMetricSchema),
    disparities: z.array(disparitySchema),
    /** Disparity threshold above which deployment is blocked (configurable). */
    threshold: unit,
    passed: z.boolean(),
    accepted_with_documentation: z.boolean(),
    justification: proseSchema.nullable(),
    dataset_versions: z.array(datasetVersionRefSchema),
  })
  .strict();
export type BiasAuditResult = z.infer<typeof biasAuditResultSchema>;

// --- WS-K.1.2b hallucination detection --------------------------------------

export const hallucinationResultSchema = z
  .object({
    eval_kind: z.literal('hallucination'),
    sample_count: z.number().int().nonnegative(),
    /** Statements traceable to source material. */
    grounded_count: z.number().int().nonnegative(),
    /** Statements contradicting source material. */
    contradiction_count: z.number().int().nonnegative(),
    /** Citations that do not resolve to real source content. */
    fake_citation_count: z.number().int().nonnegative(),
    /** (ungrounded + contradictions + fake citations) / sample_count. */
    hallucination_rate: unit,
    threshold: unit,
    passed: z.boolean(),
    accepted_with_documentation: z.boolean(),
    dataset_versions: z.array(datasetVersionRefSchema),
  })
  .strict();
export type HallucinationResult = z.infer<typeof hallucinationResultSchema>;

// --- WS-K.1.2c safety/privacy suite -----------------------------------------

export const SAFETY_CATEGORIES = [
  'private_data_exposure',
  'harmful_content',
  'data_minimization',
  'sensitive_topic_handling',
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];
export const safetyCategorySchema = z.enum(SAFETY_CATEGORIES);

export const safetyCategoryResultSchema = z
  .object({
    category: safetyCategorySchema,
    passed: z.boolean(),
    cases_run: z.number().int().nonnegative(),
    cases_failed: z.number().int().nonnegative(),
    detail: shortTextSchema,
  })
  .strict();
export type SafetyCategoryResult = z.infer<typeof safetyCategoryResultSchema>;

export const safetyResultSchema = z
  .object({
    eval_kind: z.literal('safety_privacy'),
    categories: z.array(safetyCategoryResultSchema),
    passed: z.boolean(),
    dataset_versions: z.array(datasetVersionRefSchema),
  })
  .strict();
export type SafetyResult = z.infer<typeof safetyResultSchema>;

// --- WS-K.1.2d red-team protocol --------------------------------------------

export const RED_TEAM_CATEGORIES = [
  'adversarial_prompts',
  'jailbreaks',
  'bias_probing',
  'edge_cases',
] as const;
export type RedTeamCategory = (typeof RED_TEAM_CATEGORIES)[number];
export const redTeamCategorySchema = z.enum(RED_TEAM_CATEGORIES);

export const redTeamCategoryResultSchema = z
  .object({
    category: redTeamCategorySchema,
    test_count: z.number().int().nonnegative(),
    /** Tests that surfaced a prohibited output (critical). */
    critical_findings: z.number().int().nonnegative(),
  })
  .strict();
export type RedTeamCategoryResult = z.infer<typeof redTeamCategoryResultSchema>;

export const redTeamResultSchema = z
  .object({
    eval_kind: z.literal('red_team'),
    categories: z.array(redTeamCategoryResultSchema),
    /** Minimum test cases required per category (configurable, default 50). */
    min_per_category: z.number().int().positive(),
    critical_finding_count: z.number().int().nonnegative(),
    /** Documented accepted risks (non-critical findings left unmitigated). */
    accepted_risks: z.array(shortTextSchema),
    passed: z.boolean(),
    accepted_with_documentation: z.boolean(),
    dataset_versions: z.array(datasetVersionRefSchema),
  })
  .strict();
export type RedTeamResult = z.infer<typeof redTeamResultSchema>;

// --- the discriminated union + harness aggregate ----------------------------

export const evaluationResultSchema = z.discriminatedUnion('eval_kind', [
  biasAuditResultSchema,
  hallucinationResultSchema,
  safetyResultSchema,
  redTeamResultSchema,
]);
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;

/** The harness's aggregate deploy/block decision (WS-K.1.2e). */
export const harnessDecisionSchema = z
  .object({
    model_name: shortTextSchema,
    version: semverSchema,
    decision: z.enum(['deploy', 'block']),
    /** Every applicable evaluation's result. */
    per_eval: z.array(evaluationResultSchema),
    /** Reasons a `block` decision was reached (empty for `deploy`). */
    blocked_reasons: z.array(shortTextSchema),
    /** All dataset versions across the evaluations (reproducibility). */
    dataset_versions: z.array(datasetVersionRefSchema),
    evaluated_at: z.string().datetime(),
  })
  .strict()
  .refine((d) => (d.decision === 'block') === d.blocked_reasons.length > 0, {
    message: 'a block decision must carry reasons, and a deploy decision none',
    path: ['blocked_reasons'],
  });
export type HarnessDecision = z.infer<typeof harnessDecisionSchema>;
