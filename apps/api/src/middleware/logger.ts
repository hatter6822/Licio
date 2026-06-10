// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Request logging, minimized (SPEC §19.1): no IP, no location, and no full
// user-agent string (a fingerprinting vector) — only the coarse OS/browser
// device profile the identity layer also uses.
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { deviceProfile } from '../identity/security-alerts.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loggerMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const clientId = c.req.header('x-request-id');
    const requestId = clientId && UUID_RE.test(clientId) ? clientId : randomUUID();
    c.set('requestId' as never, requestId);

    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    const device = deviceProfile(c.req.header('user-agent') ?? '');
    const contentLength = c.req.header('content-length');

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    logger.info({
      requestId,
      method,
      path,
      status,
      duration,
      device,
      contentLength: contentLength ? Number.parseInt(contentLength, 10) : undefined,
    });

    c.res.headers.set('X-Request-ID', requestId);
  };
}
