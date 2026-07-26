// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Build helper (NOT app runtime code — imported only by `vite.config.ts`, so it
// never enters the client bundle).
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
// Pure and DOM-free so it is directly unit-testable.

/**
 * Elements whose CONTENT a parser never treats as live markup.
 *
 * This is the COMPLETE set from HTML tree construction, not a list of the ones
 * that came to mind — an earlier cut named five, and `noframes`, `noembed` and
 * `xmp` each let a `<meta>` that the browser reads as TEXT pass this gate as a
 * delivered policy.  Every entry below is a start tag whose handling switches
 * the tokenizer out of markup, so the list is closed and checkable against the
 * spec rather than open-ended:
 *
 *   • RAWTEXT — `style`, `xmp`, `iframe`, `noembed`, `noframes`;
 *   • RCDATA (escapable raw text) — `textarea`, `title`;
 *   • the script data states — `script`;
 *   • `noscript`, which is RAWTEXT when SCRIPTING IS ENABLED — every browser the
 *     courier runs in.  A policy placed there is applied by exactly the clients
 *     that need it least, and a CSP whose delivery depends on the user having
 *     turned JavaScript off is not a delivered CSP.
 *
 * `template` is here for a different reason: its content IS parsed, but into an
 * INERT fragment, so a CSP `<meta>` inside one has no effect whatsoever.  That
 * makes it the most dangerous of the set, because it looks exactly like a
 * delivered policy to anything matching on text.
 *
 * `plaintext` is deliberately NOT here — it takes the rest of the document with
 * it and so is handled separately ({@link scanTags}).
 */
const INERT_CONTENT_ELEMENTS = [
  'script',
  'style',
  'textarea',
  'title',
  'template',
  'noscript',
  'noframes',
  'noembed',
  'iframe',
  'xmp',
] as const;

/** The same set, as the lookup {@link scanTags} does per tag. */
const INERT_CONTENT: ReadonlySet<string> = new Set(INERT_CONTENT_ELEMENTS);

/**
 * `<plaintext>` switches the tokenizer to the PLAINTEXT state, which has no way
 * back: everything after it is character data to the end of the document, close
 * tag or not.  So it is not "an element with inert content" — it ENDS the
 * markup, and a `<meta>` after one is text no matter how well-formed it looks.
 */
const PLAINTEXT = 'plaintext';

/** One attribute as the tokenizer produced it: a lower-cased name, a raw value. */
export interface HtmlAttribute {
  readonly name: string;
  readonly value: string;
}

/** One tag a parser would actually create, with the text it spans. */
export interface HtmlTag {
  readonly kind: 'tag';
  /** Lower-cased tag name (HTML names are ASCII case-insensitive). */
  readonly name: string;
  /** `</name>` rather than an open tag. */
  readonly closing: boolean;
  /** Byte offset of the `<`. */
  readonly at: number;
  /** Byte offset just past the `>`. */
  readonly end: number;
  /** The tag's own text, `<` through `>`. */
  readonly raw: string;
  /**
   * The attributes as the TOKENIZER produced them, in source order.
   *
   * Names are lower-cased (HTML names are ASCII case-insensitive); values are
   * RAW — character references are the consumer's to decode, since the
   * tokenizer decodes them per context.
   *
   * Published because the reader already computes them: a consumer with its own
   * attribute pattern is a second spelling of one rule, and in this file that
   * rule has disagreed with itself four times — character tokens, tag names,
   * attribute names, and unquoted values.  One reader, one answer.
   */
  readonly attributes: readonly HtmlAttribute[];
}

const ASCII_LETTER = /[a-zA-Z]/;
/**
 * HTML whitespace: exactly TAB, LF, FF, CR and SPACE.
 *
 * NOT JavaScript's `\s`, which also matches U+00A0 and the Unicode spaces.  The
 * difference is not cosmetic: `<head\u00a0>` is an element NAMED `head\u00a0`,
 * so the browser implies an empty head and leaves a CSP `<meta>` after it in the
 * body, ineffective — while a scanner using `\s` reads a perfectly good `head`
 * and certifies the document.
 */
