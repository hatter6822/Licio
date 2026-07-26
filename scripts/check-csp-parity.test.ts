// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the CSP delivery gate's pure core, plus tests that run it
// against the REAL repository files — so the suite fails if `index.html` regrows
// a hand-written policy, or (after a build) if the injection stops firing.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectCspMeta } from '../apps/web/src/dev/inject-csp-meta.js';
import {
  CSP_DIRECTIVES,
  contentSecurityPolicyHeader,
  contentSecurityPolicyMeta,
  META_INELIGIBLE_DIRECTIVES,
} from '../packages/shared/src/security/csp.js';
import {
  BUILT_INDEX_HTML_FILE,
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
