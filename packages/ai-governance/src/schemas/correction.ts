// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Human-in-the-loop correction + feedback (WS-K.1.3c, SPEC §24.1/§24.2). Stewards
// confirm, reject, or modify AI outputs; the correction preserves the original
// (linked to its `AIOutputRecord`, WS-K.1.1f) and carries provenance (which
// steward, when, what changed). Accuracy metrics use steward corrections as
// ground truth: correction rate, agreement rate, and per-category accuracy drive
// the quality dashboard and the runtime monitor (WS-K.1.2f). Feedback enters
// training ONLY via the privacy-reviewed lineage path (WS-K.1.1e).
import { z } from 'zod';
import { aiUseCaseIdSchema, proseSchema, refIdSchema, shortTextSchema } from './common.js';

export const AI_CORRECTION_ACTIONS = ['confirm', 'reject', 'modify'] as const;
export type AiCorrectionAction = (typeof AI_CORRECTION_ACTIONS)[number];
export const aiCorrectionActionSchema = z.enum(AI_CORRECTION_ACTIONS);

export const aiCorrectionSchema = z
  .object({
    correction_id: refIdSchema,
    /** The originating audit record (WS-K.1.1f). */
    output_id: refIdSchema,
    use_case_id: aiUseCaseIdSchema,
    action: aiCorrectionActionSchema,
    /** The AI output as produced (preserved). */
    original_value: proseSchema,
    /** The corrected value (null for confirm/reject). */
    corrected_value: proseSchema.nullable(),
    /** The acting steward reference (`steward:<id>`), never a raw identity. */
    steward_ref: shortTextSchema,
    /** Optional per-category label for accuracy roll-up (e.g. a topic id). */
    category: shortTextSchema.nullable(),
    corrected_at: z.string().datetime(),
  })
  .strict()
  .refine((c) => (c.action === 'modify') === (c.corrected_value !== null), {
    message: 'modify requires a corrected_value; confirm/reject must not carry one',
    path: ['corrected_value'],
  });
export type AiCorrection = z.infer<typeof aiCorrectionSchema>;

/** Per-category accuracy roll-up. */
export const accuracyCategoryMetricSchema = z
  .object({
    category: shortTextSchema,
    total: z.number().int().nonnegative(),
    /** confirmed / total. */
    agreement_rate: z.number().min(0).max(1),
  })
  .strict();
export type AccuracyCategoryMetric = z.infer<typeof accuracyCategoryMetricSchema>;

/** Accuracy metrics computed from accumulated corrections (WS-K.1.3c). */
export const aiAccuracyMetricsSchema = z
  .object({
    use_case_id: aiUseCaseIdSchema,
    total: z.number().int().nonnegative(),
    confirmed: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    /** (rejected + modified) / total — the fraction the AI got wrong. */
    correction_rate: z.number().min(0).max(1),
    /** confirmed / total — the fraction stewards agreed with as-is. */
    agreement_rate: z.number().min(0).max(1),
    per_category: z.array(accuracyCategoryMetricSchema),
    computed_at: z.string().datetime(),
  })
  .strict();
export type AiAccuracyMetrics = z.infer<typeof aiAccuracyMetricsSchema>;
