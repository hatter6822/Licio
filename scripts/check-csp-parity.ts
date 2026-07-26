// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Content-Security-Policy delivery gate.
//
// The policy is defined ONCE, in `packages/shared/src/security/csp.ts`.  Both
// TypeScript consumers — the `apps/api` response header and the `vite preview`
// header — import it, so the compiler already guarantees they agree and there is
// nothing here to compare.  This gate exists for the delivery point the compiler
// CANNOT reach: the `<meta http-equiv>` in the built HTML.
//
// That tag is injected by a Vite plugin at build time, and the WS-R.15.4a native
// courier WebView (which serves the built assets from `https://localhost` with
// no server headers) has NO other policy.  A plugin that silently stops firing —
// renamed hook, wrong `apply`, a transform ordered after the HTML is emitted —
// produces a courier with no CSP at all, and nothing else in the pipeline
// notices: the app still builds, still boots, still passes its tests.  So the
// gate asserts on the ARTIFACT.
//
// It also fails when `index.html` reintroduces a hand-written policy: a source
// copy would be additive with the injected one (two `<meta>` policies INTERSECT
// per CSP L3 §8.1), which is a confusing way to enforce something that already
// has one definition.
//
// Deliberately dependency-free so the `scripts`-rooted vitest project can unit
// test the pure core directly.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HtmlNode, scanNodes, scanTags } from '../apps/web/src/dev/inject-csp-meta.js';
import {
  contentSecurityPolicyMeta,
  META_INELIGIBLE_DIRECTIVES,
} from '../packages/shared/src/security/csp.js';

const ROOT = resolve(import.meta.dirname, '..');

export const INDEX_HTML_FILE = 'apps/web/index.html';
/** The BUILT html — checked only when a build has produced it. */
export const BUILT_INDEX_HTML_FILE = 'apps/web/dist/index.html';

/** The directive name of a full directive (`script-src 'self'` → `script-src`). */
function directiveName(directive: string): string {
  return (directive.trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/** Split a serialized policy into trimmed, non-empty directives. */
export function parsePolicyString(policy: string): string[] {
  return policy
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The named character references that produce an ASCII character.
 *
 * Deliberately not the full 2231-entry HTML5 table: every OTHER named reference
 * produces a non-ASCII character, which cannot spell any part of
 * `Content-Security-Policy` or of a CSP directive.  One appearing inside a
 * `content` value therefore yields a MISMATCH the gate reports, which is the
 * fail-loud direction — never a policy it fails to see.
 */
const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    amp: '&',
    apos: "'",
    ast: '*',
    colon: ':',
    comma: ',',
    dollar: '$',
    equals: '=',
    excl: '!',
    grave: '`',
    gt: '>',
    lcub: '{',
    lowbar: '_',
    lpar: '(',
    lsqb: '[',
    lt: '<',
    num: '#',
    percnt: '%',
    period: '.',
    plus: '+',
    quest: '?',
    quot: '"',
    rcub: '}',
    rpar: ')',
    rsqb: ']',
    semi: ';',
    sol: '/',
    Tab: '\t',
    verbar: '|',
  }),
);

/**
 * Decode the HTML character references in an attribute VALUE.
 *
 * The HTML tokenizer decodes these before the value ever reaches CSP, so
 * `http-equiv="Content-Security-Polic&#121;"` names the same header a browser
 * enforces in full — and a raw string comparison does not recognise it, which
 * would let a hand-written policy sit in the source document while this gate
 * reported it policy-free.
 *
 * The trailing `;` is OPTIONAL on a numeric reference: HTML5 decodes
 * `&#121` too (with a parse error), and this gate must see what the BROWSER
 * sees, not what the spec prefers.  It is required on a NAMED reference,
 * matching the attribute-value rule that leaves `&ampx` literal.
 */
export function decodeHtmlReferences(value: string): string {
  return value.replace(
    /&(?:#([0-9]+);?|#[xX]([0-9a-fA-F]+);?|([a-zA-Z][a-zA-Z0-9]*);)/g,
    (whole, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return codePointOrRaw(Number.parseInt(decimal, 10), whole);
      if (hex !== undefined) return codePointOrRaw(Number.parseInt(hex, 16), whole);
      return name === undefined ? whole : (NAMED_REFERENCES.get(name) ?? whole);
    },
  );
}

/** A code point HTML would render, or the reference unchanged when it would not. */
function codePointOrRaw(code: number, whole: string): string {
  // Surrogates and out-of-range values become U+FFFD in a real parser; leaving
  // them raw keeps this a comparison problem rather than a decoding one, and
  // neither can spell a directive.
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole;
  if (code >= 0xd800 && code <= 0xdfff) return whole;
  return String.fromCodePoint(code);
}

/**
 * The tag's attributes as CSP would see them: first spelling wins, values
 * decoded.
 *
 * The PARSING is the reader's — this file no longer has an attribute pattern of
 * its own, which is what let it split `data=x=http-equiv=…` into two attributes
 * and read an `http-equiv` the browser never creates.  What remains here is the
 * gate's own semantics: a DUPLICATE attribute keeps its first value (the
 * tokenizer discards later ones), and values are entity-decoded because the
 * tokenizer decodes them before CSP ever sees them.  Names are NOT decoded —
 * the tokenizer does not decode references in a name, so `http-equi&#118;` is
 * genuinely a different attribute.
 */
function parseTagAttributes(tag: HtmlTag): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const attribute of tag.attributes) {
    if (attribute.name === '') continue;
    if (!attributes.has(attribute.name)) {
      attributes.set(attribute.name, decodeHtmlReferences(attribute.value));
    }
  }
  return attributes;
}

