// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K shared primitives (SPEC §24). The vocabulary every AI-governance record
// keys on: risk levels and human-oversight levels (the NIST AI RMF posture,
// WS-K.1.1c), model modality (drives evaluation-set selection in the harness,
// WS-K.1.2e), and the eight canonical AI use cases (WS-K.1.1c inventory). All
// schemas are zod-defined and co-located with their types so the client and
// server validate identically.
import { z } from 'zod';

/** Semantic-version string (major.minor.patch) — shared with InvariantCard. */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const semverSchema = z
  .string()
  .regex(SEMVER_PATTERN, 'version must be semver (major.minor.patch)');

/**
 * NIST AI RMF risk levels (WS-K.1.1c). Ordered by potential impact of errors;
 * the index in this tuple IS the severity order, used to gate the harness's
 * required-evaluation set (high/critical require the full set, WS-K.1.2e).
 */
export const AI_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type AiRiskLevel = (typeof AI_RISK_LEVELS)[number];
export const aiRiskLevelSchema = z.enum(AI_RISK_LEVELS);

/**
 * Human-oversight levels (WS-K.1.1c). `none` for low-risk automation, `review`
 * (steward review queue) for medium, `approval` (human must approve before
 * effect) for high, `prohibited` for critical (the AI may never act here).
 */
export const HUMAN_OVERSIGHT_LEVELS = ['none', 'review', 'approval', 'prohibited'] as const;
export type HumanOversightLevel = (typeof HUMAN_OVERSIGHT_LEVELS)[number];
export const humanOversightLevelSchema = z.enum(HUMAN_OVERSIGHT_LEVELS);

/**
 * Model modality (WS-K.1.2e). Selects which evaluations apply: `generation`
 * models get hallucination + safety + red-team; `classification` models get
 * bias + safety; `embedding` models get bias only. A model may serve more than
 * one modality.
 */
export const AI_MODALITIES = ['classification', 'generation', 'embedding'] as const;
export type AiModality = (typeof AI_MODALITIES)[number];
export const aiModalitySchema = z.enum(AI_MODALITIES);

/**
 * The eight canonical AI use cases (WS-K.1.1c inventory table, SPEC §24.1).
 * Stable identifiers — the inventory, model cards, output records, and the
 * prohibited-use guard all key on these.
 */
export const AI_USE_CASE_IDS = [
  'topic_classification',
  'duplicate_detection',
  'claim_extraction',
  'toxicity_safety_triage',
  'summarization',
  'translation',
  'embedding_generation',
  'governance_assistance',
  // WS-T — the sourced-correction debate adjudicator (a governed probabilistic
  // neural model that scores which of two sourced positions prevails).
  'debate_adjudication',
] as const;
export type AiUseCaseId = (typeof AI_USE_CASE_IDS)[number];
export const aiUseCaseIdSchema = z.enum(AI_USE_CASE_IDS);

/**
 * A non-empty, length-bounded reference id (data-lineage refs, risk-assessment
 * refs, privacy-review refs, prompt-template ids). References are opaque keys
 * the registry resolves against existing records (WS-K.1.1a acceptance).
 */
export const refIdSchema = z.string().min(1).max(256);

/** A short non-empty human-readable string (names, owners, reasons). */
export const shortTextSchema = z.string().min(1).max(256);

/** A bounded prose field (descriptions, summaries, justifications). */
export const proseSchema = z.string().min(1).max(8_000);
