// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import { createLcapRoutes } from './lcap/routes.js';
import { corsMiddleware } from './middleware/cors.js';
import { csrfMiddleware, csrfTokenRoute } from './middleware/csrf.js';
import { loggerMiddleware } from './middleware/logger.js';
import { securityHeadersMiddleware } from './middleware/security-headers.js';
import { cspReportRoute } from './routes/csp-report.js';
import { healthRoute } from './routes/health.js';
import { createPrivateRendezvousRoutes } from './routes/private-rendezvous.js';
import { createV1Routes } from './routes/v1.js';

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', loggerMiddleware());
  app.use('*', securityHeadersMiddleware());
  app.use('*', corsMiddleware());
  app.use('*', csrfMiddleware());

  // Chained so the exported type captures every route, method, and I/O shape —
  // this is the compile-time contract the Hono RPC client types against (WS-C.3.1).
  const routes = app
    .route('/health', healthRoute)
    .get('/api/csrf-token', csrfTokenRoute())
    .route('/api/security/csp-report', cspReportRoute)
    .route('/api/lcap/v2', createLcapRoutes())
    .route('/v1/private-rendezvous', createPrivateRendezvousRoutes())
    .route('/v1', createV1Routes());

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
