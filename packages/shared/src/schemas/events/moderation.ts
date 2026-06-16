// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Moderation and integrity events (WS-E.1.1d, SPEC §18.1/§18.2/§21.3).
// `reporter_id` is the highest-sensitivity field in the pipeline: the topic is
// `restricted` and reporter identity must never appear in any public,
// peer-visible, or aggregated output (SPEC §19.5). `integrity.signal.detected`
// topics are inputs to safety freezes and are protected so adversaries cannot
// learn detection thresholds.
import { z } from 'zod';
import { uuidSchema } from '../common.js';
import { eventBaseShape } from './envelope.js';

/**
 * The twelve moderation policy categories (SPEC §18.1), as stable namespaces.
 * Reason codes are `<NAMESPACE>_NNN` per the WS-A taxonomy
 * (docs/policy/MODERATION_TAXONOMY.md, the SSOT validated by `check:policy`).
 * This is EXACTLY the §18.1 content-category set (pinned by `moderation-policy-
 * drift`); the crypto-abuse plane (`MOD_CRYPTO_*`, WS-A.1.2d / §18.5) is a
 * separate namespace accepted by {@link moderationReasonCodeSchema} below.
 */
export const MODERATION_CATEGORY_IDS = [
  'MOD_ILLEGAL',
  'MOD_THREAT',
  'MOD_HARASS',
  'MOD_HATE',
  'MOD_CSE',
  'MOD_GRAPHIC',
  'MOD_MISINFO',
  'MOD_IMPERS',
  'MOD_SPAM',
  'MOD_PRIVACY',
  'MOD_SYNTH',
  'MOD_IP',
] as const;

/**
 * The crypto-abuse plane namespace (SPEC §18.5 / WS-A.1.2d).  Ratified crypto
 * reason codes are `MOD_CRYPTO_<MODE>_NNN`, whose first `MOD_<WORD>` segment is
 * `MOD_CRYPTO`.  Accepted by the event reason-code validator alongside the
 * §18.1 categories so a crypto-abuse report's `moderation.case.created` event
 * parses (the report path enforces exact ratified membership upstream).
 */
const MODERATION_CRYPTO_NAMESPACE = 'MOD_CRYPTO';
export type ModerationCategoryId = (typeof MODERATION_CATEGORY_IDS)[number];

// `MOD_<NAMESPACE>_<SUFFIX>` where the suffix is the rest of the code: a numeric
// id (`MOD_HARASS_001`) OR a mode mnemonic plus id (the crypto-abuse codes are
// `MOD_CRYPTO_DRAIN_001` etc.).  The namespace is the FIRST `MOD_<WORD>` segment
// (`[A-Z]+` stops at the underscore), so crypto codes resolve to `MOD_CRYPTO`.
// The report path enforces EXACT ratified membership upstream
// (contributionReasonCodeSchema); this stays shape + namespace only.
const REASON_CODE_PATTERN = /^(MOD_[A-Z]+)_([A-Z0-9_]+)$/;

/**
 * A reason code from the WS-A moderation taxonomy: `MOD_<NAMESPACE>_<SUFFIX>`
 * where the namespace is one of the §18.1 categories. The code list itself is
 * owned by the policy document; this validates shape + category membership so
 * an unknown category can never enter the pipeline.
 */
export const moderationReasonCodeSchema = z
  .string()
  .regex(REASON_CODE_PATTERN, { message: 'reason_code must be MOD_<CATEGORY>_<SUFFIX>' })
  .refine(
    (code) => {
      const namespace = REASON_CODE_PATTERN.exec(code)?.[1];
      return (
        namespace !== undefined &&
        ((MODERATION_CATEGORY_IDS as readonly string[]).includes(namespace) ||
          namespace === MODERATION_CRYPTO_NAMESPACE)
      );
    },
    { message: 'reason_code namespace must be a SPEC §18.1 category or the crypto plane' },
  );

export const MODERATION_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ModerationSeverity = (typeof MODERATION_SEVERITIES)[number];
export const moderationSeveritySchema = z.enum(MODERATION_SEVERITIES);

export const MODERATION_CASE_SOURCES = [
  'user_report',
  'automated',
  'steward',
  'integrity_review',
] as const;
export type ModerationCaseSource = (typeof MODERATION_CASE_SOURCES)[number];

/** Emitted when a report or automated detection opens a moderation case. */
export const moderationCaseCreatedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('moderation.case.created'),
    case_id: uuidSchema,
    target_type: z.enum(['contribution', 'thread', 'story', 'user', 'room']),
    target_id: uuidSchema,
    /** Null for automated detection. NEVER exposed outside restricted access. */
    reporter_id: uuidSchema.nullable(),
    reason_code: moderationReasonCodeSchema,
    severity: moderationSeveritySchema,
    source: z.enum(MODERATION_CASE_SOURCES),
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('moderation_legal'),
  })
  .strict();
export type ModerationCaseCreatedEvent = z.infer<typeof moderationCaseCreatedEventSchema>;

/** Integrity anti-signal types (SPEC §5.3 anti-signals, WS-E.2.2a-c). */
export const INTEGRITY_SIGNAL_TYPES = [
  'coordinated_burst',
  'rage_loop',
  'source_free_accusation',
  'brigading',
  'harassment_cascade',
] as const;
export type IntegritySignalType = (typeof INTEGRITY_SIGNAL_TYPES)[number];
export const integritySignalTypeSchema = z.enum(INTEGRITY_SIGNAL_TYPES);

/**
 * Emitted by integrity systems (burst/cascade detection, MFCI). Restricted:
 * reveals detection thresholds. Retention follows the security-log tier
 * (SPEC §22.4 "security logs: based on risk and legal requirements").
 */
export const integritySignalDetectedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('integrity.signal.detected'),
    signal_type: integritySignalTypeSchema,
    target_ids: z.array(uuidSchema).min(1).max(100),
    /** Detector confidence in [0, 1]. */
    confidence: z.number().min(0).max(1),
    /** Human-readable detector rationale; never raw attention values. */
    evidence_summary: z.string().min(1).max(2_000),
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('security_log'),
  })
  .strict();
export type IntegritySignalDetectedEvent = z.infer<typeof integritySignalDetectedEventSchema>;
