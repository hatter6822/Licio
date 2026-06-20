// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NIST AI RMF / ISO/IEC 42001 risk assessment (WS-K.1.1c, SPEC §24.1/§24.2).
// A standalone, referenceable record: the model card links it by
// `risk_assessment_ref`, and the AI inventory use-case entry references the same
// record, so a model's documented risk posture has one source of truth. The
// `affected_populations` field feeds the bias-audit subgroup selection
// (WS-K.1.2a). The assessment maps to NIST AI RMF GOVERN/MAP/MEASURE/MANAGE
// functions and ISO/IEC 42001 controls.
import { z } from 'zod';
import {
  aiRiskLevelSchema,
  aiUseCaseIdSchema,
  humanOversightLevelSchema,
  proseSchema,
  refIdSchema,
  semverSchema,
  shortTextSchema,
} from './common.js';

/** Qualitative likelihood/impact band for an identified harm. */
export const HARM_BANDS = ['low', 'medium', 'high'] as const;
export const harmBandSchema = z.enum(HARM_BANDS);

/** The four NIST AI RMF core functions (SPEC §24.2). */
export const NIST_RMF_FUNCTIONS = ['GOVERN', 'MAP', 'MEASURE', 'MANAGE'] as const;
export type NistRmfFunction = (typeof NIST_RMF_FUNCTIONS)[number];
export const nistRmfFunctionSchema = z.enum(NIST_RMF_FUNCTIONS);

/** One identified harm with its likelihood and impact bands. */
export const identifiedHarmSchema = z
  .object({
    harm: shortTextSchema,
    likelihood: harmBandSchema,
    impact: harmBandSchema,
  })
  .strict();
export type IdentifiedHarm = z.infer<typeof identifiedHarmSchema>;

export const riskAssessmentSchema = z
  .object({
    assessment_id: refIdSchema,
    use_case_id: aiUseCaseIdSchema,
    version: semverSchema,
    /** Overall residual risk level after mitigations (NIST MANAGE). */
    risk_level: aiRiskLevelSchema,
    /** The enforced human-oversight posture for this use case (WS-K.1.1d). */
    human_oversight: humanOversightLevelSchema,
    /** Identified harms with likelihood/impact (NIST MAP/MEASURE). */
    identified_harms: z.array(identifiedHarmSchema).min(1),
    /** Populations the use case may disproportionately affect — drives the
     *  bias-audit subgroup selection (WS-K.1.2a). */
    affected_populations: z.array(shortTextSchema).min(1),
    /** Mitigations applied (NIST MANAGE). */
    mitigations: z.array(shortTextSchema).min(1),
    /** Residual risk after mitigations, in prose. */
    residual_risk: proseSchema,
    /** Named accountable owner — never a service account (NIST GOVERN). */
    responsible_owner: shortTextSchema,
    /** Which NIST AI RMF functions the assessment addresses. */
    nist_rmf_functions: z.array(nistRmfFunctionSchema).min(1),
    /** ISO/IEC 42001 control references this assessment maps to. */
    iso_42001_controls: z.array(shortTextSchema).min(1),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();
export type RiskAssessment = z.infer<typeof riskAssessmentSchema>;
