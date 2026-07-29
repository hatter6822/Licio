// SPDX-License-Identifier: AGPL-3.0-or-later
//
// POST /v1/events/attention (WS-E.1.3a-e, SPEC §21.3/§23.2/§25.5). The
// canonical attention-ingestion endpoint: one event per request, either
// `attention.aggregate` or `source.opened.aggregate` (a discriminated
// variant on the same route, WS-E.1.3e — identical guards for both).
//
// Guard chain: session auth (401) → per-user sliding-window rate limit with
// fail-closed fallback (429 + Retry-After) → schema validation (400) →
// ownership (403) → timestamp window (400) → replay nonce (409) → server-side
// privacy enforcement (204 silent discard) → durable store + publish (202 +
// receipt). Logs and metrics carry event ids and the user id only — never an
// attention value.

import {
  attentionAggregateEventSchema,
  contentSavedAggregateEventSchema,
  sourceOpenedAggregateEventSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { ingestAttentionEvents, ONLINE_ACCEPTANCE } from '../events/ingest.js';
import { type EventPipelineServices, getEventPipelineServices } from '../events/services.js';
import { accountRef } from '../identity/crypto.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { zValidator } from '../lib/validate.js';
import { type AuthEnv, authMiddleware, getAuth } from '../middleware/auth.js';
import { createEventsAdminRoutes } from './events-admin.js';

const attentionIngestBodySchema = z.discriminatedUnion('event_type', [
  attentionAggregateEventSchema,
  sourceOpenedAggregateEventSchema,
  contentSavedAggregateEventSchema,
]);

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

export function createEventsRoutes(
  resolveIdentity: () => IdentityServices = getIdentityServices,
  resolveEvents: () => EventPipelineServices = getEventPipelineServices,
) {
  return new Hono<AuthEnv>()
    .route('/admin', createEventsAdminRoutes(resolveIdentity, resolveEvents))
    .post(
      '/attention',
      authMiddleware(resolveIdentity),
      // Per-user sliding-window rate limit (WS-E.1.3c): keyed by a
      // NON-REVERSIBLE account ref — never the user id, never any address.
      // Runs BEFORE body validation so malformed requests consume the same
      // budget as valid ones — the JSON/schema path cannot be hammered for
      // free (the documented guard chain: auth → rate limit → schema).
      async (c, next) => {
        const events = resolveEvents();
        const identity = resolveIdentity();
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const decision = await events.ingestLimiter.hit(
          accountRef(identity.config.masterSecret, auth.userId),
          events.now(),
        );
        if (!decision.allowed) {
          events.metrics.increment('events_attention_rejected_rate_limited', 1);
          c.header('Retry-After', String(decision.retryAfterSec));
          return c.json(deny('rate_limited', 'Too many attention events'), 429);
        }
        await next();
      },
      zValidator('json', attentionIngestBodySchema),
      async (c) => {
        const startedAt = Date.now();
        const events = resolveEvents();
        const identity = resolveIdentity();
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);

        const event = c.req.valid('json');
        const result = await ingestAttentionEvents(
          events,
          identity,
          auth.userId,
          [event],
          ONLINE_ACCEPTANCE,
        );
        events.metrics.observeLatencyMs(Date.now() - startedAt);

        switch (result.outcomes[0]) {
          case 'accepted':
            return c.json({ receipt_id: event.event_id, status: 'accepted' as const }, 202);
          case 'discarded_privacy':
            // Server-side privacy enforcement (WS-E.1.3d): silently discarded.
            return c.body(null, 204);
          case 'replay':
            return c.json(deny('replay', 'Event nonce was already used'), 409);
          case 'stale_timestamp':
            return c.json(
              deny('stale_timestamp', 'Event timestamp is outside the acceptance window'),
              400,
            );
          case 'future_timestamp':
            return c.json(deny('future_timestamp', 'Event timestamp is in the future'), 400);
          case 'ownership_mismatch':
            return c.json(deny('forbidden', 'Event user does not match the session'), 403);
          default:
            return c.json(deny('internal', 'Ingestion produced no outcome'), 500);
        }
      },
    );
}

export type EventsRoutes = ReturnType<typeof createEventsRoutes>;
