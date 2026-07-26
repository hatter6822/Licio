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

/**
 * Blank the CONTENT of every HTML comment, preserving length and newlines.
 *
 * `<head>` inside a comment is NOT the head — the parser discards the whole
 * comment — but a pattern scanning raw text cannot tell, and would inject the
 * policy into it.  The result is a document whose only CSP sits in a comment:
 * no policy at all, and in the courier WebView no response header to fall back
 * on, while every string comparison downstream still matches.
 *
 * Masking rather than deleting keeps every offset valid, so a caller can scan
 * the masked copy and splice into (or report against) the ORIGINAL.  Shared
 * with `check:csp-parity` so the injector and the gate that verifies it agree
 * on what counts as markup — two spellings of that rule is how a green gate
 * ends up describing a document nobody delivers.
 */
export function maskHtmlComments(html: string): string {
  // UTF-16 units, matching `indexOf`/`slice`, so offsets stay comparable.
  const chars = html.split('');
  let i = 0;
  while (i < chars.length) {
    if (!html.startsWith('<!--', i)) {
      i += 1;
      continue;
    }
    const close = html.indexOf('-->', i + 4);
    // An unterminated comment runs to the end of the document, as in a parser.
    const end = close === -1 ? chars.length : close + 3;
    for (let k = i; k < end; k += 1) if (chars[k] !== '\n') chars[k] = ' ';
    i = end;
  }
  return chars.join('');
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
  // Located in the MASKED copy so a `<head>` written inside a comment cannot
  // capture the injection; spliced into the original, whose offsets it shares.
  const match = HEAD_OPEN.exec(maskHtmlComments(html));
  if (!match) return html;
  const tag = `\n    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}" />`;
  return (
    html.slice(0, match.index + match[0].length) + tag + html.slice(match.index + match[0].length)
  );
}
