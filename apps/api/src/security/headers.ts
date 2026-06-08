import type { Context, MiddlewareHandler } from 'hono';

export const contentSecurityPolicy = [
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
  "require-trusted-types-for 'script'",
  'trusted-types default dompurify',
  'report-to csp-endpoint',
].join('; ');

export const permissionsPolicy = [
  'accelerometer=()',
  'ambient-light-sensor=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=(self)',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'usb=()',
].join(', ');

export function applySecurityHeaders(context: Context): void {
  context.header('Content-Security-Policy', contentSecurityPolicy);
  context.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  context.header('Cross-Origin-Opener-Policy', 'same-origin');
  context.header('Cross-Origin-Resource-Policy', 'same-origin');
  context.header('Permissions-Policy', permissionsPolicy);
  context.header(
    'Report-To',
    JSON.stringify({
      group: 'csp-endpoint',
      max_age: 10_886_400,
      endpoints: [{ url: '/api/csp-report' }],
    }),
  );
}

export function securityHeaders(): MiddlewareHandler {
  return async (context, next) => {
    applySecurityHeaders(context);
    await next();
  };
}
