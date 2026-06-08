// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';

export const healthRoute = new Hono();

healthRoute.get('/', (c) => {
  return c.json({
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
  });
});