const SPACE = /[\t\n\f\r ]/;

/**
 * Read the tag starting at `at`, or `null` when a `<` there is ordinary text.
 *
 * The tag's extent is what makes this a parser rather than a pattern: a `>`
 * inside a QUOTED ATTRIBUTE VALUE does not end the tag, and — the case a `<meta`
 * pattern gets wrong — a `<` inside one does not start a new one.  Markup
 * serialized into an attribute, as in
 * `<div data-note='<meta http-equiv="Content-Security-Policy" …>'>`, creates no
 * element at all: it is character data in a `data-note` attribute.  A scan that
 * matched `<meta` anywhere accepted it as the delivered policy, so a courier
 * build carrying NO CSP could pass the gate that exists to prove it carries one.
 *
 * All three attribute-value forms are handled (WHATWG HTML §13.1.2.3), because
 * `<meta http-equiv=Content-Security-Policy content="…">` is valid HTML a
 * browser honours in full.
 */
function readTag(html: string, at: number): HtmlTag | null {
  const len = html.length;
  let i = at + 1;
  const closing = html[i] === '/';
  if (closing) i += 1;
  if (!ASCII_LETTER.test(html[i] ?? '')) return null; // a `<` that is just text
  const nameFrom = i;
  while (i < len && !SPACE.test(html[i] ?? '') && html[i] !== '/' && html[i] !== '>') i += 1;
  const name = html.slice(nameFrom, i).toLowerCase();
  const attributes: HtmlAttribute[] = [];
  const done = (end: number): HtmlTag => ({
    kind: 'tag',
    name,
    closing,
    at,
    end,
    raw: html.slice(at, end),
    attributes,
  });

  while (i < len) {
    const char = html[i] ?? '';
    if (char === '>') return done(i + 1);
    if (SPACE.test(char) || char === '/' || char === '=') {
      i += 1;
      continue;
    }
    // An attribute name, then optionally `=` and a value.
    const nameStart = i;
    while (i < len) {
      const inner = html[i] ?? '';
      if (SPACE.test(inner) || inner === '=' || inner === '>' || inner === '/') break;
      i += 1;
    }
    if (i === nameStart) {
      i += 1; // never stall, whatever the input
      continue;
    }
    const attributeName = html.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < len && SPACE.test(html[j] ?? '')) j += 1;
    if (html[j] !== '=') {
      attributes.push({ name: attributeName, value: '' }); // a valueless attribute
      continue;
    }
    j += 1;
    while (j < len && SPACE.test(html[j] ?? '')) j += 1;
    const quote = html[j];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, j + 1);
      attributes.push({
        name: attributeName,
        value: html.slice(j + 1, close === -1 ? len : close),
      });
      i = close === -1 ? len : close + 1;
      continue;
    }
    // UNQUOTED: `=`, `"`, `'`, `` ` `` and `<` are parse errors but are KEPT IN
    // THE VALUE, so only whitespace and `>` end it.  Stopping at the `=` in
    // `data=x=http-equiv=…` splits one attribute into two and invents an
    // `http-equiv` the browser never creates — a policy the gate reads and the
    // WebView does not apply.
    let k = j;
    while (k < len && !SPACE.test(html[k] ?? '') && html[k] !== '>') k += 1;
    attributes.push({ name: attributeName, value: html.slice(j, k) });
    i = k;
  }
  // An unterminated tag runs to the end of the document, as in a parser.
  return done(len);
}

/**
 * Every tag a parser would create, in document order.
 *
 * ONE answer to "where are the real elements", shared by the injector and by
 * `check:csp-parity` so the two agree — two spellings of that rule is how a
 * green gate ends up describing a document nobody delivers.  Each caller then
 * asks its own question of the result: where the `<head>` opens, which tags a
 * policy must precede, which `<meta>` carries one.
 *
 * Everything a parser would NOT read as markup is stepped over: comment bodies,
 * doctypes, and the CONTENT of the inert elements above.  The element TAGS stay
 * in the list — only their content is skipped — so a `<script src>` still counts
 * as content the policy must precede.
 *
 * Offsets index the ORIGINAL string, so a caller can splice into it (or report
 * against it) from what this returns.
 */
