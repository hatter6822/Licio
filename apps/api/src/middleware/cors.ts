// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MiddlewareHandler } from 'hono';

export function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();

  const corsOrigin = process.env['CORS_ORIGIN'];
  if (corsOrigin) {
    // Normalize to a bare ORIGIN (scheme://host[:port]) so a configured value
    // with a trailing slash or path still matches the browser's `Origin` header
    // (which never carries a path) — otherwise every cross-origin mutation is
    // silently blocked. Falls back to the trimmed raw value if it is not a valid
    // absolute URL.
    try {
      origins.add(new URL(corsOrigin).origin);
    } catch {
      origins.add(corsOrigin.trim());
    }
  }

  if (process.env['NODE_ENV'] === 'development') {
    origins.add('http://localhost:5173');
  }

  return origins;
}

export function corsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const allowedOrigins = getAllowedOrigins();
    const origin = c.req.header('origin');

    if (origin && allowedOrigins.has(origin)) {
      c.res.headers.set('Access-Control-Allow-Origin', origin);
      c.res.headers.set('Access-Control-Allow-Credentials', 'true');
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      c.res.headers.set(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Request-ID, X-CSRF-Token',
      );
      c.res.headers.set('Access-Control-Expose-Headers', 'X-Request-ID');
      c.res.headers.set('Access-Control-Max-Age', '86400');
    }

    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: c.res.headers });
    }

    await next();
  };
}
