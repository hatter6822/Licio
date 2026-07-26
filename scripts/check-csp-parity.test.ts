// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the CSP delivery gate's pure core, plus tests that run it
// against the REAL repository files — so the suite fails if `index.html` regrows
// a hand-written policy, or (after a build) if the injection stops firing.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectCspMeta, maskInertMarkup } from '../apps/web/src/dev/inject-csp-meta.js';
import {
  CSP_DIRECTIVES,
  contentSecurityPolicyHeader,
  contentSecurityPolicyMeta,
  META_INELIGIBLE_DIRECTIVES,
} from '../packages/shared/src/security/csp.js';
import {
  BUILT_INDEX_HTML_FILE,
  decodeHtmlReferences,
  extractMetaPolicies,
  findCspDeliveryProblems,
  INDEX_HTML_FILE,
  parsePolicyString,
} from './check-csp-parity.js';

const ROOT = resolve(import.meta.dirname, '..');
const HEAD = (body: string): string =>
  `<!doctype html><html><head>${body}</head><body></body></html>`;

describe('the shared CSP source', () => {
  it('serializes the header as the full directive list', () => {
    expect(contentSecurityPolicyHeader()).toBe(CSP_DIRECTIVES.join('; '));
  });

  it('serializes the meta as the header MINUS exactly the §3.3-ignored directives', () => {
    const meta = parsePolicyString(contentSecurityPolicyMeta());
    const dropped = CSP_DIRECTIVES.filter((d) => !meta.includes(d)).map(
      (d) => d.split(/\s+/)[0] ?? '',
    );
    expect(dropped.sort()).toEqual([...META_INELIGIBLE_DIRECTIVES].sort());
  });

  it('never admits an unsafe script source', () => {
    const header = contentSecurityPolicyHeader();
    expect(header).not.toContain('unsafe-inline');
    expect(header).not.toContain('unsafe-eval');
    expect(header).toContain("require-trusted-types-for 'script'");
    expect(header).toContain("connect-src 'self'");
  });
});

describe('injectCspMeta', () => {
  it('inserts exactly one tag directly after <head>', () => {
    const out = injectCspMeta(HEAD('<meta charset="UTF-8" />'), "default-src 'self'");
    expect(extractMetaPolicies(out)).toEqual(["default-src 'self'"]);
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('charset'));
  });

  it('handles a <head> carrying attributes', () => {
    const out = injectCspMeta('<html><head lang="en"></head></html>', "default-src 'self'");
    expect(extractMetaPolicies(out)).toEqual(["default-src 'self'"]);
  });

  it('escapes the attribute rather than concatenating raw', () => {
    const out = injectCspMeta(HEAD(''), 'x "y" <z>');
    expect(out).toContain('content="x &quot;y&quot; &lt;z&gt;"');
  });

  it('returns the document unchanged when there is no <head> to inject into', () => {
    const html = '<html><body></body></html>';
    expect(injectCspMeta(html, "default-src 'self'")).toBe(html);
  });

  // `<head>` inside a comment is not the head — the parser discards the whole
  // comment.  Injecting into one produces a document whose ONLY policy sits in a
  // comment: no CSP at all, and in the courier no header to fall back on, while
  // every string comparison downstream still matches.
  it('injects into the REAL head, not a commented one', () => {
    const html = `<!doctype html><html><!-- docs: <head> --><head><title>t</title></head><body></body></html>`;
    const out = injectCspMeta(html, "default-src 'self'");
    expect(out.indexOf('Content-Security-Policy')).toBeGreaterThan(out.indexOf('<head>'));
    expect(extractMetaPolicies(out)).toEqual(["default-src 'self'"]);
  });

  it('leaves a document alone when its only <head> is inside a comment', () => {
    const html = '<html><!-- <head> --><body></body></html>';
    expect(injectCspMeta(html, "default-src 'self'")).toBe(html);
  });

  it('masks an UNTERMINATED comment to the end, as a parser would', () => {
    expect(maskInertMarkup('a<!-- b <head> c').trimEnd()).toBe('a');
  });

  it('preserves length and newlines so offsets stay valid', () => {
    const html = 'a<!-- x\ny -->b';
    const masked = maskInertMarkup(html);
    expect(masked).toHaveLength(html.length);
    expect(masked.split('\n')).toHaveLength(html.split('\n').length);
    expect(masked.indexOf('b')).toBe(html.indexOf('b'));
  });
});

