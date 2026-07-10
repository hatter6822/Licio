// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic acceptance gate for an LLM-drafted lawmaking summary (SPEC
// §24.5: neutral, grounded, drawn from the proposal — enforced mechanically,
// never by trusting the model). The gate REJECTS (⇒ the provider throws and the
// GovernanceService falls back to the deterministic summary) any draft that:
//   - has an empty or overlong headline/summary (bounds below);
//   - introduces a URL absent from the proposal text — a prompt-injection /
//     exfiltration vector the platform closes structurally;
//   - is insufficiently grounded: fewer than GROUNDING_MIN_FRACTION of its
//     stopword-filtered content tokens appear in the proposal, which catches
//     off-topic or hallucinated drafts while tolerating light paraphrase (the
//     system prompt instructs an extractive style, so a compliant draft clears
//     this comfortably).
// Whitespace is collapsed without regex (the WS-U ReDoS-free discipline for
// model-influenced text), so an accepted draft is a single clean paragraph.

import { contentTokens } from '@licio/ai-governance';

/** Bumped whenever the acceptance constraints below change (pinned via the
 *  identity config into every AIOutputRecord's config hash).
 *  v2: grounding matches lexical STEMS — a full-prefix inflection
 *  (`adopting`/`adopt`, `subscribers`/`subscriber`) or a shared ≥6-char stem
 *  (`proposal`/`propose`, `summarizes`/`summarising` — derivations and
 *  regional spellings diverge after a long common stem) counts as grounded.
 *  The v1 exact-token rule rejected compliant, accurately-grounded drafts
 *  from models that inflect or use regional spelling while paraphrasing
 *  (measured on gemma3 and qwen3-coder) — a morphology test, not a grounding
 *  test. Genuinely foreign words share no stem and still fail. */
export const LAWMAKING_SUMMARY_QUALITY_GATE_VERSION = 2;

export const LLM_SUMMARY_HEADLINE_MAX = 120;
export const LLM_SUMMARY_BODY_MAX = 700;
export const GROUNDING_MIN_FRACTION = 0.6;

export interface LawmakingSummaryDraft {
  headline: string;
  summary: string;
}

export interface LawmakingSummaryQualityInput {
  /** The proposal's full text surface (title + body + options), caller-built. */
  proposalText: string;
  draft: LawmakingSummaryDraft;
}

export type LawmakingSummaryQualityResult =
  | { ok: true; headline: string; summary: string }
  | { ok: false; failures: string[] };

/** ReDoS-free whitespace collapse + trim (no regex over model output). */
function collapseWhitespace(text: string): string {
  const parts: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (cur.length > 0) {
        parts.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) parts.push(cur);
  return parts.join(' ');
}

/** ASCII whitespace split without regex (mirrors the forum-agent tokenizers). */
function splitWhitespace(text: string): string[] {
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

/** Trim common trailing prose punctuation off a URL token before matching. */
function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0) {
    const ch = token[end - 1];
    if (
      ch === '.' ||
      ch === ',' ||
      ch === ';' ||
      ch === ':' ||
      ch === ')' ||
      ch === ']' ||
      ch === '}' ||
      ch === '"' ||
      ch === "'"
    ) {
      end -= 1;
    } else {
      break;
    }
  }
  return token.slice(0, end);
}

/** Characters that terminate a URL embedded in prose/markdown (wrappers like
 *  `[]`, `()`, `<>`, `{}`, quotes); whitespace already split the token. */
const URL_BOUNDARY = new Set(['<', '>', '[', ']', '(', ')', '{', '}', '"', "'", '`']);

/**
 * Extract EVERY http(s) URL embedded in a whitespace token, tolerating leading
 * wrappers (`[docs](https://x)`, `<https://x>`, `see:https://x`) and trailing
 * prose punctuation. A `startsWith('http')` check misses a wrapped URL, letting an
 * off-proposal link slip past the `url_not_in_proposal` guard (WS-U ADR-9 review);
 * scanning for the scheme anywhere in the token closes that.
 */
