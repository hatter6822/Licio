import { randomBytes } from 'node:crypto';
import type { ServerEnv } from '@licio/shared/env/server';
import { createLogger } from '@licio/shared/logging';
import { Hono } from 'hono';
import { z } from 'zod';
import { exactCors } from './middleware/cors.js';
import {
  type CsrfStore,
  csrfProtection,
  csrfTokenTtlSeconds,
  MemoryCsrfStore,
} from './middleware/csrf.js';
import { securityHeaders } from './security/headers.js';
import { clientIp, InMemoryRateLimiter } from './security/rate-limit.js';

const cspReportRateLimiter = new InMemoryRateLimiter(30, 60_000);
const maxCspReportBytes = 16 * 1024;

const cspReportSchema = z.object({
  'csp-report': z
    .object({
      'document-uri': z.string().url().max(2_048).optional(),
      'violated-directive': z.string().max(256).optional(),
      'blocked-uri': z.string().max(2_048).optional(),
    })
    .strict()
    .optional(),
});

function contentLengthExceedsLimit(value: string | undefined, maxBytes: number): boolean {
  if (value === undefined) {
    return false;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > maxBytes;
}

export interface AppOptions {
  env: ServerEnv;
  csrfStore?: CsrfStore;
}

export function createApiApp({ env, csrfStore = new MemoryCsrfStore() }: AppOptions) {
  const app = new Hono();
  const logger = createLogger(env.LOG_LEVEL);

  app.use('*', securityHeaders());
  app.use('*', exactCors([env.CORS_ORIGIN]));
  app.use('*', csrfProtection(csrfStore));

  app.get('/health', (context) =>
    context.json({ status: 'ok', service: 'licio-api', environment: env.NODE_ENV }),
  );

  app.get('/api/csrf-token', async (context) => {
    const sessionId = randomBytes(32).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    await csrfStore.set(sessionId, token, csrfTokenTtlSeconds);
    context.header(
      'Set-Cookie',
      `__Host-licio-session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`,
    );
    return context.json({ csrfToken: token });
  });

  app.post('/api/csp-report', async (context) => {
    if (!cspReportRateLimiter.allow(clientIp(context))) {
      return context.json({ error: 'Too many CSP reports.' }, 429);
    }
    if (contentLengthExceedsLimit(context.req.header('Content-Length'), maxCspReportBytes)) {
      return context.json({ error: 'CSP report is too large.' }, 413);
    }

    const rawBody = await context.req.text();
    if (Buffer.byteLength(rawBody, 'utf8') > maxCspReportBytes) {
      return context.json({ error: 'CSP report is too large.' }, 413);
    }
    let body: unknown;
    try {
      body = rawBody === '' ? {} : JSON.parse(rawBody);
    } catch {
      return context.json({ error: 'Invalid CSP report.' }, 400);
    }
    const parsed = cspReportSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({ error: 'Invalid CSP report.' }, 400);
    }
    logger.warn({ cspReport: parsed.data }, 'CSP violation report received');
    return context.body(null, 204);
  });

  app.post('/api/echo', async (context) => {
    const body = await context.req.json().catch(() => ({}));
    return context.json({ ok: true, body });
  });

  return app;
}
