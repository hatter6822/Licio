// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.1d — per-invariant-type zod schemas for the `score_vector` JSONB.
//
// Each invariant's output shape is explicit, STRICT (unreviewed fields are
// rejected — snapshot tests pin the shapes), and versioned through the
// registry below. Application-layer validation calls
// `validateScoreVector(invariantType, vector)` before any insert; the
// discriminated wrapper `typedScoreVectorSchema` routes by invariant_type
// for consumers that carry both fields together. PWAtt vectors (the WS-E
// shadow scorer) remain flat numeric records and validate through the
// dedicated PWAtt entry.

import { z } from 'zod';
import { HODGE_THREAD_LABELS } from '../hodge/tension.js';
import { MFCI_STATISTICS } from '../mfci/pvalue.js';
import { MFCI_RISK_STATES } from '../mfci/risk.js';
import { SESSION_HEALTH_CLASSES } from '../pathsig/index.js';
import { SCOI_CONTEXT_STATES } from '../scoi/states.js';
import { InvariantType } from '../types.js';

const score01 = z.number().min(0).max(1);
const nonNegative = z.number().nonnegative();
const nonNegativeInt = z.number().int().nonnegative();

export const meriScoreVectorSchema = z
  .object({
    meri: score01,
    marginal_gains: z.record(z.string(), nonNegative),
    approximation: z.boolean(),
    per_class_bounds: z.record(z.string(), z.number().int().positive()),
    group_ids: z.array(z.string()),
  })
  .strict();
export type MeriScoreVector = z.infer<typeof meriScoreVectorSchema>;

export const mfciScoreVectorSchema = z
  .object({
    mfci: nonNegative,
    p_hat: z.number().gt(0).lte(1),
    statistic: z.enum(MFCI_STATISTICS),
    sample_count: nonNegativeInt,
    fixed_margins_ref: z.string().min(1),
    risk_state: z.enum(MFCI_RISK_STATES),
  })
  .strict();
export type MfciScoreVector = z.infer<typeof mfciScoreVectorSchema>;

export const gweiScoreVectorSchema = z
  .object({
    gw2: nonNegative,
    ci_low: nonNegative,
    ci_high: nonNegative,
    seed_count: z.number().int().positive(),
    regularization: z.number().positive(),
    cohort_a: z.string().min(1),
    cohort_b: z.string().min(1),
    metric_breakdown: z.record(z.string(), z.number()),
  })
  .strict()
  .refine((v) => v.ci_low <= v.gw2 && v.gw2 <= v.ci_high, {
    message: 'gw2 must lie within [ci_low, ci_high]',
  });
export type GweiScoreVector = z.infer<typeof gweiScoreVectorSchema>;

export const scoiScoreVectorSchema = z
  .object({
    scoi: score01,
    normalizer: nonNegative,
    overlap_count: nonNegativeInt,
    lens_count: nonNegativeInt,
    context_state: z.enum(SCOI_CONTEXT_STATES),
    per_overlap_energy: z.record(z.string(), nonNegative),
  })
  .strict();
export type ScoiScoreVector = z.infer<typeof scoiScoreVectorSchema>;

/** PHI: gauge-invariant fields ONLY (enforced again at the PHI boundary). */
export const phiScoreVectorSchema = z
  .object({
    phi: nonNegative,
    rotation_angles: z.array(z.number().min(0).max(Math.PI)),
    loop_path: z.array(z.string()),
    fallback_log: z.boolean(),
    sensitive: z.boolean(),
    trace: z.number().optional(),
    loop_length: nonNegativeInt.optional(),
  })
  .strict();
export type PhiScoreVector = z.infer<typeof phiScoreVectorSchema>;

export const hodgeScoreVectorSchema = z
  .object({
    gradient_magnitude: nonNegative,
    curl_magnitude: nonNegative,
    harmonic_magnitude: nonNegative,
    harmonic_fraction: score01,
    harmful_tension_risk: score01,
    label: z.enum(HODGE_THREAD_LABELS),
  })
  .strict();
export type HodgeScoreVector = z.infer<typeof hodgeScoreVectorSchema>;

export const tropicalScoreVectorSchema = z
  .object({
    synchronized_fraction: score01,
    arrival_profile_rank: nonNegativeInt,
    seed_count: nonNegativeInt,
    coordinated_drop_count: nonNegativeInt,
    detected: z.boolean(),
  })
  .strict();
export type TropicalScoreVector = z.infer<typeof tropicalScoreVectorSchema>;

export const braidScoreVectorSchema = z
  .object({
    crossing_number: nonNegativeInt,
    entropy: nonNegative,
    crossing_rate: nonNegative,
    strands: nonNegativeInt,
    manufactured_churn: z.boolean(),
    threshold_gaming_count: nonNegativeInt,
  })
  .strict();
export type BraidScoreVector = z.infer<typeof braidScoreVectorSchema>;

