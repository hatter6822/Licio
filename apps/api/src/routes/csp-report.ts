// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import { createLogger } from '../lib/logger.js';

const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_SIZE = 10_240;

interface CspReport {
  'csp-report'?: {
    'document-uri'?: string;
    'violated-directive'?: string;
    'blocked-uri'?: string;
    'original-policy'?: string;
    'source-file'?: string;
    'line-number'?: number;
    'column-number'?: number;
  };
}

export const cspReportRoute = new Hono();

cspReportRoute.post('/', async (c) => {
  const ip = c.req.header('x-forwarded-for') ?? 'unknown';
  const now = Date.now();

  const entry = rateLimitMap.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= RATE_LIMIT) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    entry.count++;
  } else {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
  }

  const contentType = c.req.header('content-type') ?? '';
  if (
    !contentType.includes('application/csp-report') &&
    !contentType.includes('application/reports+json')
  ) {
    return c.json({ error: 'Invalid content type' }, 415);
  }

  const rawBody = await c.req.text();
  if (rawBody.length > MAX_BODY_SIZE) {
    return c.json({ error: 'Payload too large' }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (typeof body !== 'object' || body === null) {
    return c.json({ error: 'Invalid report format' }, 400);
  }

  const report = body as CspReport;

  logger.info({
    auditAction: 'csp_violation',
    report: report['csp-report'],
  });

  return c.json({ received: true });
});
