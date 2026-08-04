// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import { createLcapRoutes } from './lcap/routes.js';
import { corsMiddleware } from './middleware/cors.js';
import { csrfMiddleware, csrfTokenRoute } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { loggerMiddleware } from './middleware/logger.js';
import { securityHeadersMiddleware } from './middleware/security-headers.js';
import { cspReportRoute } from './routes/csp-report.js';
import { createReadyRoute, healthRoute, type ReadinessProbe } from './routes/health.js';
import { createPrivateRendezvousRoutes } from './routes/private-rendezvous.js';
import { createPrivateRoomsRoutes } from './routes/private-rooms.js';
import { createV1Routes } from './routes/v1.js';

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export interface CreateAppOptions {
  /** Dependency checks behind GET /health/ready (Postgres/Redis in production;
   *  empty — trivially ready — on the in-memory dev/test boot). */
  readonly readinessProbes?: readonly ReadinessProbe[];
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<AppEnv>();

  // Registered BEFORE the middleware so nothing an uncaught throw can reach
  // falls back to Hono's `console.error` + `text/plain` default.
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.use('*', loggerMiddleware());
  app.use('*', securityHeadersMiddleware());
  app.use('*', corsMiddleware());
  app.use('*', csrfMiddleware());

  // Chained so the exported type captures every route, method, and I/O shape —
  // this is the compile-time contract the Hono RPC client types against (WS-C.3.1).
  const routes = app
    .route('/health/ready', createReadyRoute(options.readinessProbes ?? []))
    .route('/health', healthRoute)
    .get('/api/csrf-token', csrfTokenRoute())
    .route('/api/security/csp-report', cspReportRoute)
    .route('/api/lcap/v2', createLcapRoutes())
    .route('/v1/private-rendezvous', createPrivateRendezvousRoutes())
    // Mounted BEFORE `/v1` so the directory-stub surface is not shadowed by the
    // catch-all v1 router (same reason the rendezvous mount precedes it).
    .route('/v1/private-rooms', createPrivateRoomsRoutes())
    .route('/v1', createV1Routes());

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
