// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conservative v0 low-information-reply classifier (WS-G closing the WS-E
// residual; SPEC §5.3 "Low-information replies — count as conversation
// volume but not constructive participation").  The classification affects
// SCORING WEIGHT only (`low_info_reply` carries weight 0, never negative);
// it never touches visibility or moderation, so the conservative cost of a
// false positive is bounded: a genuinely useful one-word reply simply earns
// no constructive weight.
//
// The v0 mandate is to ERR TOWARD NOT CLASSIFYING.  A body is low-info only
// when ALL hold:
//   1. it carries no citation (a cited reply is substantive by construction),
//   2. it is very short after trimming (< 16 characters), and
//   3. it is bare acknowledgment/reaction text: nothing but punctuation,
//      emoji-ish symbols, digits used as tallies, or a closed lexicon of
//      acknowledgment tokens ("+1", "this", "lol", "same", "first", …).
// A short body containing a question mark, a URL, or any token OUTSIDE the
// lexicon is NEVER classified (it may be a terse but real answer: "June 3rd").
//
// WS-K seam: a reviewed AI classifier replaces this function behind the same
// (text, hasCitation) → boolean signature; callers depend only on the boolean.

const MAX_LOW_INFO_LENGTH = 15;

/** Bare acknowledgment tokens (closed, lowercase). */
const ACKNOWLEDGMENT_TOKENS = new Set([
  'this',
  'same',
  'lol',
  'lmao',
  'first',
  'second',
  'bump',
  'ok',
  'okay',
  'k',
  'yes',
  'no',
  'nice',
  'cool',
  'wow',
  'agreed',
  'agree',
  'true',
  'facts',
  'based',
]);

/** Strip punctuation/symbol noise, keeping word characters and spaces. */
function tokenize(body: string): string[] {
  return body
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Conservative low-information classification (see module header).  Total:
 * any string yields a boolean; empty bodies are the caller's validation
 * concern (they cannot be created) and classify as low-info trivially.
 */
export function classifyLowInfoReplyV0(body: string, hasCitation: boolean): boolean {
  if (hasCitation) return false;
  const trimmed = body.trim();
  if (trimmed.length > MAX_LOW_INFO_LENGTH) return false;
  if (trimmed.includes('?')) return false; // a question, however short
  if (/https?:\/\//i.test(trimmed)) return false; // carries a link
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return true; // punctuation/emoji only
  // Every token must be a bare acknowledgment or a tally like "+1"/"1".
  return tokens.every((token) => ACKNOWLEDGMENT_TOKENS.has(token) || /^[+]?\d{1,3}$/.test(token));
}
