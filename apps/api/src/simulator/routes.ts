// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DEV-ONLY HTTP control surface for the traffic simulator. Mounted at
// /v1/dev/simulator by the development boot path ONLY (index.ts, behind
// NODE_ENV === 'development'), IN FRONT of the CSRF-protected production app —
// exactly like the E2E test-auth route. This surface is never part of the
// production app (apps/api/src/app.ts) and never part of the RPC AppType, so
// the wire contract the web client types against is untouched.
//
// SECURITY. These routes are sessionless (mounted ahead of the CSRF
// middleware), so a mutating request must carry the custom control header
// (SIMULATOR_CONTROL_HEADER). A custom header forces a CORS preflight that a
// same-origin dev page passes and a cross-origin/forged page fails — the CSRF
// defence for this dev-only surface. The Origin (when present) must also be in
// the dev allowlist. All mutating routes are rate-limited. Because the module
// is only imported by the development boot, none of this is reachable in
// production regardless.

import {
  SIMULATOR_CONTROL_HEADER,
  simulatorConfigureRequestSchema,
  simulatorStartRequestSchema,
  simulatorStatusSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { rateLimit } from '../lib/rate-limit.js';
import { getAllowedOrigins } from '../middleware/cors.js';
import type { DevTrafficSimulator } from './runtime.js';

/** Guard mutating requests: require the control header and, when an Origin is
 *  present, that it is allow-listed. Returns a 403 body or null when allowed. */
function controlGuard(
  header: string | undefined,
  origin: string | undefined,
): { code: string } | null {
  if (header !== '1' && header !== 'true') return { code: 'control_header_required' };
  if (origin !== undefined && !getAllowedOrigins().has(origin))
    return { code: 'origin_not_allowed' };
  return null;
}

export function createSimulatorRoutes(sim: DevTrafficSimulator) {
  const controlLimiter = rateLimit({ limit: 60, windowMs: 60_000 });
  return (
    new Hono()
      // Status is a read: no header, no rate limit — the panel polls it.
      .get('/status', (c) => c.json(simulatorStatusSchema.parse(sim.status())))
      .post('/start', controlLimiter, async (c) => {
        const denied = controlGuard(c.req.header(SIMULATOR_CONTROL_HEADER), c.req.header('origin'));
        if (denied !== null) return c.json({ ok: false, ...denied }, 403);
        const raw = await c.req.json().catch(() => ({}));
        const parsed = simulatorStartRequestSchema.safeParse(raw);
        if (!parsed.success) return c.json({ ok: false, code: 'invalid_request' }, 400);
        await sim.start(parsed.data);
        return c.json(simulatorStatusSchema.parse(sim.status()));
      })
      .post('/stop', controlLimiter, (c) => {
        const denied = controlGuard(c.req.header(SIMULATOR_CONTROL_HEADER), c.req.header('origin'));
        if (denied !== null) return c.json({ ok: false, ...denied }, 403);
        sim.stop();
        return c.json(simulatorStatusSchema.parse(sim.status()));
      })
      .post('/configure', controlLimiter, async (c) => {
        const denied = controlGuard(c.req.header(SIMULATOR_CONTROL_HEADER), c.req.header('origin'));
        if (denied !== null) return c.json({ ok: false, ...denied }, 403);
        const raw = await c.req.json().catch(() => ({}));
        const parsed = simulatorConfigureRequestSchema.safeParse(raw);
        if (!parsed.success) return c.json({ ok: false, code: 'invalid_request' }, 400);
        sim.configure(parsed.data);
        return c.json(simulatorStatusSchema.parse(sim.status()));
      })
  );
}

export type SimulatorRoutes = ReturnType<typeof createSimulatorRoutes>;
