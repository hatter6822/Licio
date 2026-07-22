// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared ReDoS-free text utilities for model-influenced text (the WS-U
// discipline: no regex ever runs over model output or governed content).
// One implementation for every consumer — the §24.5 quality gate, the debate
// shell's rationale bounding, and the dev simulated runtime — so the
// whitespace/truncation semantics can never drift between the gate that
// checks a draft and the code that produced or bounded it.

/** Split on ASCII whitespace without regex (mirrors the forum tokenizers). */
export function splitWhitespace(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Collapse all whitespace runs to single spaces and trim (one clean line). */
export function collapseWhitespace(text: string): string {
  return splitWhitespace(text).join(' ');
}

/** Whitespace-delimited token count (deterministic, regex-free). */
export function countTokens(text: string): number {
  return splitWhitespace(text).length;
}

/** Truncate at a word boundary WITHOUT adding an ellipsis, so every token in
 *  the output still appears verbatim in the input (grounding-safe under the
 *  §24.5 gate's token check). */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
