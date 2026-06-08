// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors.js';
import { loggerMiddleware } from './middleware/logger.js';
import { securityHeadersMiddleware } from './middleware/security-headers.js';
import { cspReportRoute } from './routes/csp-report.js';
import { healthRoute } from './routes/health.js';

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', loggerMiddleware());
  app.use('*', securityHeadersMiddleware());
  app.use('*', corsMiddleware());

  app.route('/health', healthRoute);
  app.route('/api/security/csp-report', cspReportRoute);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
