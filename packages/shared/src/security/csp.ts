// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Content-Security-Policy — ONE definition, three delivery points.
//
// The policy has to reach the browser three different ways, and it used to be
// written out three times to do so:
//
//   1. the production response header (`apps/api` security-headers middleware);
//   2. a `<meta http-equiv>` in the served document — REDUNDANT on the web, but
//      the SOLE policy in the WS-R.15.4a native courier WebView, which serves
//      the bundled assets from `https://localhost` with no server headers;
//   3. the `vite preview` header the Playwright E2E suite asserts against.
//
// Three hand-maintained copies meant tightening (1) alone silently left the
// courier — the most constrained runtime — on the WEAKEST policy, and the
// divergence was invisible in review because the copies live in different
// workspaces and file formats.  They all derive from here now: `apps/api`
// imports this module normally, and `apps/web/vite.config.ts` imports it by
// RELATIVE path (a bare `@licio/shared` specifier is EXTERNALISED by Vite's
// config loader, which then cannot resolve this package's `.js`-suffixed
// TypeScript source) to serve both the preview header and the `<meta>` it
// injects into the built HTML.
//
// Kept dependency-free and DOM-free so every one of those hosts can load it.

/**
 * The complete policy, in delivery order.
 *
 * `'unsafe-inline'`/`'unsafe-eval'` appear nowhere and must not: the Trusted
 * Types + DOMPurify content layer assumes script execution is confined to
 * same-origin bundles, and `connect-src 'self'` is what makes "the browser
 * never talks to a third party" true (anything external is proxied by the BFF).
 */
export const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'trusted-types default dompurify licio-ugc',
  "require-trusted-types-for 'script'",
  'report-uri /api/security/csp-report',
  'report-to csp-endpoint',
];

/**
 * Directives a `<meta http-equiv>` cannot carry.
 *
 * Per CSP Level 3 §3.3 the user agent IGNORES `frame-ancestors`, `report-uri`,
 * `report-to` and `sandbox` in a meta element.  Emitting one there would read
 * as protection that is not in force, so the meta form drops them — and only
 * them.
 *
 * `sandbox` is listed even though the header policy does not use one today:
 * the list exists so that adding a directive to the header cannot silently
 * ship an INERT copy of it in the meta form, and a list that only covers
 * today's directives fails at exactly the moment it is needed.
 */
export const META_INELIGIBLE_DIRECTIVES: readonly string[] = [
  'frame-ancestors',
  'report-uri',
  'report-to',
  'sandbox',
];

/** The directive name of a full directive (`script-src 'self'` → `script-src`). */
function directiveName(directive: string): string {
  return (directive.trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/** The serialized policy for a `Content-Security-Policy` RESPONSE HEADER. */
export function contentSecurityPolicyHeader(): string {
  return CSP_DIRECTIVES.join('; ');
}

/** The serialized policy for a `<meta http-equiv>` (header minus §3.3's ignored set). */
export function contentSecurityPolicyMeta(): string {
  return CSP_DIRECTIVES.filter((d) => !META_INELIGIBLE_DIRECTIVES.includes(directiveName(d))).join(
    '; ',
  );
}
