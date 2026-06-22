// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dev-server build helper (NOT app runtime code — imported only by
// `vite.config.ts`, so it never enters the client bundle).  `index.html` ships
// the full production Content-Security-Policy as a `<meta http-equiv>` because
// it is the SOLE CSP source in the WS-R.15.4a native-courier WebView (which
// serves the built assets from `https://localhost` with no server headers).
// That policy is correct for the production build + the preview server (whose
// header sends the same CSP), but in the Vite DEV server it breaks the app:
// HMR injects inline `<style>` + inline/eval script + a dev WebSocket, all of
// which `style-src 'self'` / `require-trusted-types-for 'script'` /
// `connect-src 'self'` block — leaving the app unstyled and flooding the
// console with violations.  This pure transform removes ONLY the CSP `<meta>`
// (self-closing, possibly multi-line) and is used by the `apply: 'serve'`
// plugin, so `vite build` (courier `dist` + preview) keeps the meta untouched.

/** Matches the self-closing CSP `<meta http-equiv="Content-Security-Policy" … />`
 *  tag (including its leading indentation + a trailing newline), across lines. */
const CSP_META_PATTERN = /[ \t]*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\n?/i;

/** Return `html` with the production CSP `<meta>` removed (idempotent: a string
 *  with no such tag is returned unchanged).  Touches nothing else. */
export function stripDevCspMeta(html: string): string {
  return html.replace(CSP_META_PATTERN, '');
}
