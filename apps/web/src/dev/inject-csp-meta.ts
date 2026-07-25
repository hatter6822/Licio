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

/** Where the tag goes: immediately after `<head>` (before any other metadata,
 *  matching how a server header applies to the whole document). */
const HEAD_OPEN = /<head(\s[^>]*)?>/i;

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
  const match = HEAD_OPEN.exec(html);
  if (!match) return html;
  const tag = `\n    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}" />`;
  return (
    html.slice(0, match.index + match[0].length) + tag + html.slice(match.index + match[0].length)
  );
}
