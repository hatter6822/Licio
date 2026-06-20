// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Translation pipeline (WS-K.2.1a, SPEC §15.5/§24.1). Produces a translation that
// carries the persistent AI-translated label and ALWAYS keeps the original
// (source_ref) canonical and accessible. The translation is consistency-checked
// against the source — a translation may not INTRODUCE content absent from the
// source — using a language-invariant signal (numbers/measures must not be
// invented). Writes an AIOutputRecord; users can report a bad translation.

import { randomUUID } from 'node:crypto';
import {
  type AiTranslation,
  aiTranslationSchema,
  numbersIn,
  type TranslationReport,
  type TranslationReportReason,
  type TranslationSourceKind,
  translationReportSchema,
} from '@licio/ai-governance';
import type { ProhibitedUseGuard } from './guard.js';
import type { AiGovernanceMetrics } from './metrics.js';
import { CONTENT_TRANSLATOR, type TranslationProvider } from './models.js';
import { recordAiOutput } from './output-records.js';
import type { AiOutputRecordStore, AiReviewQueueStore, TranslationStore } from './stores.js';

/**
 * Whether `translation` introduces no content absent from `source`. A
 * cross-lingual token check is unreliable, but NUMBERS/measures are language-
 * invariant: a faithful translation never invents a number the source lacks.
 * Also rejects an implausibly long expansion (a weak no-fabrication bound).
 */
export function translationConsistent(source: string, translation: string): boolean {
  const sourceNumbers = numbersIn(source);
  for (const n of numbersIn(translation)) if (!sourceNumbers.has(n)) return false;
  if (translation.length > Math.max(64, source.length * 4)) return false;
  return true;
}

export interface TranslationDeps {
  translations: TranslationStore;
  provider: TranslationProvider;
  outputRecords: AiOutputRecordStore;
  reviewQueue: AiReviewQueueStore;
  guard: ProhibitedUseGuard;
  metrics: AiGovernanceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export interface TranslateInput {
  sourceKind: TranslationSourceKind;
  sourceRef: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  /** A governance summary translation is a §24.5-permitted capability. */
  governance?: boolean;
}

/** Translate content (WS-K.2.1a). The original stays canonical and accessible. */
export async function translateContent(
  deps: TranslationDeps,
  input: TranslateInput,
): Promise<AiTranslation> {
  await deps.guard.enforce({
    use_case_id: 'translation',
    capability: input.governance ? 'gov_translate_summary' : 'translate_content',
    caller: 'translation-pipeline',
    context_ref: input.sourceRef,
    effect: 'advisory',
    uses_wealth_signals: false,
    targets_risk_identity: false,
  });

  // Reuse an existing translation for the same (source, target) — translations
  // are idempotent and the original remains canonical.
  const existing = await deps.translations.findBySource(input.sourceRef, input.targetLang);
  if (existing !== null) return existing;

  const nowIso = new Date(deps.now()).toISOString();
  const translatedText = await deps.provider.translate(
    input.sourceText,
    input.sourceLang,
    input.targetLang,
  );
  const consistencyPassed = translationConsistent(input.sourceText, translatedText);
  const output = await recordAiOutput(deps.outputRecords, {
    modelName: CONTENT_TRANSLATOR.name,
    modelVersion: CONTENT_TRANSLATOR.version,
    promptTemplateId: CONTENT_TRANSLATOR.promptTemplateId,
    config: CONTENT_TRANSLATOR.config,
    inputRefs: [input.sourceRef],
    outputRef: `${input.sourceRef}:${input.targetLang}`,
    useCaseId: 'translation',
    nowIso,
  });

  const translation = aiTranslationSchema.parse({
    translation_id: `tr-${randomUUID()}`,
    source_kind: input.sourceKind,
    source_ref: input.sourceRef,
    source_lang: input.sourceLang,
    target_lang: input.targetLang,
    translated_text: translatedText,
    label: 'AI-translated',
    consistency_passed: consistencyPassed,
    model_name: CONTENT_TRANSLATOR.name,
    model_version: CONTENT_TRANSLATOR.version,
    output_id: output.output_id,
    translated_at: nowIso,
  } satisfies AiTranslation);
  await deps.translations.put(translation);

  if (!consistencyPassed) {
    await deps.reviewQueue.insert({
      kind: 'reported_translation',
      subjectRef: translation.translation_id,
      context: { reason: 'consistency_check_failed', output_id: output.output_id },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
    });
    deps.metrics.increment('ai.translation.inconsistent');
  }
  deps.metrics.increment('ai.translation.generated');
  deps.metrics.increment(`ai.translation.generated.${input.sourceLang}-${input.targetLang}`);
  deps.log('translation.generated', {
    source_ref: input.sourceRef,
    source_lang: input.sourceLang,
    target_lang: input.targetLang,
    consistency_passed: consistencyPassed,
  });
  return translation;
}

/** A user reports a bad translation (WS-K.2.1a; routes to the correction flow). */
export async function reportTranslation(
  deps: TranslationDeps,
  translationId: string,
  reason: TranslationReportReason,
): Promise<TranslationReport | null> {
  // The target must be a real AI translation — otherwise any authenticated user
  // could pollute the steward queue + report metrics with arbitrary ids.
  if ((await deps.translations.get(translationId)) === null) return null;
  const report = translationReportSchema.parse({
    report_id: `trep-${randomUUID()}`,
    translation_id: translationId,
    reason,
    reported_at: new Date(deps.now()).toISOString(),
  } satisfies TranslationReport);
  await deps.translations.putReport(report);
  await deps.reviewQueue.insert({
    kind: 'reported_translation',
    subjectRef: translationId,
    context: { reason },
    status: 'pending',
    resolution: null,
    resolvedBy: null,
  });
  deps.metrics.increment('ai.translation.reported');
  deps.log('translation.reported', { translation_id: translationId, reason });
  return report;
}