export function scanTags(html: string): HtmlTag[] {
  return scanNodes(html).filter((node): node is HtmlTag => node.kind === 'tag');
}

/** Character data a parser would insert, between the tags around it. */
export interface HtmlText {
  readonly kind: 'text';
  readonly at: number;
  readonly end: number;
  /** The raw source text, references undecoded. */
  readonly text: string;
}

/** One thing a parser produces: an element, or the characters between elements. */
export type HtmlNode = HtmlTag | HtmlText;

/**
 * {@link scanTags}, keeping the CHARACTER DATA between the tags as well.
 *
 * Text is not decoration to a parser — it is a token with tree-construction
 * consequences.  A non-whitespace character in `<head>` CLOSES the head, so
 * `<head>hello<meta …>` puts the policy in the body where CSP L3 §3.3 does not
 * honour it, and a model built from tags alone sees a perfectly ordinary head.
 *
 * What is NOT text: comment bodies, doctypes, and the content of the inert
 * elements — the scan steps over all three, so `<title>hello</title>` in a head
 * contributes the two tags and no character data, which is what the parser does
 * with it too.
 */
export function scanNodes(html: string): HtmlNode[] {
  const nodes: HtmlNode[] = [];
  let i = 0;
  let textFrom = -1;
  const flushText = (end: number): void => {
    if (textFrom === -1) return;
    nodes.push({ kind: 'text', at: textFrom, end, text: html.slice(textFrom, end) });
    textFrom = -1;
  };
  while (i < html.length) {
    if (html[i] !== '<') {
      if (textFrom === -1) textFrom = i;
      i += 1;
      continue;
    }
    flushText(i);
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      // An unterminated comment runs to the end of the document, as in a parser.
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      // A doctype or bogus comment: no element, and it ends at the next `>`.
      const close = html.indexOf('>', i);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    const tag = readTag(html, i);
    if (tag === null) {
      // A `<` that is ordinary text — and it IS text, so it counts as one.
      if (textFrom === -1) textFrom = i;
      i += 1;
      continue;
    }
    nodes.push(tag);
    i = tag.end;
    // PLAINTEXT has no exit state: the rest of the document is character data.
    if (!tag.closing && tag.name === PLAINTEXT) {
      if (i < html.length)
        nodes.push({ kind: 'text', at: i, end: html.length, text: html.slice(i) });
      return nodes;
    }
    if (tag.closing || !INERT_CONTENT.has(tag.name)) continue;
    // `<template>` NESTS; the raw-text elements cannot, so their first close tag
    // ends them.  Depth-counting only the nesting case keeps this exact.
    const contentEnd =
      tag.name === 'template'
        ? endOfTemplate(html, tag.end)
        : indexOfClose(html, tag.name, tag.end);
    i = Math.max(contentEnd, tag.end);
  }
  flushText(html.length);
  return nodes;
}

/**
 * The `</name>` that ends a raw-text element, read as a TAG.
 *
 * An end tag may carry attributes — the parser ignores them, but they are part
 * of the tag — so `</title data='</title><meta …>'>` ends the title at the
 * FIRST `</title`, and the `</title>` inside that attribute value is character
 * data.  A `</name\s*>` pattern matches the quoted one instead, ending the
 * element in the wrong place and exposing the `<meta>` inside it as a delivered
 * policy.  Reading the tag with {@link readTag} is what gets the extent right.
 *
 * A `</` whose name does NOT match is ordinary text inside raw content, so it is
 * stepped over rather than treated as a close.
 */
function closeTagOf(html: string, name: string, from: number): HtmlTag | null {
  for (let i = from; i < html.length; i += 1) {
    if (html[i] !== '<' || html[i + 1] !== '/') continue;
    const tag = readTag(html, i);
    if (tag?.closing === true && tag.name === name) return tag;
  }
  return null;
}