describe('inert content is not markup', () => {
  const POLICY = contentSecurityPolicyMeta();
  const META = `<meta http-equiv="Content-Security-Policy" content="${POLICY.replace(/"/g, '&quot;')}">`;
  const problems = (builtIndexHtml: string): string[] =>
    findCspDeliveryProblems({ indexHtml: '<html><head></head></html>', builtIndexHtml });

  // `<template>` content IS parsed, but into an inert fragment — a CSP meta
  // there has no effect at all, while looking exactly like a delivered policy to
  // anything matching on text.  That makes it the most dangerous of the set.
  it('does not read a CSP <meta> inside a <template> as a policy', () => {
    expect(extractMetaPolicies(`<html><head><template>${META}</template></head></html>`)).toEqual(
      [],
    );
  });

  it('REJECTS an artifact whose only policy is inside a <template>', () => {
    const found = problems(`<html><head><template>${META}</template></head><body></body></html>`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('no <meta http-equiv="Content-Security-Policy">');
  });

  it('handles NESTED templates', () => {
    const html = `<html><head><template><template></template>${META}</template></head></html>`;
    expect(extractMetaPolicies(html)).toEqual([]);
  });

  it('does not read a <meta> written inside <script> TEXT as a tag', () => {
    const html = `<html><head><script>var s = '${META}';</script></head></html>`;
    expect(extractMetaPolicies(html)).toEqual([]);
  });

  it('accepts a real policy that follows an inert template', () => {
    expect(
      problems(`<html><head><template><b></b></template>${META}</head><body></body></html>`),
    ).toEqual([]);
  });

  it('keeps the element TAGS visible, so a <script> still trips placement', () => {
    const found = problems(
      `<html><head><script src="/a.js"></script>${META}</head><body></body></html>`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('a <script> precedes the CSP <meta>');
  });

  it('does not let a <head> inside a template capture the injection', () => {
    const html = '<html><template><head></head></template><head></head><body></body></html>';
    const out = injectCspMeta(html, "default-src 'self'");
    expect(extractMetaPolicies(out)).toEqual(["default-src 'self'"]);
  });
});

describe('a commented tag is not markup', () => {
  it('does not read a CSP <meta> inside a comment as a policy', () => {
    const html = `<html><head><!-- <meta http-equiv="Content-Security-Policy" content="x"> --></head></html>`;
    expect(extractMetaPolicies(html)).toEqual([]);
  });

  it('does not let a <script> NAMED in a comment trip the placement check', () => {
    const policy = contentSecurityPolicyMeta();
    const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}">`;
    const problems = findCspDeliveryProblems({
      indexHtml: '<html><head></head></html>',
      builtIndexHtml: `<html><head><!-- see <script src="x"> -->${meta}</head><body></body></html>`,
    });
    expect(problems).toEqual([]);
  });
});

describe('extractMetaPolicies', () => {
  it('reads a multi-line tag and ignores unrelated metas', () => {
    const html = HEAD(
      `<meta name="viewport" content="width=device-width" />\n<meta\n  http-equiv="Content-Security-Policy"\n  content="default-src 'self'"\n/>`,
    );
    expect(extractMetaPolicies(html)).toEqual(["default-src 'self'"]);
  });

  it('reports EVERY policy tag (two of them intersect, they do not override)', () => {
    const html = HEAD(
      `<meta http-equiv="Content-Security-Policy" content="a 'self'">` +
        `<meta http-equiv="Content-Security-Policy" content="b 'self'">`,
    );
    expect(extractMetaPolicies(html)).toEqual(["a 'self'", "b 'self'"]);
  });

  // HTML5 attribute values need no quotes (WHATWG HTML §13.1.2.3), and a browser
  // honours the tag either way.  A quote-only matcher does not see these at all,
  // which would let a hand-written policy back into the source document — the
  // exact thing this gate exists to refuse.
  it('reads an UNQUOTED http-equiv', () => {
    const html = HEAD(`<meta http-equiv=Content-Security-Policy content="default-src 'self'">`);
    expect(extractMetaPolicies(html)).toEqual(["default-src 'self'"]);
  });

  it('reads an unquoted content value (which cannot hold a space)', () => {
    const html = HEAD(`<meta http-equiv=Content-Security-Policy content=default-src>`);
    expect(extractMetaPolicies(html)).toEqual(['default-src']);
  });

  it('reads single-quoted attributes', () => {
    const html = HEAD(`<meta http-equiv='Content-Security-Policy' content='default-src *'>`);
    expect(extractMetaPolicies(html)).toEqual(['default-src *']);
  });

  it('matches http-equiv case-insensitively, in name AND value', () => {
    const html = HEAD(`<meta HTTP-EQUIV="content-security-policy" CONTENT="default-src *">`);
    expect(extractMetaPolicies(html)).toEqual(['default-src *']);
  });

  it('reports a CSP meta with NO content as an empty policy, not as absent', () => {
    // Skipping it would let `<meta http-equiv=Content-Security-Policy>` sit in
    // the source unnoticed; an empty policy is a mismatch to report.
    expect(extractMetaPolicies(HEAD(`<meta http-equiv=Content-Security-Policy>`))).toEqual(['']);
  });

  it('is not fooled by a `>` inside an attribute value', () => {
    const html = HEAD(
      `<meta name="x" content="a>b" http-equiv="Content-Security-Policy" content="default-src 'self'">`,
    );
    // One tag: `content` is first-wins, and `http-equiv` is still found after
    // the value carrying the `>`.
    expect(extractMetaPolicies(html)).toEqual(['a>b']);
  });

  it('ignores the tag name, not just the first attribute', () => {
    expect(extractMetaPolicies(HEAD(`<metadata http-equiv=Content-Security-Policy>`))).toEqual([]);
  });

  // The HTML tokenizer decodes character references in attribute VALUES before
  // the value reaches CSP, so a reference-spelled tag is enforced in full while
  // a raw comparison sees a different string.
  it('decodes a character reference in http-equiv', () => {
    const html = HEAD(`<meta http-equiv="Content-Security-Polic&#121;" content="default-src *">`);
    expect(extractMetaPolicies(html)).toEqual(['default-src *']);
  });

  it('decodes hex and semicolon-less numeric references', () => {
    expect(
      extractMetaPolicies(HEAD(`<meta http-equiv="Content-Security-Polic&#x79;" content="a">`)),
    ).toEqual(['a']);
    // HTML5 decodes `&#121` too (with a parse error); the gate must see what the
    // BROWSER sees, not what the spec prefers.
    expect(
      extractMetaPolicies(HEAD(`<meta http-equiv="Content-Security-Polic&#121" content="a">`)),
    ).toEqual(['a']);
  });

  it('decodes references in the CONTENT value too', () => {
    const html = HEAD(
      `<meta http-equiv="Content-Security-Policy" content="default-src &apos;self&apos;&semi; img-src &ast;">`,
    );
    expect(extractMetaPolicies(html)).toEqual(["default-src 'self'; img-src *"]);
  });

  it('leaves an unknown named reference alone rather than guessing', () => {
    // Every named reference outside the ASCII table produces a non-ASCII
    // character, which cannot spell a directive — so leaving it raw yields a
    // MISMATCH the gate reports, never a policy it fails to see.
    expect(decodeHtmlReferences('a &notareference; b')).toBe('a &notareference; b');
    expect(decodeHtmlReferences('&ampx')).toBe('&ampx');
  });

  it('does not decode a reference in the attribute NAME', () => {
    // The tokenizer does not decode references in names, so this really is a
    // different attribute and the tag carries no policy.
    expect(
      extractMetaPolicies(HEAD(`<meta http-equi&#118;="Content-Security-Policy" content="a">`)),
    ).toEqual([]);
  });

  it('leaves an out-of-range or surrogate code point raw', () => {
    expect(decodeHtmlReferences('&#x110000;')).toBe('&#x110000;');
    expect(decodeHtmlReferences('&#xD800;')).toBe('&#xD800;');
    expect(decodeHtmlReferences('&#0;')).toBe('&#0;');
  });

  it('round-trips an ordinary policy unchanged', () => {
    expect(decodeHtmlReferences("default-src 'self'; frame-ancestors 'none'")).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );
  });
});

