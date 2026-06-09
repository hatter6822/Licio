// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal ICU MessageFormat resolver (WS-B.2.14). Supports `{name}` argument
// substitution, `{name, plural, …}` (with `=N` exact matches, CLDR categories
// via Intl.PluralRules, and `#` for the formatted number), `{name,
// selectordinal, …}`, and `{name, select, …}`. This gives grammatically correct,
// locale-aware copy (e.g. "1 character" vs "2 characters") without an i18n
// dependency. Nested placeholders inside option bodies are resolved recursively.
//
// ICU apostrophe escaping is honoured: `''` is a literal apostrophe, and an
// apostrophe before a syntax character (`{`, `}`, `#`) opens a quoted literal run
// that ends at the next lone apostrophe — so `'{'` renders a literal brace,
// "It''s" renders "It's", and `'#'` is a literal hash inside a plural arm. This
// lets copy contain the very characters the syntax uses without breaking parsing.
//
// The `#` of a plural/selectordinal is resolved in place as the scanner emits it
// (never via string replacement), so the formatted number is inserted as final
// text and is never itself re-parsed — locale separators that happen to be ICU
// syntax characters cannot corrupt the output.
//
// An optional `transformLiteral` hook rewrites only the literal (non-placeholder)
// text segments as they are emitted, leaving argument names, ICU keywords, and
// substituted values untouched. The pseudo-locale (`pseudo.ts`) uses it to accent
// human-readable text while preserving message structure.
import { formatNumber } from './format.js';

export type MessageParams = Record<string, string | number>;

export interface MessageFormatOptions {
  /**
   * Rewrites each literal text run before it is appended (e.g. pseudo-locale
   * accenting). Placeholder names, ICU keywords and substituted values are never
   * passed through it, so message structure is preserved.
   */
  transformLiteral?: (literal: string) => string;
}

type Transform = ((literal: string) => string) | undefined;

/** Quote-trigger characters: an apostrophe before one of these opens a quote. */
const QUOTE_TRIGGERS = new Set(['{', '}', '#']);

/**
 * Index of the `}` that closes the `{` at `open`, honouring nesting and ICU
 * apostrophe quoting (a quoted `'{'`/`'}'` does not change brace depth).
 */
function findMatchingBrace(source: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'") {
      const next = source[i + 1];
      if (next === "'") {
        i += 2;
        continue;
      }
      if (next !== undefined && QUOTE_TRIGGERS.has(next)) {
        i += 2; // skip the opening apostrophe + the triggering char
        while (i < source.length) {
          if (source[i] === "'") {
            if (source[i + 1] === "'") {
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return source.length;
}

/** Parse a plural/select option body: `=0 {…} one {# …} other {# …}`. */
function parseOptions(body: string): Record<string, string> {
  const options: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i] ?? '')) i += 1;
    const braceStart = body.indexOf('{', i);
    if (braceStart === -1) break;
    const category = body.slice(i, braceStart).trim();
    const braceEnd = findMatchingBrace(body, braceStart);
    if (category) options[category] = body.slice(braceStart + 1, braceEnd);
    i = braceEnd + 1;
  }
  return options;
}

/**
 * Resolve one `{…}` placeholder. `hash` is the formatted number of the nearest
 * enclosing plural (or `undefined`): it propagates into nested `select` arms and
 * is replaced when a nested plural establishes its own.
 */
function resolvePlaceholder(
  inner: string,
  params: MessageParams | undefined,
  locale: string,
  transform: Transform,
  hash: string | undefined,
): string {
  const firstComma = inner.indexOf(',');
  if (firstComma === -1) {
    const value = params?.[inner.trim()];
    return value === undefined ? `{${inner.trim()}}` : String(value);
  }

  const name = inner.slice(0, firstComma).trim();
  const rest = inner.slice(firstComma + 1);
  const secondComma = rest.indexOf(',');
  const type = (secondComma === -1 ? rest : rest.slice(0, secondComma)).trim();
  const body = secondComma === -1 ? '' : rest.slice(secondComma + 1);
  const value = params?.[name];

  if (type === 'plural' || type === 'selectordinal') {
    const count = typeof value === 'number' ? value : Number(value ?? 0);
    const choices = parseOptions(body);
    const category = new Intl.PluralRules(locale, {
      type: type === 'selectordinal' ? 'ordinal' : 'cardinal',
    }).select(count);
    const chosen = choices[`=${count}`] ?? choices[category] ?? choices['other'] ?? '';
    return format(chosen, params, locale, transform, formatNumber(count, locale));
  }

  if (type === 'select') {
    const choices = parseOptions(body);
    const chosen = choices[String(value ?? 'other')] ?? choices['other'] ?? '';
    return format(chosen, params, locale, transform, hash);
  }

  return value === undefined ? `{${inner}}` : String(value);
}

/** Internal scanner. `hash` is the active plural number (`#`), if any. */
function format(
  message: string,
  params: MessageParams | undefined,
  locale: string,
  transform: Transform,
  hash: string | undefined,
): string {
  const needsScan =
    message.includes('{') || message.includes("'") || (hash !== undefined && message.includes('#'));
  if (!needsScan) return transform ? transform(message) : message;

  let out = '';
  let literal = '';
  const flush = (): void => {
    if (literal.length === 0) return;
    out += transform ? transform(literal) : literal;
    literal = '';
  };

  let i = 0;
  while (i < message.length) {
    const ch = message[i];
    if (ch === "'") {
      const next = message[i + 1];
      if (next === "'") {
        literal += "'"; // `''` → a literal apostrophe
        i += 2;
        continue;
      }
      if (next !== undefined && QUOTE_TRIGGERS.has(next)) {
        i += 1; // consume the opening apostrophe
        while (i < message.length) {
          if (message[i] === "'") {
            if (message[i + 1] === "'") {
              literal += "'";
              i += 2;
              continue;
            }
            i += 1; // consume the closing apostrophe
            break;
          }
          literal += message[i];
          i += 1;
        }
        continue;
      }
      literal += "'"; // a lone apostrophe is itself literal
      i += 1;
      continue;
    }
    if (ch === '{') {
      flush();
      const end = findMatchingBrace(message, i);
      out += resolvePlaceholder(message.slice(i + 1, end), params, locale, transform, hash);
      i = end + 1;
      continue;
    }
    if (ch === '#' && hash !== undefined) {
      literal += hash; // the plural number, emitted in place
      i += 1;
      continue;
    }
    literal += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Resolve an ICU message string against `params` in `locale`. */
export function formatMessage(
  message: string,
  params: MessageParams | undefined,
  locale: string,
  options?: MessageFormatOptions,
): string {
  return format(message, params, locale, options?.transformLiteral, undefined);
}
