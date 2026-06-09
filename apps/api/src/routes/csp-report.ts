// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../lib/logger.js';

const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ENTRIES = 10_000;
const MAX_BODY_SIZE = 10_240;

function evictExpiredEntries(): void {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
}

setInterval(evictExpiredEntries, RATE_WINDOW_MS).unref();

const cspReportSchema = z.object({
  'csp-report': z
    .object({
      'document-uri': z.string().optional(),
      'violated-directive': z.string().optional(),
      'blocked-uri': z.string().optional(),
      'original-policy': z.string().optional(),
      'source-file': z.string().optional(),
      'line-number': z.number().optional(),
      'column-number': z.number().optional(),
    })
    .optional(),
});

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
    if (rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
      evictExpiredEntries();
    }
    if (rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
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

  const parsed = cspReportSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid report format' }, 400);
  }

  logger.info({
    auditAction: 'csp_violation',
    report: parsed.data['csp-report'],
  });

  return c.json({ received: true });
});
