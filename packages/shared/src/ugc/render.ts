// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The UGC defense-in-depth pipeline (WS-G.4.2b, SPEC §25.2/§18.4):
//
//   raw text → Markdown-lite AST (WS-G.4.1) → constrained HTML string
//            → DOMPurify `licio-ugc` (WS-G.4.2a) → TrustedHTML → React render
//
// `renderUGC` is the ONLY way UGC becomes markup.  No stage may be skipped:
// the parser cannot represent raw HTML, the serializer can only emit the
// allow-list, DOMPurify independently re-verifies, and Trusted Types + the
// strict CSP confine the sink.  The server stores raw markdown only —
// rendering happens client-side through this function.
//
// Fail-closed guarantee: in an environment without a usable DOM, DOMPurify
// exposes NO `sanitize` function at all — so this pipeline degrades to fully
// HTML-escaped plain text (formatting lost, safety kept).  It NEVER returns
// serializer output that DOMPurify has not verified.
import { getUgcSanitizer } from './dompurify.js';
import { escapeHtml, serializeUgcDocument } from './html.js';
import { MAX_UGC_INPUT_LENGTH, parseUgcMarkdown } from './markdown.js';

/**
 * The pipeline's output: a `TrustedHTML` object where Trusted Types are
 * enforced, otherwise the sanitized string (the CSP `require-trusted-types-for
 * 'script'` directive decides which one the sink will accept).  Branded so a
 * raw string cannot be passed where pipeline output is required.
 */
declare const licioUgcSafeHtmlBrand: unique symbol;
export type UgcSafeHtml = (string | { toString(): string }) & {
  readonly [licioUgcSafeHtmlBrand]: true;
};

/** Render result with the honesty flags the UI may surface. */
export interface UgcRenderResult {
  readonly html: UgcSafeHtml;
  /** True when the input exceeded {@link MAX_UGC_INPUT_LENGTH} and was truncated. */
  readonly truncated: boolean;
  /** True when DOMPurify was unavailable and output degraded to escaped text. */
  readonly degraded: boolean;
}

const EMPTY_RESULT: UgcRenderResult = Object.freeze({
  html: '' as UgcSafeHtml,
  truncated: false,
  degraded: false,
});

/**
 * Render Markdown-lite UGC to sanitized markup, with diagnostics.  Total:
 * never throws into render — empty/oversized/hostile input yields safe
 * (possibly truncated or degraded) output.
 */
export function renderUGCDetailed(markdown: string | null | undefined): UgcRenderResult {
  if (typeof markdown !== 'string' || markdown.length === 0) return EMPTY_RESULT;

  const document = parseUgcMarkdown(markdown);
  const constrained = serializeUgcDocument(document);

  const sanitizer = getUgcSanitizer();
  if (sanitizer === null) {
    // No DOM → no DOMPurify stage → never emit markup, only escaped text.
    return {
      html: escapeHtml(markdown.slice(0, MAX_UGC_INPUT_LENGTH)) as UgcSafeHtml,
      truncated: document.truncated,
      degraded: true,
    };
  }

  return {
    html: sanitizer.sanitize(constrained) as UgcSafeHtml,
    truncated: document.truncated,
    degraded: false,
  };
}

/**
 * Render Markdown-lite UGC to sanitized markup (WS-G.4.2b).  This is the
 * single UGC rendering entry point; the Biome `noDangerouslySetInnerHtml`
 * suppression is allowed only in the one component that consumes this value.
 */
export function renderUGC(markdown: string | null | undefined): UgcSafeHtml {
  return renderUGCDetailed(markdown).html;
}
