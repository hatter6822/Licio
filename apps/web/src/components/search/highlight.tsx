// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Query-term highlighting for search results (WS-F.3.1b modal). Pure string
// scanning into React nodes — NEVER markup injection: matches become <mark>
// elements around plain text children, so untrusted content and query strings
// are both rendered as text (no regex is built from user input either).
import type { ReactNode } from 'react';

/** Client-side mirror of the server's query tokenizer (Unicode alphanumeric
 *  runs, max 12) so the highlighter marks exactly what the engine matched on. */
export function queryTokens(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
}

interface MatchRange {
  start: number;
  end: number;
}

/** Case-insensitive occurrences of every token, merged where they overlap. */
export function matchRanges(text: string, tokens: readonly string[]): MatchRange[] {
  const lower = text.toLowerCase();
  // Case-lowering can CHANGE a string's length (e.g. İ U+0130 → "i̇", two
  // units): offsets found in `lower` would then misalign against `text`,
  // corrupting highlight boundaries (and potentially splitting surrogate
  // pairs). Degrade to no-highlight — never a wrong highlight.
  if (lower.length !== text.length) return [];
  const found: MatchRange[] = [];
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    if (token.length === 0) continue;
    let from = 0;
    while (from + token.length <= lower.length) {
      const at = lower.indexOf(token, from);
      if (at === -1) break;
      found.push({ start: at, end: at + token.length });
      from = at + token.length;
    }
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MatchRange[] = [];
  for (const range of found) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Wrap every token occurrence in a styled <mark>. The mark keeps the ambient
 * background (token contrast is carried by weight + the ≥4.5:1 accent color,
 * never by a new background pair).
 */
export function highlightMatches(text: string, tokens: readonly string[]): ReactNode {
  const merged = matchRanges(text, tokens);
  if (merged.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  merged.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark key={index} className="bg-transparent font-semibold text-primary-on-soft">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
