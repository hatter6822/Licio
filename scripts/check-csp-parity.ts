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
 * One HTML attribute: a name, then optionally `=` and a value in any of the
 * three forms the parser accepts — double-quoted, single-quoted, or UNQUOTED
 * (WHATWG HTML §13.1.2.3).  The unquoted form is why this is a parser rather
 * than a pair of `content="…"` / `content='…'` patterns: `<meta
 * http-equiv=Content-Security-Policy content="…">` is valid HTML that a browser
 * honours in full, and a quote-only matcher does not see it at all.
 */
const ATTRIBUTE = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]*)))?/g;

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

/** Attributes of a start tag, names lower-cased (HTML names are ASCII-insensitive). */
function parseTagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  // Past `<meta` — otherwise the tag name parses as the first attribute.
  const body = tag.replace(/^<[a-zA-Z][^\s/>]*/, '');
  ATTRIBUTE.lastIndex = 0;
  for (const match of body.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    if (name === undefined || name === '') continue;
    // The NAME is not entity-decoded — the tokenizer does not decode references
    // in attribute names, so `http-equi&#118;` really is a different attribute.
    const raw = match[2] ?? match[3] ?? match[4] ?? '';
    if (!attributes.has(name)) attributes.set(name, decodeHtmlReferences(raw));
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
  const found: string[] = [];
  // Quoted runs are matched as units so a `>` INSIDE an attribute value cannot
  // end the tag early and hide the attributes after it.
  for (const tag of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attributes = parseTagAttributes(tag[0]);
    if (attributes.get('http-equiv')?.toLowerCase() !== 'content-security-policy') continue;
    found.push(attributes.get('content') ?? '');
  }
  return found;
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

  const built = extractMetaPolicies(delivery.builtIndexHtml);
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
