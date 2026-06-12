// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.6a — the explanation template system (SPEC §13.5/§13.6). Every
// user-facing distribution reason renders from a registered, parameterized
// template; free-form strings cannot reach the wire. Templates are selected
// by PRIORITY (most relevant wins) and validated against their parameter
// schema at render time. The Section 13.6 prohibited phrasings ("because of
// the algorithm", "trending", "popular", …) and the §30.6 endorsement
// vocabulary ("endorse", "boost", …) live here as the SHARED artifact that
// neutrality test 9 (WS-I.3.1i) scans — render output is asserted against the
// same list, so a template that would emit prohibited language fails closed
// at render, in tests, and in CI alike.
//
// Constraint/safety templates are deliberately non-specific: they never carry
// raw statistics or thresholds (revealing detection internals aids evasion,
// SPEC §8.6).

import { z } from 'zod';

/** §13.6 + §30.6 prohibited explanation vocabulary (case-insensitive). */
export const PROHIBITED_EXPLANATION_PATTERNS: readonly RegExp[] = [
  /because of the algorithm/i,
  /\btrending\b/i,
  /\bpopular\b/i,
  /\brecommended for you\b/i,
  /\bgoing viral\b/i,
  /\bendorse(?:s|d|ment)?\b/i,
  /\bboost(?:s|ed|ing)?\b/i,
  /\bpromot(?:e|es|ed|ing|ion)\b/i,
  /\bvote for quality\b/i,
  /\bsupport means better\b/i,
];

/** True when a rendered explanation violates the prohibited-language list. */
export function violatesProhibitedLanguage(text: string): boolean {
  return PROHIBITED_EXPLANATION_PATTERNS.some((pattern) => pattern.test(text));
}

