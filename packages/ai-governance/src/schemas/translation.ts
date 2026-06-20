// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Translation pipeline (WS-K.2.1a, SPEC §15.5/§24.1). Translations carry a
// persistent "AI-translated" label and ALWAYS preserve access to the original,
// which remains the canonical content — the translation never replaces or hides
// it (the `source_ref` is non-null by construction). Translations are
// consistency-checked (WS-K.1.2b) so a translation cannot introduce content
// absent from the source, write an `AIOutputRecord`, and are user-reportable.
import { z } from 'zod';
import { refIdSchema, semverSchema, shortTextSchema } from './common.js';

/** What a translation can be applied to (the original stays canonical). */
export const TRANSLATION_SOURCE_KINDS = [
  'story',
  'contribution',
  'summary',
  'governance_summary',
] as const;
export type TranslationSourceKind = (typeof TRANSLATION_SOURCE_KINDS)[number];
export const translationSourceKindSchema = z.enum(TRANSLATION_SOURCE_KINDS);

/** A BCP-47-ish language tag (lower-cased, 2-16 chars). */
export const languageTagSchema = z
  .string()
  .min(2)
  .max(16)
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i, 'language must be a BCP-47-like tag');

export const aiTranslationSchema = z
  .object({
    translation_id: refIdSchema,
    source_kind: translationSourceKindSchema,
    /** The canonical original content id — always present and accessible. */
    source_ref: refIdSchema,
    source_lang: languageTagSchema,
    target_lang: languageTagSchema,
    translated_text: z.string().min(1).max(20_000),
    /** Pinned label — translations are always AI-translated. */
    label: z.literal('AI-translated'),
    /** Whether the source/translation consistency check passed (WS-K.1.2b). */
    consistency_passed: z.boolean(),
    model_name: shortTextSchema,
    model_version: semverSchema,
    output_id: refIdSchema,
    translated_at: z.string().datetime(),
  })
  .strict()
  .refine((t) => t.source_lang !== t.target_lang, {
    message: 'source and target language must differ',
    path: ['target_lang'],
  });
export type AiTranslation = z.infer<typeof aiTranslationSchema>;

export const TRANSLATION_REPORT_REASONS = [
  'mistranslation',
  'added_content',
  'offensive',
  'other',
] as const;
export type TranslationReportReason = (typeof TRANSLATION_REPORT_REASONS)[number];
export const translationReportReasonSchema = z.enum(TRANSLATION_REPORT_REASONS);

export const translationReportSchema = z
  .object({
    report_id: refIdSchema,
    translation_id: refIdSchema,
    reason: translationReportReasonSchema,
    reported_at: z.string().datetime(),
  })
  .strict();
export type TranslationReport = z.infer<typeof translationReportSchema>;
