// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { createLogger } from '../lib/logger.js';
import { rateLimit } from '../lib/rate-limit.js';

const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

const MAX_BODY_SIZE = 10_240;

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

// GLOBAL (identity-free) ingest budget — nothing about the requester is read
// or keyed on (SPEC §19.1); the edge owns connection-level flood fairness.
// The `bodyLimit` middleware caps the body DURING the stream read (mirroring
// the sibling /telemetry endpoint in v1.ts), so an unauthenticated caller can
// never force the whole body to buffer before the cap is applied. `maxSize` is
// measured in bytes over the raw stream; the `rawBody.length` check below is a
// harmless defense-in-depth JS-string-length backstop.
cspReportRoute.post(
  '/',
  rateLimit({ limit: 100, windowMs: 60_000 }),
  bodyLimit({
    maxSize: MAX_BODY_SIZE,
    onError: (c) => c.json({ error: 'Payload too large' }, 413),
  }),
  async (c) => {
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
  },
);