export const reebScoreVectorSchema = z
  .object({
    peak_count: nonNegativeInt,
    merge_count: nonNegativeInt,
    split_count: nonNegativeInt,
    fragile_saddle_count: nonNegativeInt,
    final_basin_count: nonNegativeInt,
  })
  .strict();
export type ReebScoreVector = z.infer<typeof reebScoreVectorSchema>;

export const cidScoreVectorSchema = z
  .object({
    cid: nonNegative,
    element_count: z.number().int().positive(),
    threshold: z.number().positive(),
    blocked: z.boolean(),
  })
  .strict();
export type CidScoreVector = z.infer<typeof cidScoreVectorSchema>;

export const pathSignatureScoreVectorSchema = z
  .object({
    classification: z.enum(SESSION_HEALTH_CLASSES),
    event_count: nonNegativeInt,
    distinct_topics: nonNegativeInt,
    deep_action_share: score01,
    rapid_return_count: nonNegativeInt,
    action_time_area: z.number(),
  })
  .strict();
export type PathSignatureScoreVector = z.infer<typeof pathSignatureScoreVectorSchema>;

/** PWAtt (WS-E shadow scorer): flat named numeric components. */
export const pwattScoreVectorSchema = z.record(z.string().min(1).max(64), z.number());

/** Registry: invariant type → its score-vector schema. */
export const SCORE_VECTOR_SCHEMAS: Readonly<Record<InvariantType, z.ZodType>> = {
  [InvariantType.MERI]: meriScoreVectorSchema,
  [InvariantType.MFCI]: mfciScoreVectorSchema,
  [InvariantType.GWEI]: gweiScoreVectorSchema,
  [InvariantType.SCOI]: scoiScoreVectorSchema,
  [InvariantType.PHI]: phiScoreVectorSchema,
  [InvariantType.HodgeTension]: hodgeScoreVectorSchema,
  [InvariantType.TropicalCascade]: tropicalScoreVectorSchema,
  [InvariantType.BraidDynamics]: braidScoreVectorSchema,
  [InvariantType.ReebLandscape]: reebScoreVectorSchema,
  [InvariantType.CounterfactualDefect]: cidScoreVectorSchema,
  [InvariantType.PathSignatureWellbeing]: pathSignatureScoreVectorSchema,
};

/**
 * Validate a score vector for an invariant type. PWAtt families
 * (`PWAtt_v0`, `PWAtt_v1`, …) validate as flat numeric records; unknown
 * types are rejected (fail closed).
 */
export function validateScoreVector(
  invariantType: string,
  vector: unknown,
): { ok: true } | { ok: false; problem: string } {
  if (invariantType.startsWith('PWAtt')) {
    const result = pwattScoreVectorSchema.safeParse(vector);
    return result.success
      ? { ok: true }
      : { ok: false, problem: result.error.issues[0]?.message ?? 'invalid PWAtt vector' };
  }
  const schema = SCORE_VECTOR_SCHEMAS[invariantType as InvariantType];
  if (!schema) return { ok: false, problem: `unknown invariant type '${invariantType}'` };
  const result = schema.safeParse(vector);
  if (result.success) return { ok: true };
  const issue = result.error.issues[0];
  return {
    ok: false,
    problem: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid score vector'}`,
  };
}

/** Wrapper carrying the discriminator, for consumers that route by type. */
export const typedScoreVectorSchema = z.discriminatedUnion('invariant_type', [
  z.object({ invariant_type: z.literal(InvariantType.MERI), score_vector: meriScoreVectorSchema }),
  z.object({ invariant_type: z.literal(InvariantType.MFCI), score_vector: mfciScoreVectorSchema }),
  z.object({ invariant_type: z.literal(InvariantType.GWEI), score_vector: gweiScoreVectorSchema }),
  z.object({ invariant_type: z.literal(InvariantType.SCOI), score_vector: scoiScoreVectorSchema }),
  z.object({ invariant_type: z.literal(InvariantType.PHI), score_vector: phiScoreVectorSchema }),
  z.object({
    invariant_type: z.literal(InvariantType.HodgeTension),
    score_vector: hodgeScoreVectorSchema,
  }),
  z.object({
    invariant_type: z.literal(InvariantType.TropicalCascade),
    score_vector: tropicalScoreVectorSchema,
  }),
  z.object({
    invariant_type: z.literal(InvariantType.BraidDynamics),
    score_vector: braidScoreVectorSchema,
  }),
  z.object({
    invariant_type: z.literal(InvariantType.ReebLandscape),
    score_vector: reebScoreVectorSchema,
  }),
  z.object({
    invariant_type: z.literal(InvariantType.CounterfactualDefect),
    score_vector: cidScoreVectorSchema,
  }),
  z.object({
    invariant_type: z.literal(InvariantType.PathSignatureWellbeing),
    score_vector: pathSignatureScoreVectorSchema,
  }),
]);
export type TypedScoreVector = z.infer<typeof typedScoreVectorSchema>;