/**
 * Every `<meta http-equiv="Content-Security-Policy">` content value in a
 * document.  ALL of them, not the first: two such tags intersect rather than
 * override, so a stray second one changes the effective policy.
 *
 * A CSP meta with NO `content` yields `''` rather than being skipped.  It is
 * still a policy-bearing tag as far as this gate is concerned — the source
 * document must carry none, and an empty delivered policy is a mismatch to
 * report, not a tag to overlook.
 */
export function extractMetaPolicies(html: string): string[] {
  return findMetaPolicies(html).map((entry) => entry.policy);
}

/** A CSP `<meta>` and where in the document it sits. */
export interface MetaPolicy {
  readonly policy: string;
  /** Byte offset of the tag's `<`. */
  readonly at: number;
}

/** {@link extractMetaPolicies}, keeping each tag's OFFSET for the ordering check. */
export function findMetaPolicies(html: string): MetaPolicy[] {
  const found: MetaPolicy[] = [];
  // Real ELEMENTS, not `<meta` substrings.  A `<meta>` written inside a comment,
  // inside a `<template>`, or serialized into an attribute value creates no
  // element — the browser sees no policy — and counting one would let this gate
  // report the courier as carrying a CSP it does not have.
  for (const tag of scanTags(html)) {
    if (tag.name !== 'meta' || tag.closing) continue;
    const attributes = parseTagAttributes(tag);
    if (attributes.get('http-equiv')?.toLowerCase() !== 'content-security-policy') continue;
    found.push({ policy: attributes.get('content') ?? '', at: tag.at });
  }
  return found;
}

/**
 * Tags whose content a policy delivered AFTER them would never have governed.
 *
 * A `<meta>` policy applies only to what the parser processes once it has been
 * seen — it does not reach back over a `<script>` already fetched or a `<base>`
 * already applied.  On the web the response header covers that gap, but the
 * native courier WebView has NO server headers: the meta is the whole policy
 * there, so a build step that reordered the head would leave the courier's
 * earliest content ungoverned while every string comparison still matched.
 */
const CONTROLLED_TAGS: ReadonlySet<string> = new Set([
  'script',
  'link',
  'style',
  'base',
  'iframe',
  'object',
  'embed',
  'img',
  'svg',
]);

/**
 * What may appear in `<head>` without ending it (HTML tree construction, the
 * "in head" insertion mode).
 *
 * The head does NOT need a `</head>` to close: the parser closes it IMPLICITLY
 * at the first token that is not head content, so `<head><body><meta …>` puts
 * the policy in the BODY.  CSP L3 §3.3 only honours a `<meta>` that is a child
 * of `<head>`, so such a policy is never applied — and a check looking for a
 * textual `</head>` sees a document that never closes its head and certifies it.
 */
const HEAD_CONTENT: ReadonlySet<string> = new Set([
  'base',
  'basefont',
  'bgsound',
  'link',
  'meta',
  'noframes',
  'noscript',
  'script',
  'style',
  'template',
  'title',
]);

/**
 * The byte range the parser actually treats as `<head>` content, or `undefined`
 * when the document has no head a `<meta>` could be a child of.
 *
 * Walked as a small state machine rather than "find `<head>`, then find its
 * end", because BOTH boundaries are implied as often as they are written:
 *
 *   • a `<head>` start tag AFTER body content has begun is IGNORED — the parser
 *     is already in the body insertion mode — so `<html><body><head><meta …>`
 *     leaves the policy in the body, ineffective, while a textual search finds
 *     a perfectly good `head` to measure from;
 *   • the head closes at the first token that is not head content, with or
 *     without a `</head>`.
 *
 * A document with NO explicit `<head>` is reported as having none, even though
 * the parser would imply one around leading head content.  That is stricter
 * than the parser and deliberately so: this gate's one unacceptable failure is
 * certifying a courier that ships unprotected, so where the model is unsure it
 * reports rather than accepts.  The built artifact always carries an explicit
 * head.
 */
