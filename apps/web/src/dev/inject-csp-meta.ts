// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Build helper (NOT app runtime code — imported only by `vite.config.ts` and by
// `check:csp-parity`, so it never enters the client bundle).
//
// `index.html` carries NO Content-Security-Policy of its own.  It used to, and
// that copy was one of three hand-maintained spellings of the same policy: a
// header tightened in `apps/api` without a matching edit here left the WS-R.15.4a
// native courier WebView — which serves the built assets from `https://localhost`
// with no server headers, so the `<meta>` is its ONLY policy — running the older,
// weaker rules, with nothing to catch it.
//
// So the tag is INJECTED at build time from the single source in
// `@licio/shared` (`security/csp.ts`) instead.  Injection also removes the need
// to strip the tag in dev: the Vite DEV server never gets one, and it could not
// tolerate one anyway (HMR uses inline `<style>`, inline/eval script and a dev
// WebSocket, all of which `style-src 'self'` / `require-trusted-types-for
// 'script'` / `connect-src 'self'` block).
//
// THE PARSER IS parse5, NOT A PATTERN.  Every question here — where the head
// really is, whether a `<meta>` is a CHILD of it, what its attributes decode to
// — is a question about HTML tree construction, and the only artefact that
// answers it correctly is a spec-compliant parser.  A hand-written scanner was
// tried, carefully, and review found EIGHT distinct places where it disagreed
// with the tokenizer:
//
//   • a `<meta>` serialized into an attribute value is character data, and so
//     is one inside `noframes`, `noembed`, `xmp`, or after `<plaintext>`;
//   • `<head >` is an element NAMED `head ` — U+00A0 is not HTML
//     whitespace, though JavaScript's `\s` says it is;
//   • a `<head>` after body content is IGNORED, and non-whitespace text CLOSES
//     the head, as do `</br>`, `</body>` and `</html>`;
//   • an end tag may carry attributes, so `</title data='</title>'>` ends the
//     title at the FIRST one;
//   • `=` before an attribute name becomes part of the NAME, and inside an
//     unquoted value stays IN the value.
//
// Each was a real hole — several let a document with NO effective policy pass
// the gate that exists to prove the courier has one — and each fix was correct.
// The list did not shorten, because it IS the HTML tokenizer, and the way to
// stop finding new entries is to stop reimplementing it.  parse5 is jsdom's
// parser and was already in this repository's lockfile through it; it is a
// BUILD-time dependency and ships nothing to a client.
//
// What remains here is what parse5 does not decide: where the policy goes, and
// how it is escaped on the way in.

import { parse } from 'parse5';

/** The parse5 node shape this module reads; parse5's types are structural. */
interface HtmlNode {
  readonly tagName?: string;
  readonly attrs?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly childNodes?: readonly HtmlNode[];
  readonly parentNode?: HtmlNode | null;
  readonly sourceCodeLocation?: {
    readonly startOffset: number;
    readonly startTag?: { readonly endOffset: number } | null;
  } | null;
}

/** Every element the parser created, in source order. */
function* elements(node: HtmlNode): Generator<HtmlNode> {
  if (node.tagName !== undefined) yield node;
  for (const child of node.childNodes ?? []) yield* elements(child);
}

/** Parse WITH source locations, so a finding can be reported and spliced. */
function documentOf(html: string): HtmlNode {
  return parse(html, { sourceCodeLocationInfo: true }) as unknown as HtmlNode;
}

/** An attribute's value — names are lower-cased and values decoded by parse5. */
function attribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((attr) => attr.name === name)?.value;
}

/** A CSP `<meta>` as the PARSER built it. */
export interface CspMeta {
  /**
   * The `content` value, character references already decoded.
   *
   * `''` when the tag carries no `content`: it is still a policy-bearing tag,
   * and an empty delivered policy is a mismatch to report rather than a tag to
   * overlook.
   */
  readonly policy: string;
  /** Byte offset of the tag's `<`, for the report and the ordering check. */
  readonly at: number;
  /**
   * Whether the parser made this meta a CHILD OF HEAD.
   *
   * CSP L3 §3.3 honours a `<meta>` policy only there, and the TREE already
   * accounts for every way a head can begin or end — implied, closed by text,
   * closed by `</br>`, or never opened at all.  That is the whole reason this
   * module parses rather than scans.
   */
  readonly inHead: boolean;
}

/** Every `<meta http-equiv="Content-Security-Policy">` the parser creates. */
export function findCspMetas(html: string): CspMeta[] {
  const found: CspMeta[] = [];
  for (const element of elements(documentOf(html))) {
    if (element.tagName !== 'meta') continue;
    if (attribute(element, 'http-equiv')?.toLowerCase() !== 'content-security-policy') continue;
    found.push({
      policy: attribute(element, 'content') ?? '',
      at: element.sourceCodeLocation?.startOffset ?? 0,
      inHead: element.parentNode?.tagName === 'head',
    });
  }
  return found;
}

/** The FIRST element whose name is in `names`, in source order. */
export function firstElementNamed(
  html: string,
  names: ReadonlySet<string>,
): { name: string; at: number } | null {
  for (const element of elements(documentOf(html))) {
    const name = element.tagName;
    if (name === undefined || !names.has(name)) continue;
    return { name, at: element.sourceCodeLocation?.startOffset ?? 0 };
  }
  return null;
}

/** Escape a policy for a double-quoted HTML attribute.  The directive set is
 *  first-party and quote-free, but building markup by concatenation without
 *  escaping is the habit that eventually produces an injection. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Insert the CSP `<meta http-equiv>` into `html`, immediately after `<head>`.
 *
 * Returns the document UNCHANGED when it has no EXPLICIT `<head>`.  A parser
 * implies one around leading head content, but an implied element has no start
 * tag to splice after, and a tag placed anywhere else would be ignored while
 * looking, to a reader, like the policy was applied.  Callers that need the
 * guarantee assert on the OUTPUT (`check:csp-parity` reads the built file).
 */
export function injectCspMeta(html: string, policy: string): string {
  for (const element of elements(documentOf(html))) {
    if (element.tagName !== 'head') continue;
    const after = element.sourceCodeLocation?.startTag?.endOffset;
    if (after === undefined || after === null) return html;
    const meta = `\n    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}" />`;
    return html.slice(0, after) + meta + html.slice(after);
  }
  return html;
}