/** Offset of the close tag at or after `from`, or the end of the document. */
function indexOfClose(html: string, name: string, from: number): number {
  return closeTagOf(html, name, from)?.at ?? html.length;
}

/**
 * Raw-text and escapable-raw-text elements: their content is never markup.
 *
 * DERIVED from the inert set rather than listed again, by the one rule that
 * separates them: `<template>`'s content IS parsed (into an inert fragment), so
 * it nests and needs depth counting; every other inert element holds text, which
 * cannot nest and ends at its first close tag.
 */
const RAW_TEXT: ReadonlySet<string> = new Set(
  INERT_CONTENT_ELEMENTS.filter((name) => name !== 'template'),
);

/**
 * Past any run starting at `i` that a parser does not read as markup — a
 * comment, or a raw-text element together with its content.  Returns `i`
 * unchanged when markup does start there.
 *
 * ONE place that answers "is this a tag or is it text", used by every scan that
 * needs to know.  Four separate scans each learned that question the hard way —
 * a `<meta>` inside a comment, a `</template>` inside a comment, a `</template>`
 * inside `<script>` raw text, and a whole `<meta>` inside an ATTRIBUTE VALUE —
 * because each modelled the contexts it happened to think of.  A close tag
 * written as a STRING in script text is not a close tag, and no amount of
 * pattern-tightening around `</template>` would have found that; knowing the
 * contexts is the whole job.
 *
 * The open tag is read by {@link readTag} for that reason: a hand-rolled
 * `[^>]*>` here ended `<script data-x="a>b">` at the `>` INSIDE the value and
 * began scanning for content from the middle of an attribute — the same defect,
 * one layer down, in the last place this file still spelled tag bounds twice.
 */
function skipNonMarkup(html: string, i: number): number {
  if (html.startsWith('<!--', i)) {
    const close = html.indexOf('-->', i + 4);
    return close === -1 ? html.length : close + 3;
  }
  const tag = readTag(html, i);
  if (tag === null || tag.closing || !RAW_TEXT.has(tag.name)) return i;
  return closeTagOf(html, tag.name, tag.end)?.end ?? html.length;
}

/**
 * Offset of the `</template>` that closes the one opened before `from`.
 *
 * A `<template>`'s content IS parsed, so nested comments and raw-text elements
 * follow the ordinary rules inside it — `<!-- </template> -->` is a comment and
 * `<script>"</template>"</script>` is a string, and neither closes anything.
 * Both are skipped through {@link skipNonMarkup} before depth is touched.
 * Stopping at either left a CSP `<meta>` further down the same inert template
 * counting as the delivered policy, with the courier applying none.
 */
function endOfTemplate(html: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const skipped = skipNonMarkup(html, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (html[i] !== '<') {
      i += 1;
      continue;
    }
    const tag = readTag(html, i);
    if (tag === null) {
      i += 1;
      continue;
    }
    if (tag.name === 'template') {
      if (!tag.closing) depth += 1;
      else {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    // Past the WHOLE tag: a `<` inside one of its attribute values starts
    // nothing, so re-entering the tag body could only find a phantom.
    i = tag.end;
  }
  return html.length;
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
 * Insert the CSP `<meta http-equiv>` into `html`.
 *
 * Returns the document UNCHANGED when it has no `<head>` — there is nowhere
 * valid to put it, and a tag spliced elsewhere would be ignored by the parser
 * while looking, to a reader, like the policy was applied.  Callers that need
 * the guarantee assert on the OUTPUT (`check:csp-parity` reads the built file).
 */
export function injectCspMeta(html: string, policy: string): string {
  // The REAL `<head>`: one written inside a comment, inside a `<template>`, or
  // serialized into an attribute value is not the head, and splicing after it
  // yields a document whose only CSP is inert — no policy at all, and in the
  // courier WebView no response header behind it.
  const head = scanTags(html).find((tag) => tag.name === 'head' && !tag.closing);
  if (head === undefined) return html;
  const meta = `\n    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}" />`;
  return html.slice(0, head.end) + meta + html.slice(head.end);
}
