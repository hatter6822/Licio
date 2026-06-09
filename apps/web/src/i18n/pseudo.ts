// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pseudo-localization (WS-B.2.14). A pseudo-locale proves the localization
// pipeline end-to-end WITHOUT shipping unreviewed human translations: it derives
// a transformed string from the English default for EVERY rendered message, so
// any string that bypasses `t()` (or any layout that breaks under accented,
// longer text) shows up immediately.
//
// Two transforms are applied:
//   1. Accenting — each Latin letter maps to a visually-similar accented glyph
//      (Hello → Ĥéĺĺó), surfacing hard-coded copy that never reached the catalog.
//   2. Expansion — the result is bracketed and padded ~40% longer, surfacing
//      truncation/clipping bugs that only appear in verbose locales (de, fi…).
//
// Crucially the accenting runs through `formatMessage`'s `transformLiteral` hook,
// so it only touches literal text: ICU placeholders, plural/select keywords and
// substituted values are preserved (e.g. `{count, plural, …}` still selects the
// right category and "{name}" still interpolates).
import { type MessageParams, formatMessage } from './message.js';

/** BCP-47 tag for the pseudo-locale (`XA` is a user-assigned region code). */
export const PSEUDO_LOCALE = 'en-XA';

/** Whether `locale` selects the pseudo-locale. */
export function isPseudoLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith('en-xa');
}

// Visually-similar accented substitutes for each ASCII letter. Kept to single
// code points that render in common fonts so the UI stays legible while obviously
// "translated".
const ACCENT_MAP: Record<string, string> = {
  a: 'á',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ķ',
  l: 'ĺ',
  m: 'ḿ',
  n: 'ñ',
  o: 'ó',
  p: 'þ',
  q: 'ɋ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'ú',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Á',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Í',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ĺ',
  M: 'Ḿ',
  N: 'Ñ',
  O: 'Ó',
  P: 'Þ',
  Q: 'Ɋ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Ú',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
};

/** Accent the Latin letters in a literal run; leave everything else as-is. */
function accent(literal: string): string {
  let out = '';
  for (const ch of literal) out += ACCENT_MAP[ch] ?? ch;
  return out;
}

/** Bracket and pad a resolved string to ~140% length to expose truncation. */
function expand(text: string): string {
  const padCount = Math.max(1, Math.round([...text].length * 0.4));
  return `⟦${text}${'·'.repeat(padCount)}⟧`;
}

/**
 * Pseudo-localize an ICU message: accent the literal text (placeholders and
 * values preserved), then expand. Plural/number resolution uses the locale's
 * `Intl` data — `en-XA` resolves to English rules/formatting, which is what we
 * want for an English-derived pseudo-locale.
 */
export function pseudoFormat(
  message: string,
  params: MessageParams | undefined,
  locale: string,
): string {
  const resolved = formatMessage(message, params, locale, { transformLiteral: accent });
  return expand(resolved);
}
