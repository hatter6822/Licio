// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MiddlewareHandler } from 'hono';
import { getCanonicalAppOrigin } from './cors.js';

const CSP = [
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
].join('; ');

const REPORT_PATH = '/api/security/csp-report';
const REPORTING_ENDPOINTS = `csp-endpoint="${REPORT_PATH}"`;

/**
 * The legacy v0 Reporting API (`Report-To`) is the ONE header here that rejects a
 * relative endpoint URL, so it needs an absolute one.  That origin comes from the
 * operator-configured `CORS_ORIGIN` and NEVER from the request: `Host` and
 * `X-Forwarded-Host` are attacker-controllable, and a single poisoned shared-cache
 * entry would redirect every later visitor's CSP violation reports — which carry
 * the document URL — to a third-party collector for `max_age` seconds.  That is
 * also precisely the third-party egress the app's own `connect-src 'self'`
 * doctrine forbids (reporting endpoints are not governed by `connect-src`).
 *
 * With no canonical origin configured the header is simply OMITTED: `report-uri`
 * in the CSP and the v1 `Reporting-Endpoints` header above are both relative, and
 * `Reporting-Endpoints` is what every browser that still reports actually reads —
 * `Report-To` was never implemented by Firefox or Safari and Chrome has migrated
 * off it.  Losing it costs nothing; forging it costs the reader's privacy.
 *
 * Computed per request from `process.env` (kept in step with `getAllowedOrigins`,
 * which does the same) but memoized on the resolved origin so the JSON is
 * serialized once per distinct value rather than on every response.
 */
let reportToCache: { origin: string; header: string } | null = null;

function reportToHeader(): string | null {
  const origin = getCanonicalAppOrigin();
  if (origin === null) return null;
  if (reportToCache?.origin !== origin) {
    reportToCache = {
      origin,
      header: JSON.stringify({
        group: 'csp-endpoint',
        max_age: 86400,
        endpoints: [{ url: `${origin}${REPORT_PATH}` }],
      }),
    };
  }
  return reportToCache.header;
}

export function securityHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    c.res.headers.set('Content-Security-Policy', CSP);
    c.res.headers.set('Reporting-Endpoints', REPORTING_ENDPOINTS);
    const reportTo = reportToHeader();
    if (reportTo !== null) c.res.headers.set('Report-To', reportTo);
    c.res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'SAMEORIGIN');
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    c.res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    c.res.headers.set(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), serial=(), midi=()',
    );
  };
}
