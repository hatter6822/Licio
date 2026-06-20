// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared deterministic text utilities for the WS-K evaluators (hallucination
// grounding, safety scanning, summary-quality checks). Pure and total — no I/O,
// no model calls — so every evaluation is reproducible (WS-K.1.2e).
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

/** Lower-cased alphanumeric tokens (Unicode letters/numbers). */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_PATTERN) ?? []).filter((t) => t.length > 0);
}

/** The set of tokens in `text`. */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** Split into sentences on terminal punctuation; trims and drops empties. */
export function sentenceSplit(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

/** Jaccard similarity of two token sets (1 when both empty). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Containment of `claim` tokens in `source` tokens: the fraction of the claim's
 * content tokens present in the source. Asymmetric on purpose — grounding asks
 * "is the claim SUPPORTED BY the source", not "are they similar".
 */
export function containment(claimTokens: Set<string>, sourceTokens: Set<string>): number {
  if (claimTokens.size === 0) return 1;
  let present = 0;
  for (const token of claimTokens) if (sourceTokens.has(token)) present += 1;
  return present / claimTokens.size;
}

/** Common English stopwords — removed before grounding so function words do not
 *  inflate containment (deterministic, small, documented set). */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'as',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'they',
  'them',
  'their',
  'he',
  'she',
  'we',
  'you',
  'i',
  'from',
  'has',
  'have',
  'had',
  'not',
  'no',
  'do',
  'does',
  'did',
  'will',
  'would',
  'can',
  'could',
  'should',
  'may',
  'might',
  'must',
  'about',
  'into',
  'over',
  'than',
  'so',
  'such',
  'up',
  'out',
  'down',
]);

/** Content tokens (stopwords removed). */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(text)) if (!STOPWORDS.has(token)) out.add(token);
  return out;
}

/** Numeric tokens appearing in `text` (for numeric-contradiction detection). */
export function numbersIn(text: string): Set<string> {
  return new Set((text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/,/g, '')));
}

/**
 * Whether `text` contains any term from `terms` as a whole word
 * (case-insensitive). Used by the no-slur-synthesis and harmful-content checks
 * with a policy-injected denylist.
 */
export function containsAnyTerm(text: string, terms: readonly string[]): string | null {
  const lower = ` ${text.toLowerCase()} `;
  for (const term of terms) {
    const t = term.toLowerCase().trim();
    if (t.length === 0) continue;
    // Whole-word match (bounded by non-alphanumerics) — avoids "scunthorpe".
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}])`, 'u');
    if (pattern.test(lower)) return term;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