function extractUrls(token: string): string[] {
  const lower = token.toLowerCase();
  const out: string[] = [];
  for (let i = 0; i < lower.length; ) {
    const h = lower.indexOf('http://', i);
    const s = lower.indexOf('https://', i);
    const start = h === -1 ? s : s === -1 ? h : Math.min(h, s);
    if (start === -1) break;
    let end = start;
    while (end < lower.length) {
      const ch = lower[end];
      if (ch === undefined || URL_BOUNDARY.has(ch)) break;
      end += 1;
    }
    const url = stripTrailingPunctuation(lower.slice(start, end));
    if (url.length > 0) out.push(url);
    i = Math.max(end, start + 1);
  }
  return out;
}

/**
 * Check an LLM draft against the deterministic §24.5 acceptance constraints.
 * Returns the whitespace-collapsed headline/summary on success so the accepted
 * output is exactly what was checked.
 */
export function checkLawmakingSummaryQuality(
  input: LawmakingSummaryQualityInput,
): LawmakingSummaryQualityResult {
  const failures: string[] = [];
  const headline = collapseWhitespace(input.draft.headline);
  const summary = collapseWhitespace(input.draft.summary);

  if (headline.length === 0) failures.push('headline_empty');
  if (headline.length > LLM_SUMMARY_HEADLINE_MAX) failures.push('headline_too_long');
  if (summary.length === 0) failures.push('summary_empty');
  if (summary.length > LLM_SUMMARY_BODY_MAX) failures.push('summary_too_long');

  // Every URL in the draft must literally appear in the proposal (case-folded).
  // URLs are extracted from ANYWHERE in a token (not just a `startsWith`), so a
  // markdown/angle-bracket-wrapped off-proposal link cannot exfiltrate past this.
  const proposalLower = input.proposalText.toLowerCase();
  let urlNotInProposal = false;
  for (const token of splitWhitespace(`${headline} ${summary}`)) {
    for (const url of extractUrls(token)) {
      if (!proposalLower.includes(url)) {
        urlNotInProposal = true;
        break;
      }
    }
    if (urlNotInProposal) break;
  }
  if (urlNotInProposal) failures.push('url_not_in_proposal');

  // Grounding: the draft's content tokens must overwhelmingly come from the
  // proposal. Both sides are stopword-filtered, so filler words neither help
  // nor hurt the fraction. A token is grounded on an EXACT match or a shared
  // lexical stem (one token is a prefix of the other, ≥ 5 shared characters) —
  // inflection (`adopting`/`adopt`, `subscribers`/`subscriber`) is not
  // hallucination, while genuinely foreign words share no stem and still count
  // against the draft (gate v2).
  const proposalContent = contentTokens(input.proposalText);
  const proposalList = [...proposalContent];
  /** Shared-leading-character count (deterministic, no regex). */
  const commonPrefixLength = (a: string, b: string): number => {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) i += 1;
    return i;
  };
  const grounded = (token: string): boolean => {
    if (proposalContent.has(token)) return true;
    if (token.length < 5) return false;
    for (const candidate of proposalList) {
      if (candidate.length < 5) continue;
      // One token is a full prefix of the other (adopt/adopting), or the two
      // share a long stem (propose/proposal, summarising/summarizes — regional
      // spellings and derivations diverge after a shared ≥6-char stem).
      if (token.startsWith(candidate) || candidate.startsWith(token)) return true;
      if (commonPrefixLength(token, candidate) >= 6) return true;
    }
    return false;
  };
  const draftContent = contentTokens(`${headline} ${summary}`);
  if (draftContent.size === 0) {
    failures.push('no_substantive_content');
  } else {
    let present = 0;
    for (const token of draftContent) if (grounded(token)) present += 1;
    if (present / draftContent.size < GROUNDING_MIN_FRACTION) {
      failures.push('insufficient_grounding');
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, headline, summary };
}
