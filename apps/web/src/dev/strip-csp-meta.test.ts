// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Proves the dev-server CSP-meta strip (apps/web/src/dev/strip-csp-meta.ts):
// the production CSP `<meta>` is removed in `vite dev` (so HMR's inline styles /
// scripts / dev WebSocket are not blocked) while EVERYTHING else in the HTML is
// preserved.  Guards the regex against regression — the empirical fix for the
// "completely unstyled dev UI + console CSP violations" report.
import { describe, expect, it } from 'vitest';
import { stripDevCspMeta } from './strip-csp-meta.js';

// The real (multi-line, self-closing) tag from apps/web/index.html.
const CSP_META = `    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; trusted-types default dompurify licio-ugc; require-trusted-types-for 'script'"
    />`;

const VIEWPORT = `    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`;

const docWith = (...lines: string[]): string =>
  `<!doctype html>\n<html lang="en">\n  <head>\n${lines.join('\n')}\n  </head>\n  <body></body>\n</html>\n`;

describe('stripDevCspMeta', () => {
  it('removes the multi-line CSP <meta> tag', () => {
    const out = stripDevCspMeta(docWith(CSP_META, VIEWPORT));
    expect(out).not.toContain('Content-Security-Policy');
    expect(out).not.toContain('require-trusted-types-for');
  });

  it('preserves every OTHER element (only the CSP meta goes)', () => {
    const out = stripDevCspMeta(docWith(CSP_META, VIEWPORT));
    // The viewport meta, the doctype, and the document structure survive intact.
    expect(out).toContain(VIEWPORT.trim());
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('<body></body>');
  });

  it('does NOT touch a same-origin connect-src in a non-CSP attribute', () => {
    // A defensive check that the strip is anchored to the http-equiv meta, not
    // to the CSP text: an unrelated element mentioning the directive survives.
    const decoy = `    <link rel="preconnect" href="https://fonts" data-note="connect-src 'self'" />`;
    const out = stripDevCspMeta(docWith(CSP_META, decoy));
    expect(out).toContain(decoy.trim());
    expect(out).not.toContain('http-equiv="Content-Security-Policy"');
  });

  it('is idempotent / a no-op when there is no CSP meta (the built output)', () => {
    const noCsp = docWith(VIEWPORT);
    expect(stripDevCspMeta(noCsp)).toBe(noCsp);
    // Running it twice removes exactly one tag and then changes nothing.
    const once = stripDevCspMeta(docWith(CSP_META, VIEWPORT));
    expect(stripDevCspMeta(once)).toBe(once);
  });
});