// A meta policy governs only what the parser reaches AFTER it — it does not
// reach back over a script already fetched.  On the web the response header
// covers that; the courier WebView has no header at all, so the tag's POSITION
// is as load-bearing as its text, and matching the policy string proves nothing
// about content parsed before it.
describe('the delivered CSP meta must precede what it governs', () => {
  const POLICY = contentSecurityPolicyMeta();
  const META = `<meta http-equiv="Content-Security-Policy" content="${POLICY.replace(/"/g, '&quot;')}">`;
  const built = (head: string): string => `<html><head>${head}</head><body></body></html>`;
  const problems = (builtIndexHtml: string): string[] =>
    findCspDeliveryProblems({ indexHtml: '<html><head></head></html>', builtIndexHtml });

  it('accepts the tag first in <head>', () => {
    expect(problems(built(`${META}<script src="/a.js"></script>`))).toEqual([]);
  });

  it('accepts a charset declaration ahead of it', () => {
    expect(problems(built(`<meta charset="utf-8">${META}`))).toEqual([]);
  });

  it.each([
    ['script', `<script src="/a.js"></script>`],
    ['link', `<link rel="stylesheet" href="/a.css">`],
    ['style', `<style>a{}</style>`],
    ['base', `<base href="/">`],
  ])('REJECTS a <%s> before it', (tag, markup) => {
    const found = problems(built(`${markup}${META}`));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(`a <${tag}> precedes the CSP <meta>`);
  });

  it('REJECTS a tag moved into the body', () => {
    const found = problems(`<html><head></head><body>${META}</body></html>`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('AFTER </head>');
  });
});

describe('findCspDeliveryProblems', () => {
  const injected = (): string => injectCspMeta(HEAD(''), contentSecurityPolicyMeta());

  it('accepts a policy-free source and a correctly injected build', () => {
    expect(findCspDeliveryProblems({ indexHtml: HEAD(''), builtIndexHtml: injected() })).toEqual(
      [],
    );
  });

  it('skips the build check when no build has run (the pre-build gate job)', () => {
    expect(findCspDeliveryProblems({ indexHtml: HEAD('') })).toEqual([]);
  });

  it('rejects a hand-written policy reintroduced into the SOURCE', () => {
    const problems = findCspDeliveryProblems({
      indexHtml: HEAD(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(INDEX_HTML_FILE);
    expect(problems[0]).toContain('INTERSECT');
  });

  it('catches an injection plugin that stopped firing (courier ships NO policy)', () => {
    const problems = findCspDeliveryProblems({ indexHtml: HEAD(''), builtIndexHtml: HEAD('') });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(BUILT_INDEX_HTML_FILE);
    expect(problems[0]).toContain('did not fire');
  });

  it('catches an injected policy that drifted from the shared source', () => {
    const weakened = injectCspMeta(
      HEAD(''),
      "default-src 'self'; script-src 'self' 'unsafe-inline'",
    );
    const problems = findCspDeliveryProblems({ indexHtml: HEAD(''), builtIndexHtml: weakened });
    expect(problems.some((p) => p.includes('does not match the shared source'))).toBe(true);
  });

  it('catches a header-only directive reaching the meta (silently ignored there)', () => {
    const withIgnored = injectCspMeta(
      HEAD(''),
      `${contentSecurityPolicyMeta()}; frame-ancestors 'self'`,
    );
    const problems = findCspDeliveryProblems({ indexHtml: HEAD(''), builtIndexHtml: withIgnored });
    expect(problems.some((p) => p.includes('IGNORED in a <meta>'))).toBe(true);
  });

  it('catches a duplicate tag', () => {
    const twice = injectCspMeta(injected(), contentSecurityPolicyMeta());
    const problems = findCspDeliveryProblems({ indexHtml: HEAD(''), builtIndexHtml: twice });
    expect(problems.some((p) => p.includes('expected exactly 1'))).toBe(true);
  });
});

describe('the REAL repository', () => {
  it('keeps apps/web/index.html free of a hand-written policy', () => {
    const indexHtml = readFileSync(resolve(ROOT, INDEX_HTML_FILE), 'utf-8');
    expect(findCspDeliveryProblems({ indexHtml })).toEqual([]);
  });

  it('injects the shared policy into the build, when one exists', () => {
    // Attempt the read instead of stat-ing first: check-then-use is a file-system
    // race (CodeQL `js/file-system-race`), and "no build in this checkout" is
    // exactly what the failed read already tells us.
    let builtIndexHtml: string | undefined;
    try {
      builtIndexHtml = readFileSync(resolve(ROOT, BUILT_INDEX_HTML_FILE), 'utf-8');
    } catch {
      return; // no build here
    }
    expect(
      findCspDeliveryProblems({
        indexHtml: readFileSync(resolve(ROOT, INDEX_HTML_FILE), 'utf-8'),
        builtIndexHtml,
      }),
    ).toEqual([]);
  });
});
