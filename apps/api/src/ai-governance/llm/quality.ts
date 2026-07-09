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
 *  identity config into every AIOutputRecord's config hash). */
export const LAWMAKING_SUMMARY_QUALITY_GATE_VERSION = 1;

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
  const proposalLower = input.proposalText.toLowerCase();
  for (const token of splitWhitespace(`${headline} ${summary}`)) {
    const lower = stripTrailingPunctuation(token.toLowerCase());
    if (
      (lower.startsWith('http://') || lower.startsWith('https://')) &&
      !proposalLower.includes(lower)
    ) {
      failures.push('url_not_in_proposal');
      break;
    }
  }

  // Grounding: the draft's content tokens must overwhelmingly come from the
  // proposal. Both sides are stopword-filtered, so filler words neither help
  // nor hurt the fraction.
  const proposalContent = contentTokens(input.proposalText);
  const draftContent = contentTokens(`${headline} ${summary}`);
  if (draftContent.size === 0) {
    failures.push('no_substantive_content');
  } else {
    let present = 0;
    for (const token of draftContent) if (proposalContent.has(token)) present += 1;
    if (present / draftContent.size < GROUNDING_MIN_FRACTION) {
      failures.push('insufficient_grounding');
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, headline, summary };
}
