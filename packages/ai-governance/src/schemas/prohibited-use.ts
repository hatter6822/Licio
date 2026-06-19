// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Prohibited-use vocabulary (WS-K.1.1d + WS-K.2.2a, SPEC §24.1/§24.5). The five
// platform-wide prohibitions and the full capability set the `ProhibitedUseGuard`
// (../prohibited-use.ts) reasons over. Enforcement is PRE-EXECUTION: the guard
// classifies a declared invocation and blocks a prohibited one BEFORE the model
// runs, so a prohibited request never reaches a model. The capability set
// doubles as the §24.5 governance permitted/prohibited matrix.
import { z } from 'zod';
import { aiUseCaseIdSchema, refIdSchema, shortTextSchema } from './common.js';

/**
 * The five platform-wide prohibited AI uses (WS-K.1.1d). Every block maps to
 * exactly one of these so the audit trail and the security dashboard can
 * attribute it (a nonzero rate on autonomous-treasury or risk-identity-hiding
 * is a high-priority alert).
 */
export const AI_PROHIBITIONS = [
  'autonomous_treasury_execution',
  'investment_advice',
  'manipulative_voting_recommendation',
  'wealth_based_profiling',
  'risk_identity_hiding',
] as const;
export type AiProhibition = (typeof AI_PROHIBITIONS)[number];
export const aiProhibitionSchema = z.enum(AI_PROHIBITIONS);

/**
 * The full capability set: the normal pipeline capabilities, the seven §24.5
 * PERMITTED governance capabilities, and the explicitly PROHIBITED capabilities
 * (general + the six §24.5 governance prohibitions). The
 * permitted/prohibited classification is data in ../prohibited-use.ts.
 */
export const AI_CAPABILITIES = [
  // Normal content pipelines (permitted; the WS-K.1.3/1.4/2.1 use cases).
  'classify_topic',
  'extract_claim',
  'summarize_thread',
  'translate_content',
  'generate_embedding',
  'triage_safety',
  'detect_duplicate',
  // §24.5 permitted governance capabilities (advisory to stewards).
  'gov_summarize_proposal',
  'gov_identify_missing_fields',
  'gov_compare_charter',
  'gov_highlight_coi',
  'gov_translate_summary',
  'gov_explain_treasury_action',
  'gov_detect_scam_patterns',
  // General prohibited capabilities (direct-invocation oracles).
  'treasury_execute',
  'investment_advice',
  'voting_recommendation',
  'wealth_profiling',
  'risk_identity_rewrite',
  // §24.5 prohibited governance capabilities.
  'gov_autonomous_execution',
  'gov_investment_advice',
  'gov_voting_recommendation',
  'gov_wealth_profiling',
  'gov_risk_identity_rewrite',
  'gov_wealth_feed_personalization',
] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];
export const aiCapabilitySchema = z.enum(AI_CAPABILITIES);

/**
 * A declared AI invocation the guard evaluates BEFORE the model runs. The
 * structural flags are defense in depth: even a nominally permitted capability
 * is blocked if it would take autonomous effect, read wealth signals, or mask a
 * risk actor's identity. All flags default to the SAFE value when omitted.
 */
export const aiInvocationSchema = z
  .object({
    use_case_id: aiUseCaseIdSchema,
    capability: aiCapabilitySchema,
    /** The module/service making the call (audit attribution). */
    caller: shortTextSchema,
    /** Optional reference to the subject (proposal id, story id, …). */
    context_ref: refIdSchema.optional(),
    /** Whether the output takes autonomous effect or is advisory only. */
    effect: z.enum(['advisory', 'execute']).default('advisory'),
    /** Whether the invocation reads wallet/payment/treasury signals. */
    uses_wealth_signals: z.boolean().default(false),
    /** Whether the invocation attempts to mask a risk actor's identity. */
    targets_risk_identity: z.boolean().default(false),
  })
  .strict();
export type AiInvocation = z.infer<typeof aiInvocationSchema>;

/** The guard decision (allow, or block with the triggered prohibition). */
export const prohibitedUseDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow') }).strict(),
  z
    .object({
      decision: z.literal('block'),
      prohibition: aiProhibitionSchema,
      reason: shortTextSchema,
    })
    .strict(),
]);
export type ProhibitedUseDecision = z.infer<typeof prohibitedUseDecisionSchema>;

/** Immutable audit record for a blocked invocation (WS-K.1.1d observability). */
export const blockedInvocationRecordSchema = z
  .object({
    block_id: refIdSchema,
    prohibition: aiProhibitionSchema,
    use_case_id: aiUseCaseIdSchema,
    capability: aiCapabilitySchema,
    caller: shortTextSchema,
    context_ref: refIdSchema.nullable(),
    reason: shortTextSchema,
    timestamp: z.string().datetime(),
  })
  .strict();
export type BlockedInvocationRecord = z.infer<typeof blockedInvocationRecordSchema>;