function findHeadRange(
  nodes: readonly HtmlNode[],
): { from: number; to: number; endedBy?: HtmlNode } | undefined {
  let from: number | undefined;
  for (const tag of nodes) {
    if (tag.kind === 'text') {
      // A WHITESPACE character token is inserted into the head and changes
      // nothing; any other character closes it.  `&nbsp;` is not HTML
      // whitespace (only tab, LF, FF, CR and space are), so it closes the head
      // too — hence the decode before the test.
      // Whitespace is harmless WHEREVER it falls: before the head it is
      // ignored, inside it is inserted.  Only other characters imply the head's
      // end — and reaching one before a `<head>` means the parser implied an
      // EMPTY head, so there is none for a `<meta>` to be a child of.
      if (HTML_WHITESPACE_ONLY.test(decodeHtmlReferences(tag.text))) continue;
      return from === undefined ? undefined : { from, to: tag.at, endedBy: tag };
    }
    if (tag.closing) {
      if (HEAD_CLOSING_END_TAGS.has(tag.name)) {
        return from === undefined ? undefined : { from, to: tag.at, endedBy: tag };
      }
      continue; // `</title>`, `</style>`, … — still inside the head
    }
    if (tag.name === 'html') continue; // the root element; a head may still follow
    if (tag.name === 'head') {
      if (from === undefined) from = tag.end;
      continue; // a SECOND `<head>` start tag is a parse error and ignored
    }
    // Anything else is body content.  Reached before a `<head>`, it means the
    // parser implied an EMPTY head and moved on, so no later `<head>` counts.
    if (from === undefined) return undefined;
    if (!HEAD_CONTENT.has(tag.name)) return { from, to: tag.at, endedBy: tag };
  }
  return from === undefined ? undefined : { from, to: Number.POSITIVE_INFINITY };
}

/**
 * End tags that END the head, per the "in head" insertion mode.
 *
 * `</head>` pops it; `</body>`, `</html>` and — the one that reads as a typo but
 * is in the spec — `</br>` are handled by the "anything else" entry, which pops
 * the head and REPROCESSES the token in the body.  Every OTHER end tag there is
 * a parse error and ignored, which is why this is a closed set rather than
 * "any end tag".
 */
const HEAD_CLOSING_END_TAGS: ReadonlySet<string> = new Set(['head', 'body', 'html', 'br']);

/** Only tab, LF, FF, CR and space are HTML whitespace — notably NOT `&nbsp;`. */
const HTML_WHITESPACE_ONLY = /^[\t\n\f\r ]*$/;

/** Where the CSP meta must sit: inside `<head>`, ahead of anything it governs. */
function findPlacementProblem(html: string, policyAt: number): string | null {
  // The same element walk the policy itself was found by: a `<head>` or a
  // `<script>` named inside a comment, inside inert content, or inside an
  // attribute value is not an element, and treating one as markup would move
  // the very boundary this check is about.
  const nodes = scanNodes(html);
  const head = findHeadRange(nodes);
  if (head === undefined || policyAt < head.from) {
    return `${BUILT_INDEX_HTML_FILE}: the CSP <meta> is not inside <head>.`;
  }
  if (policyAt > head.to) {
    const ended = head.endedBy;
    const how =
      ended === undefined
        ? 'outside <head>'
        : ended.kind === 'text'
          ? 'outside <head> — the parser closes the head at the text before it'
          : ended.closing
            ? `AFTER </${ended.name}>`
            : `outside <head> — the parser closes the head implicitly at <${ended.name}>`;
    return (
      `${BUILT_INDEX_HTML_FILE}: the CSP <meta> sits ${how}. A meta policy is honoured only ` +
      'as a child of <head> (CSP L3 §3.3), and the courier WebView has no header to fall back on.'
    );
  }
  const controlled = nodes.find(
    (node) => node.kind === 'tag' && !node.closing && CONTROLLED_TAGS.has(node.name),
  );
  if (controlled !== undefined && controlled.at < policyAt) {
    return (
      `${BUILT_INDEX_HTML_FILE}: a <${controlled.name}> precedes the CSP <meta>. A meta policy ` +
      'does not apply retroactively, so that element would load OUTSIDE the policy — and in ' +
      'the courier WebView there is no response header behind it.'
    );
  }
  return null;
}

export interface CspDelivery {
  /** `apps/web/index.html` — the SOURCE document (must carry no policy). */
  indexHtml: string;
  /** `apps/web/dist/index.html` when a build has produced one. */
  builtIndexHtml?: string | undefined;
}