export const TEMPLATE_CATEGORIES = ['positive', 'contextual', 'constraint', 'safety'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/**
 * Locales the explanation renderer can produce (WS-I.2.6a "localization-
 * ready"). The template render functions ARE the `en` catalog; additional
 * locales either provide a per-template override in {@link LOCALE_CATALOGS}
 * or — for `x-pseudo`, the standard localization-readiness proof — derive
 * deterministically from the English rendering. Real translation catalogs
 * slot into LOCALE_CATALOGS without touching any template.
 */
export const RANKING_EXPLANATION_LOCALES = ['en', 'x-pseudo'] as const;
export type ExplanationLocale = (typeof RANKING_EXPLANATION_LOCALES)[number];

/** Per-locale, per-template overrides (empty until translations exist). */
export const LOCALE_CATALOGS: Readonly<
  Partial<Record<ExplanationLocale, Readonly<Record<string, (params: never) => string>>>>
> = {};

const PSEUDO_MAP: Readonly<Record<string, string>> = {
  a: 'á',
  e: 'é',
  i: 'í',
  o: 'ó',
  u: 'ú',
  y: 'ý',
  A: 'Á',
  E: 'É',
  I: 'Í',
  O: 'Ó',
  U: 'Ú',
  Y: 'Ý',
};

/** Deterministic pseudo-localization: accents vowels, brackets the string,
 *  preserves digits and punctuation (so parameter values stay readable). */
export function pseudoLocalize(text: string): string {
  let out = '';
  for (const char of text) out += PSEUDO_MAP[char] ?? char;
  return `⟦${out}⟧`;
}

export interface ExplanationTemplate<P = Record<string, unknown>> {
  templateId: string;
  category: TemplateCategory;
  signalType: string;
  /** Higher priority wins when several templates apply (WS-I.2.6a). */
  priority: number;
  /** i18n catalog key (WS-B i18n; English source string rendered here). */
  i18nKey: string;
  paramsSchema: z.ZodType<P>;
  render(params: P): string;
}

/** Thrown when params fail the template's schema. */
export class ExplanationParamError extends Error {
  constructor(templateId: string, detail: string) {
    super(`invalid params for explanation template "${templateId}": ${detail}`);
    this.name = 'ExplanationParamError';
  }
}

/** Thrown when a render would emit prohibited language (structural block). */
export class ProhibitedExplanationError extends Error {
  constructor(templateId: string, rendered: string) {
    super(`template "${templateId}" rendered prohibited language: "${rendered}"`);
    this.name = 'ProhibitedExplanationError';
  }
}

function defineTemplate<P>(template: ExplanationTemplate<P>): ExplanationTemplate<P> {
  return template;
}

const count = z.number().int().nonnegative();

// --- Positive signals -------------------------------------------------------

export const TPL_EVIDENCE_RISING = defineTemplate({
  templateId: 'positive.evidence_rising',
  category: 'positive',
  signalType: 'constructive_participation',
  priority: 90,
  i18nKey: 'explain.positive.evidence_rising',
  paramsSchema: z.object({ roomCount: count.min(1), evidenceCount: count.min(1) }).strict(),
  // Room counts are only CLAIMED when genuinely multi-room (threads are
  // currently 1:1 with stories, so roomCount is usually 1 — the single-room
  // variant makes no count claim rather than saying "readers in 1 room").
  render: ({ roomCount, evidenceCount }) => {
    const cards = `${evidenceCount} independent ${evidenceCount === 1 ? 'evidence card' : 'evidence cards'}`;
    return roomCount > 1
      ? `Rising because readers in ${roomCount} rooms opened the source and added ${cards}.`
      : `Rising because readers opened the source and added ${cards}.`;
  },
});

export const TPL_SOURCE_OPENS = defineTemplate({
  templateId: 'positive.source_opens',
  category: 'positive',
  signalType: 'active_attention',
  priority: 70,
  i18nKey: 'explain.positive.source_opens',
  paramsSchema: z.object({}).strict(),
  render: () => 'Shown because readers are opening the original source, not just the headline.',
});

export const TPL_INDEPENDENT_SOURCE = defineTemplate({
  templateId: 'positive.independent_source',
  category: 'positive',
  signalType: 'exposure_independence',
  priority: 80,
  i18nKey: 'explain.positive.independent_source',
  paramsSchema: z.object({}).strict(),
  render: () => 'Shown as an independent source on a story you have been following.',
});

export const TPL_BRIDGE_ACTIVE = defineTemplate({
  templateId: 'positive.bridge_active',
  category: 'positive',
  signalType: 'context_coherence_gain',
  priority: 75,
  i18nKey: 'explain.positive.bridge_active',
  paramsSchema: z.object({}).strict(),
  render: () => 'Shown because bridge work between communities is improving shared context.',
});

export const TPL_FRESH_DIVERSITY = defineTemplate({
  templateId: 'positive.fresh_diversity',
  category: 'positive',
  signalType: 'diversity_quota',
  priority: 40,
  i18nKey: 'explain.positive.fresh_diversity',
  paramsSchema: z.object({}).strict(),
  render: () => 'Shown from outside your usual topics to preserve source diversity.',
});

export const TPL_RECENT_SUBMISSION = defineTemplate({
  templateId: 'positive.recent_submission',
  category: 'positive',
  signalType: 'freshness',
  priority: 30,
  i18nKey: 'explain.positive.recent_submission',
  paramsSchema: z.object({}).strict(),
  render: () => 'Recently submitted and gathering its first independent readers.',
});

// --- Contextual signals ------------------------------------------------------

export const TPL_INTERPRETATIONS_DIFFER = defineTemplate({
  templateId: 'contextual.interpretations_differ',
  category: 'contextual',
  signalType: 'scoi_context',
  priority: 85,
  i18nKey: 'explain.contextual.interpretations_differ',
  paramsSchema: z.object({}).strict(),
  render: () => 'Shown with context because communities are interpreting this differently.',
});

export const TPL_LENS_DIVERSITY = defineTemplate({
  templateId: 'contextual.lens_diversity',
  category: 'contextual',
  signalType: 'lens_balance',
  priority: 45,
  i18nKey: 'explain.contextual.lens_diversity',
  paramsSchema: z.object({ lensCount: count.min(2) }).strict(),
  render: ({ lensCount }) => `Shown to include all ${lensCount} active lenses on this discussion.`,
});

// --- Constraint signals ------------------------------------------------------

export const TPL_REPEATED_CLAIM = defineTemplate({
  templateId: 'constraint.repeated_claim',
  category: 'constraint',
  signalType: 'meri_redundancy',
  priority: 60,
  i18nKey: 'explain.constraint.repeated_claim',
  paramsSchema: z.object({}).strict(),
  render: () =>
    'Lower in your feed because it repeats a claim you have already seen from the same source lineage.',
});

export const TPL_MFCI_SLOWED = defineTemplate({
  templateId: 'constraint.mfci_slowed',
  category: 'constraint',
  signalType: 'mfci_coordination',
  priority: 95,
  i18nKey: 'explain.constraint.mfci_slowed',
  paramsSchema: z.object({}).strict(),
  render: () => 'Distribution is slowed because synchronized activity is under review.',
});

export const TPL_CASCADE_SLOWED = defineTemplate({
  templateId: 'constraint.cascade_slowed',
  category: 'constraint',
  signalType: 'tropical_cascade',
  priority: 94,
  i18nKey: 'explain.constraint.cascade_slowed',
  paramsSchema: z.object({}).strict(),
  render: () =>
    'This topic is receiving unusual synchronized activity. Distribution is slowed while reviewed.',
});

export const TPL_PHI_BROADER = defineTemplate({
  templateId: 'constraint.phi_broader',
  category: 'constraint',
  signalType: 'phi_holonomy',
  priority: 65,
  i18nKey: 'explain.constraint.phi_broader',
  paramsSchema: z.object({}).strict(),
  render: () =>
    'Your recent feed has become narrow around this topic, so broader context is included.',
});

export const TPL_REPORT_TIMING = defineTemplate({
  templateId: 'constraint.report_timing',
  category: 'constraint',
  signalType: 'coordinated_reporting',
  priority: 93,
  i18nKey: 'explain.constraint.report_timing',
  paramsSchema: z.object({}).strict(),
  render: () => 'Reporting impact is delayed because report timing is unusual.',
});

// --- Safety signals ----------------------------------------------------------

export const TPL_UNDER_REVIEW = defineTemplate({
  templateId: 'safety.under_review',
  category: 'safety',
  signalType: 'integrity_review',
  priority: 96,
  i18nKey: 'explain.safety.under_review',
  paramsSchema: z.object({}).strict(),
  render: () => 'This thread is temporarily under integrity review.',
});

// --- Fallback (WS-I.4.1b honest "ranking paused" reason) ---------------------

export const TPL_RANKING_PAUSED = defineTemplate({
  templateId: 'fallback.ranking_paused',
  category: 'safety',
  signalType: 'ranking_paused',
  priority: 100,
  i18nKey: 'explain.fallback.ranking_paused',
  paramsSchema: z.object({}).strict(),
  render: () => 'Shown in time order while ranking is paused.',
});

export const TPL_CHRONOLOGICAL = defineTemplate({
  templateId: 'fallback.chronological',
  category: 'positive',
  signalType: 'chronological_mode',
  priority: 100,
  i18nKey: 'explain.fallback.chronological',
  paramsSchema: z.object({}).strict(),
  render: () => 'Shown in time order, as your feed mode requests.',
});

/** The closed template registry, keyed by template id. */
export const EXPLANATION_TEMPLATES: ReadonlyMap<string, ExplanationTemplate<never>> = new Map(
  (
    [
      TPL_EVIDENCE_RISING,
      TPL_SOURCE_OPENS,
      TPL_INDEPENDENT_SOURCE,
      TPL_BRIDGE_ACTIVE,
      TPL_FRESH_DIVERSITY,
      TPL_RECENT_SUBMISSION,
      TPL_INTERPRETATIONS_DIFFER,
      TPL_LENS_DIVERSITY,
      TPL_REPEATED_CLAIM,
      TPL_MFCI_SLOWED,
      TPL_CASCADE_SLOWED,
      TPL_PHI_BROADER,
      TPL_REPORT_TIMING,
      TPL_UNDER_REVIEW,
      TPL_RANKING_PAUSED,
      TPL_CHRONOLOGICAL,
    ] as const
  ).map((template) => [template.templateId, template as ExplanationTemplate<never>]),
);

/**
 * Render a template with validated params; throws on schema failure and on
 * prohibited output (defense in depth — the static suite scans sources, this
 * guard catches dynamic composition). The prohibited-language guard runs on
 * the CANONICAL English rendering (the §13.6/§30.6 vocabulary is English
 * doctrine); the locale rendering derives from the guarded string.
 */
export function renderTemplate(
  templateId: string,
  params: unknown,
  locale: ExplanationLocale = 'en',
): string {
  const template = EXPLANATION_TEMPLATES.get(templateId);
  if (template === undefined) {
    throw new ExplanationParamError(templateId, 'unknown template id');
  }
  const parsed = (template.paramsSchema as z.ZodType<unknown>).safeParse(params);
  if (!parsed.success) {
    throw new ExplanationParamError(
      templateId,
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  const rendered = (template.render as (p: unknown) => string)(parsed.data);
  if (violatesProhibitedLanguage(rendered)) {
    throw new ProhibitedExplanationError(templateId, rendered);
  }
  if (locale === 'en') return rendered;
  const override = LOCALE_CATALOGS[locale]?.[templateId];
  if (override !== undefined) {
    const localized = (override as (p: unknown) => string)(parsed.data);
    return localized;
  }
  // x-pseudo (and any locale without an override) derives from English.
  return pseudoLocalize(rendered);
}
