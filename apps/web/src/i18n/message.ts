// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal ICU MessageFormat resolver (WS-B.2.14). Supports `{name}` argument
// substitution, `{name, plural, …}` (with `=N` exact matches, CLDR categories
// via Intl.PluralRules, and `#` for the formatted number), `{name,
// selectordinal, …}`, and `{name, select, …}`. This gives grammatically correct,
// locale-aware copy (e.g. "1 character" vs "2 characters") without an i18n
// dependency. Nested placeholders inside option bodies are resolved recursively.
import { formatNumber } from './format.js';

export type MessageParams = Record<string, string | number>;

/** Index of the `}` that closes the `{` at `open` (handles nesting). */
function findMatchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
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

function resolvePlaceholder(
  inner: string,
  params: MessageParams | undefined,
  locale: string,
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
    const options = parseOptions(body);
    const ordinal = type === 'selectordinal';
    const category = new Intl.PluralRules(locale, {
      type: ordinal ? 'ordinal' : 'cardinal',
    }).select(count);
    const chosen = options[`=${count}`] ?? options[category] ?? options['other'] ?? '';
    return formatMessage(chosen.replace(/#/g, formatNumber(count, locale)), params, locale);
  }

  if (type === 'select') {
    const options = parseOptions(body);
    const chosen = options[String(value ?? 'other')] ?? options['other'] ?? '';
    return formatMessage(chosen, params, locale);
  }

  return value === undefined ? `{${inner}}` : String(value);
}

/** Resolve an ICU message string against `params` in `locale`. */
export function formatMessage(
  message: string,
  params: MessageParams | undefined,
  locale: string,
): string {
  if (!message.includes('{')) return message;
  let out = '';
  let i = 0;
  while (i < message.length) {
    if (message[i] === '{') {
      const end = findMatchingBrace(message, i);
      out += resolvePlaceholder(message.slice(i + 1, end), params, locale);
      i = end + 1;
    } else {
      out += message[i];
      i += 1;
    }
  }
  return out;
}
