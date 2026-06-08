// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { createLogger } from '../lib/logger.js';

const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

export function loggerMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId' as never, requestId);

    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    logger.info({
      requestId,
      method,
      path,
      status,
      duration,
    });

    c.res.headers.set('X-Request-ID', requestId);
  };
}