/** Pure: every delivery problem (empty ⇒ the built artifact carries the policy). */
export function findCspDeliveryProblems(delivery: CspDelivery): string[] {
  const problems: string[] = [];
  const expected = contentSecurityPolicyMeta();

  // The SOURCE must stay policy-free: the plugin injects, and a second policy
  // would silently intersect with it.
  const inSource = extractMetaPolicies(delivery.indexHtml);
  if (inSource.length > 0) {
    problems.push(
      `${INDEX_HTML_FILE}: carries a hand-written CSP <meta>. The policy is injected at ` +
        'build time from packages/shared/src/security/csp.ts — a source copy would ' +
        'INTERSECT with the injected one (CSP L3 §8.1), not replace it.',
    );
  }

  if (delivery.builtIndexHtml === undefined) return problems;

  const delivered = findMetaPolicies(delivery.builtIndexHtml);
  const built = delivered.map((entry) => entry.policy);
  if (built.length === 0) {
    problems.push(
      `${BUILT_INDEX_HTML_FILE}: no <meta http-equiv="Content-Security-Policy"> — the ` +
        'injection plugin did not fire, and the native courier WebView would ship ' +
        'with NO policy at all.',
    );
    return problems;
  }
  if (built.length > 1) {
    problems.push(`${BUILT_INDEX_HTML_FILE}: ${built.length} CSP <meta> tags; expected exactly 1.`);
  }
  // WHERE the tag sits is as load-bearing as what it says: matching the policy
  // text proves nothing about content the parser reached before it.
  const placement = findPlacementProblem(delivery.builtIndexHtml, delivered[0]?.at ?? 0);
  if (placement !== null) problems.push(placement);
  const actual = parsePolicyString(built[0] ?? '');
  if (actual.join('; ') !== parsePolicyString(expected).join('; ')) {
    problems.push(
      `${BUILT_INDEX_HTML_FILE}: the injected policy does not match the shared source.\n` +
        `      expected: ${expected}\n` +
        `      actual:   ${actual.join('; ')}`,
    );
  }
  // A meta-ineligible directive is silently IGNORED by the browser, so its
  // presence reads as protection that is not in force.
  for (const directive of actual) {
    if (META_INELIGIBLE_DIRECTIVES.includes(directiveName(directive))) {
      problems.push(
        `${BUILT_INDEX_HTML_FILE}: "${directiveName(directive)}" is IGNORED in a <meta> ` +
          'policy (CSP L3 §3.3) — it belongs in the response header only',
      );
    }
  }
  return problems;
}

/**
 * Read a file, or `undefined` when it is not there.
 *
 * ATTEMPTS the read rather than stat-ing first: a `statSync` guard followed by a
 * `readFileSync` is a check-then-use race (CodeQL `js/file-system-race`) — the
 * file can vanish between the two, and the guard buys nothing the error handling
 * does not already provide.
 */
function readIfPresent(relative: string): string | undefined {
  try {
    return readFileSync(resolve(ROOT, relative), 'utf-8');
  } catch {
    return undefined;
  }
}

function main(): void {
  const read = (relative: string): string => readFileSync(resolve(ROOT, relative), 'utf-8');
  // `--require-build` is how the BUILD job says "a build just ran here".
  //
  // Without it a missing `dist/index.html` is the ordinary pre-build case and the
  // gate reports "no build to check" — which is right for the static-gates job,
  // and WRONG after a build: a build that silently stopped emitting the document
  // would leave the courier with neither a policy nor an app shell, and this
  // security gate would still print a pass.  Absence has to mean different things
  // in the two jobs, so the caller states which one it is.
  const requireBuild = process.argv.includes('--require-build');
  const builtIndexHtml = readIfPresent(BUILT_INDEX_HTML_FILE);
  if (requireBuild && builtIndexHtml === undefined) {
    console.error(
      `check:csp-parity FAILED — ${BUILT_INDEX_HTML_FILE} is missing after a build.\n` +
        '  The courier packages this file; without it there is no injected policy and no\n' +
        '  app shell to apply one to.',
    );
    process.exit(1);
  }

  const problems = findCspDeliveryProblems({ indexHtml: read(INDEX_HTML_FILE), builtIndexHtml });
  if (problems.length > 0) {
    console.error('check:csp-parity FAILED — the CSP is not being delivered as defined:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '\n  packages/shared/src/security/csp.ts is the ONLY definition. The API header and\n' +
        '  the vite preview header import it; the <meta> is injected into the built HTML\n' +
        '  by the `licio:inject-csp-meta` plugin in apps/web/vite.config.ts.',
    );
    process.exit(1);
  }

  console.log(
    'check:csp-parity passed: one CSP definition' +
      `${builtIndexHtml === undefined ? '; no build to check (pass --require-build after one)' : `, correctly injected into ${BUILT_INDEX_HTML_FILE}`}.`,
  );
}

// Run as a CLI only; importing for tests must not trigger the scan.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
