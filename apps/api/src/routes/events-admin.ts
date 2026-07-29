// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Steward-gated event-pipeline operations (the WS-E operational surface):
//
//   POST /v1/events/admin/safety-state          — clear/remove an item
//     (WS-E.2.3e: the moderation-resolution path; until the WS-J case
//     lifecycle lands, stewards resolve directly here)
//   PUT  /v1/events/admin/pwatt-config          — VALIDATED runtime-config
//     writes (WS-E.2.3a-d: invalid values are rejected at configuration time,
//     never silently absorbed; every change is audit-logged with the actor)
//   GET  /v1/events/admin/dead-letters          — DLQ visibility
//   POST /v1/events/admin/dead-letters/redrive  — retry poisoned events after
//     their cause is fixed (WS-E.1.5 operational complement)
//
// All routes require an authenticated steward with per-session MFA
// (requireSteward, WS-D.1.5b) — the same bar as every other steward action.

import { Hono } from 'hono';
import { z } from 'zod';
import { recoverEventPipeline, redriveDeadLetters } from '../events/recovery.js';
import { type EventPipelineServices, getEventPipelineServices } from '../events/services.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { zValidator } from '../lib/validate.js';
import { type AuthEnv, authMiddleware, getAuth, requireSteward } from '../middleware/auth.js';
import { PWATT_CONFIG_KEYS, validatePwattConfigValue } from '../pwatt/config.js';
import { resolveItemSafetyState } from '../pwatt/scoring.js';

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

const safetyStateBodySchema = z
  .object({
    item_id: z.string().uuid(),
    action: z.enum(['clear', 'remove']),
  })
  .strict();

const configBodySchema = z
  .object({
    key: z.enum(PWATT_CONFIG_KEYS),
    value: z.record(z.string(), z.unknown()),
  })
  .strict();

const redriveBodySchema = z.object({ consumer_name: z.string().min(1).max(128) }).strict();

export function createEventsAdminRoutes(
  resolveIdentity: () => IdentityServices = getIdentityServices,
  resolveEvents: () => EventPipelineServices = getEventPipelineServices,
) {
  return new Hono<AuthEnv>()
    .post(
      '/safety-state',
      authMiddleware(resolveIdentity),
      requireSteward(),
      zValidator('json', safetyStateBodySchema),
      async (c) => {
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const { item_id: itemId, action } = c.req.valid('json');
        const result = await resolveItemSafetyState(
          resolveEvents(),
          resolveIdentity(),
          itemId,
          action,
          `steward:${auth.userId}`,
        );
        if (!result.ok) {
          return c.json(deny('illegal_transition', result.reason ?? 'illegal transition'), 409);
        }
        return c.json({ item_id: itemId, action, ok: true });
      },
    )
    .put(
      '/pwatt-config',
      authMiddleware(resolveIdentity),
      requireSteward(),
      zValidator('json', configBodySchema),
      async (c) => {
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const { key, value } = c.req.valid('json');
        // Config-time rejection (WS-E.2.3c): an invalid value never lands.
        const problem = validatePwattConfigValue(key, value as Record<string, unknown>);
        if (problem !== null) {
          return c.json(deny('invalid_config', problem), 422);
        }
        const events = resolveEvents();
        await events.configStore.set(key, value as Record<string, unknown>);
        // Who changed which knob, for the transparency record (WS-E.2.3c
        // "profile changes are logged for audit") — values live in the store.
        await resolveIdentity().audit.append({
          actorUserId: auth.userId,
          eventType: 'pwatt_config_change',
          context: { setting: key },
        });
        events.log('pwatt.config.changed', { key });
        return c.json({ key, ok: true });
      },
    )
    .get(
      '/dead-letters',
      authMiddleware(resolveIdentity),
      requireSteward(),
      zValidator('query', z.object({ consumer_name: z.string().min(1).max(128).optional() })),
      async (c) => {
        const { consumer_name: consumerName } = c.req.valid('query');
        const letters = await resolveEvents().deadLetters.list(consumerName);
        return c.json({ items: letters });
      },
    )
    .post(
      '/dead-letters/redrive',
      authMiddleware(resolveIdentity),
      requireSteward(),
      zValidator('json', redriveBodySchema),
      async (c) => {
        const { consumer_name: consumerName } = c.req.valid('json');
        const report = await redriveDeadLetters(resolveEvents(), consumerName);
        return c.json(report);
      },
    )
    .post('/recover', authMiddleware(resolveIdentity), requireSteward(), async (c) => {
      // Manual recovery trigger (normally automatic at boot): replay durable
      // consumers from checkpoints + rebuild the real-time windows.
      const report = await recoverEventPipeline(resolveEvents());
      return c.json(report);
    });
}

export type EventsAdminRoutes = ReturnType<typeof createEventsAdminRoutes>;
