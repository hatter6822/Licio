// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MiddlewareHandler } from 'hono';

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

const REPORTING_ENDPOINTS = 'csp-endpoint="/api/security/csp-report"';

export function securityHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    // The legacy v0 Reporting-API (Report-To) rejects relative endpoint URLs,
    // so derive the server's own public origin per-request (proxy-aware) and
    // emit an absolute URL.  Naming the server's own origin from its Host /
    // X-Forwarded-Host is not client-IP handling (§19.1).
    const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
    const host =
      c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
    const origin = `${proto}://${host}`;

    c.res.headers.set('Content-Security-Policy', CSP);
    c.res.headers.set('Reporting-Endpoints', REPORTING_ENDPOINTS);
    c.res.headers.set(
      'Report-To',
      JSON.stringify({
        group: 'csp-endpoint',
        max_age: 86400,
        endpoints: [{ url: `${origin}/api/security/csp-report` }],
      }),
    );
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
