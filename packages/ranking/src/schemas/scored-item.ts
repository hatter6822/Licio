// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3e — the `ScoredItem` stage boundary (SPEC §13.4). Every scored item
// carries its FULL breakdown — baseline parts, weighted positive components,
// per-penalty value/coefficient/applied/enforced, and constraint flags — so
// the decision log can reproduce the arithmetic exactly and explanations can
// reference real signal values (WS-I.2.6b consistency).

import { z } from 'zod';

const unit = z.number().min(0).max(1);

/** Baseline breakdown (WS-I.2.3d). */
export const baselineBreakdownSchema = z
  .object({
    freshness_decay: unit,
    source_reliability: unit,
    /** Null when personalization is off or the user is signed out. */
    topic_relevance: unit.nullable(),
    /** The combined baseline B, same scale as the positive score. */
    value: unit,
  })
  .strict();
export type BaselineBreakdown = z.infer<typeof baselineBreakdownSchema>;

/** Positive-component breakdown: raw component values and applied weights. */
export const scoreComponentsSchema = z
  .object({
    /** Component values actually used (absent feature ⇒ 0 contribution). */
    active_attention: unit.nullable(),
    constructive_participation: unit.nullable(),
    exposure_independence: unit.nullable(),
    source_evidence_completeness: unit.nullable(),
    context_coherence_gain: unit.nullable(),
    /** The §5.5 integer weights of the profile that scored this item. */
    weights: z
      .object({
        wA: z.number().int(),
        wP: z.number().int(),
        wE: z.number().int(),
        wS: z.number().int(),
        wC: z.number().int(),
      })
      .strict(),
    /** B + weighted convex combination (before penalties). */
    positive: z.number(),
  })
  .strict();
export type ScoreComponents = z.infer<typeof scoreComponentsSchema>;

/** One penalty term with its enforcement provenance (WS-H promotion gate). */
export const penaltyTermSchema = z
  .object({
    /** The invariant-derived penalty input in [0, 1]. */
    value: unit,
    /** The profile's nonnegative coefficient. */
    coefficient: z.number().nonnegative(),
    /** coefficient × value when enforced; 0 when shadow (logged only). */
    applied: z.number().nonnegative(),
    /** False ⇒ the governing invariant is still shadow (WS-H.1.2e). */
    enforced: z.boolean(),
  })
  .strict();
export type PenaltyTerm = z.infer<typeof penaltyTermSchema>;

// No `holonomy` term: the per-item PHI holonomy penalty was removed (it read a
// `phi_risk` feature the assembler never populated, so it was always 0). PHI
// enters ranking only as the per-user diversification constraint.
export const penaltyComponentsSchema = z
  .object({
    coordination: penaltyTermSchema,
    harmful_tension: penaltyTermSchema,
    redundancy: penaltyTermSchema,
    /** WS-T — a story adjudicated `incorrect` by a sourced-correction debate.
     *  DEFAULTED so decision-log snapshots written before this term still parse
     *  + replay with identical arithmetic (the term was 0 for them). */
    dispute: penaltyTermSchema.default({ value: 0, coefficient: 0, applied: 0, enforced: false }),
    /** Sum of the applied (enforced) penalties. */
    total_applied: z.number().nonnegative(),
  })
  .strict();
export type PenaltyComponents = z.infer<typeof penaltyComponentsSchema>;

/** Constraint flags a scored item can carry (WS-I.2.3c / 2.4). The three
 *  `scoi_*` members are DEPRECATED — the SCOI constraint ladder was removed
 *  and no producer emits them; they stay ONLY so persisted decision-log
 *  `score_components` written before the removal keep parsing on replay. */
export const CONSTRAINT_FLAGS = [
  'mfci_cross_community_excluded',
  'mfci_review_flagged',
  'phi_diversify',
  'scoi_context_card',
  'scoi_reduced_distribution',
  'scoi_paused',
  'meri_cluster_capped',
  'source_share_demoted',
  'topic_share_demoted',
  'lens_balance_promoted',
] as const;
export type ConstraintFlag = (typeof CONSTRAINT_FLAGS)[number];

export const scoredItemSchema = z
  .object({
    item_id: z.string().uuid(),
    /** Final PWAtt score: baseline + positive − applied penalties, then − the
     *  dispute ordering sink + the validation boost (both WS-T). */
    pwatt_score: z.number(),
    score_components: scoreComponentsSchema,
    penalty_components: penaltyComponentsSchema,
    /** WS-T — the validation BOOST actually ADDED to `pwatt_score` for a
     *  `validated` story (challenged by a sourced correction and proven accurate).
     *  Recorded as a term (`applied` is ADDED, not subtracted) so the decision log
     *  reconciles the score and the audit surfaces the validation signal.
     *  DEFAULTED so decision-log snapshots written before this term still parse +
     *  replay identically (the term was 0 for them). */
    validation_boost: penaltyTermSchema.default({
      value: 0,
      coefficient: 0,
      applied: 0,
      enforced: false,
    }),
    baseline: baselineBreakdownSchema,
    constraint_flags: z.array(z.enum(CONSTRAINT_FLAGS)).max(16),
  })
  .strict();
export type ScoredItem = z.infer<typeof scoredItemSchema>;
