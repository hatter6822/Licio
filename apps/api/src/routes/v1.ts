// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Versioned BFF contract surface (SPEC §23.2) the PWA's Hono RPC client types
// against (WS-C.3.1). Routes are defined with method chaining so the exported
// type captures every path, method, input, and response — a client/server
// contract mismatch becomes a `tsc` build failure.
//
// Ownership: push (WS-C.2.4a), notification preferences (WS-C.2.4c), attention
// ingestion (WS-C.4.4), telemetry/RUM ingest (WS-C observability), feature flags
// (WS-C.1.3c), and settings sync are implemented here. The read-model data
// endpoints (feed, story, thread, room, signal-ledger) are typed CONTRACTS whose
// production data layer is owned by later workstreams (WS-G/H/J); until then they
// serve a deterministic in-memory demo dataset (see `lib/demo-data.ts`) so the PWA
// has stable, structurally honest content to render — clearly fixture data, never
// a fabricated production source of truth.
import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  type AttentionIngestAck,
  attentionAggregateBatchSchema,
  attentionIngestAckSchema,
  authStatusResponseSchema,
  branchContentSchema,
  branchIdSchema,
  contributionSchema,
  createContributionRequestSchema,
  createReportRequestSchema,
  DEFAULT_USER_SETTINGS,
  FAIL_CLOSED_FLAGS,
  type FeedResponse,
  feedQuerySchema,
  feedResponseSchema,
  notificationPreferencesSchema,
  okAckSchema,
  pushRegisterRequestSchema,
  type RoomListResponse,
  roomDetailSchema,
  roomListResponseSchema,
  type SignalLedgerResponse,
  signalLedgerResponseSchema,
  storyDetailSchema,
  type TelemetryIngestAck,
  telemetryBatchSchema,
  telemetryIngestAckSchema,
  threadDetailSchema,
  userSettingsSchema,
  uuidSchema,
  vapidPublicKeyResponseSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import {
  DEMO_FEED,
  DEMO_LEDGER,
  DEMO_ROOMS,
  demoBranch,
  demoRoom,
  demoStory,
  demoThread,
} from '../lib/demo-data.js';
import {
  getPreferences,
  getVapidConfig,
  registerSubscription,
  removeSubscription,
  setPreferences,
} from '../lib/push-service.js';
import { rateLimit } from '../lib/rate-limit.js';

/** Read the session id from the `__Host-session` cookie (or undefined). */
function sessionIdOf(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  return cookieHeader.match(/(?:^|;\s*)__Host-session=([^;]+)/)?.[1];
}

/** A stable per-request key for in-memory user state (session or anonymous). */
function stateKey(cookieHeader: string | undefined): string {
  return sessionIdOf(cookieHeader) ?? 'anonymous';
}

// In-memory settings store (BFF contract; durable store is a later concern).
const settingsBySession = new Map<string, z.infer<typeof userSettingsSchema>>();

const notFound = { error: { code: 'not_found', message: 'Resource not found' } } as const;

/**
 * Build the v1 router. Every route is chained so `typeof createV1Routes()` is the
 * precise contract the RPC client consumes.
 */
export function createV1Routes() {
  return (
    new Hono<AppEnv>()
      // --- Read models (in-memory demo fixture; durable data owned by WS-G/H/J) ---
      // Responses are re-validated against the shared schema before they leave the
      // BFF (the stated boundary guarantee, WS-C.1.2) — so fixture drift fails loudly
      // here, not silently at the client.
      .get('/feed', zValidator('query', feedQuerySchema), (c) => {
        const response: FeedResponse = { items: DEMO_FEED, nextCursor: null };
        return c.json(feedResponseSchema.parse(response));
      })
      .get('/stories/:storyId', zValidator('param', z.object({ storyId: uuidSchema })), (c) => {
        const story = demoStory(c.req.valid('param').storyId);
        return story ? c.json(storyDetailSchema.parse(story)) : c.json(notFound, 404);
      })
      .get('/threads/:threadId', zValidator('param', z.object({ threadId: uuidSchema })), (c) => {
        const thread = demoThread(c.req.valid('param').threadId);
        return thread ? c.json(threadDetailSchema.parse(thread)) : c.json(notFound, 404);
      })
      .get(
        '/threads/:threadId/branches/:branch',
        zValidator('param', z.object({ threadId: uuidSchema, branch: branchIdSchema })),
        (c) => {
          const { threadId, branch } = c.req.valid('param');
          return c.json(branchContentSchema.parse(demoBranch(threadId, branch)));
        },
      )
      .get('/rooms', zValidator('query', z.object({ cursor: z.string().optional() })), (c) => {
        const response: RoomListResponse = { items: DEMO_ROOMS, nextCursor: null };
        return c.json(roomListResponseSchema.parse(response));
      })
      .get('/rooms/:roomId', zValidator('param', z.object({ roomId: uuidSchema })), (c) => {
        const room = demoRoom(c.req.valid('param').roomId);
        return room ? c.json(roomDetailSchema.parse(room)) : c.json(notFound, 404);
      })
      .get('/signal-ledger', (c) => {
        const response: SignalLedgerResponse = { items: DEMO_LEDGER, nextCursor: null };
        return c.json(signalLedgerResponseSchema.parse(response));
      })

      // --- Auth status (session validation wired by WS-D) -------------------
      .get('/auth/status', (c) => {
        // No session-validation backend yet ⇒ unauthenticated. WS-D fills this in.
        const response = authStatusResponseSchema.parse({ authenticated: false });
        return c.json(response);
      })

      // --- Settings sync (SPEC §23.2 /feed/preferences) ---------------------
      .get('/settings', (c) => {
        const key = stateKey(c.req.header('cookie'));
        return c.json(settingsBySession.get(key) ?? DEFAULT_USER_SETTINGS);
      })
      .patch('/settings', zValidator('json', userSettingsSchema.partial()), (c) => {
        const key = stateKey(c.req.header('cookie'));
        const current = settingsBySession.get(key) ?? DEFAULT_USER_SETTINGS;
        const merged = userSettingsSchema.parse({ ...current, ...c.req.valid('json') });
        settingsBySession.set(key, merged);
        return c.json(merged);
      })

      // --- Feature flags (WS-C.1.3c, fail-closed) ---------------------------
      .get('/feature-flags', (c) => {
        // Production default is fail-closed; per-region enablement is wired by
        // WS-D/compliance. Crypto/governance never default on (SPEC §0.5).
        return c.json(FAIL_CLOSED_FLAGS);
      })

      // --- Contributions + reports (queued offline, WS-C.2.3) ---------------
      .post('/contributions', zValidator('json', createContributionRequestSchema), (c) => {
        const request = c.req.valid('json');
        const created = contributionSchema.parse({
          contribution_id: randomUUID(),
          thread_id: request.thread_id,
          type: request.type,
          body: request.body,
          moderation_state: 'pending',
          created_at: new Date().toISOString(),
          local_draft_id: request.local_draft_id,
        });
        return c.json(created, 201);
      })
      .post('/reports', zValidator('json', createReportRequestSchema), (c) => {
        const request = c.req.valid('json');
        return c.json(
          { status: 'received' as const, local_operation_id: request.local_operation_id },
          202,
        );
      })

      // --- Attention ingestion (WS-C.4.4 → attention.aggregate) -------------
      .post('/attention/aggregates', zValidator('json', attentionAggregateBatchSchema), (c) => {
        const { aggregates } = c.req.valid('json');
        // Server treats client aggregates as HINTS, never ground truth (§6.11);
        // here we validate and acknowledge the count for the event pipeline (WS-E).
        const ack: AttentionIngestAck = attentionIngestAckSchema.parse({
          accepted: aggregates.length,
        });
        return c.json(ack);
      })

      // --- Telemetry / RUM ingest (WS-C observability; CSRF-exempt beacon) ---
      // CSRF-exempt + unauthenticated (sendBeacon), so it carries its own DoS
      // bounds like the CSP-report endpoint: a per-IP rate limit and a small body
      // cap, in addition to the ≤100-event schema bound.
      .post(
        '/telemetry',
        rateLimit({ limit: 120, windowMs: 60_000 }),
        bodyLimit({
          maxSize: 64 * 1024,
          onError: (c) => c.json({ error: 'Payload too large' }, 413),
        }),
        zValidator('json', telemetryBatchSchema),
        (c) => {
          const { events } = c.req.valid('json');
          // Privacy-safe by schema (no URLs/PII, ≤100 events). The analytics
          // pipeline (WS-P) consumes these; here we validate and ack the count.
          const ack: TelemetryIngestAck = telemetryIngestAckSchema.parse({
            accepted: events.length,
          });
          return c.json(ack, { status: 202 });
        },
      )

      // --- Push (WS-C.2.4a) -------------------------------------------------
      .get('/push/vapid-public-key', (c) => {
        const config = getVapidConfig();
        if (!config) {
          return c.json(
            { error: { code: 'push_unconfigured', message: 'Push is not configured' } },
            503,
          );
        }
        return c.json(vapidPublicKeyResponseSchema.parse({ publicKey: config.publicKey }));
      })
      .post('/push/subscriptions', zValidator('json', pushRegisterRequestSchema), (c) => {
        const { subscription } = c.req.valid('json');
        registerSubscription(subscription, stateKey(c.req.header('cookie')));
        return c.json(okAckSchema.parse({ ok: true }), 201);
      })
      .delete(
        '/push/subscriptions',
        zValidator('json', z.object({ endpoint: z.string().url() })),
        (c) => {
          // Scoped to the requesting session — a session cannot unsubscribe
          // another user's endpoint (authorization, not just existence).
          removeSubscription(c.req.valid('json').endpoint, stateKey(c.req.header('cookie')));
          return c.json(okAckSchema.parse({ ok: true }));
        },
      )

      // --- Notification preferences (WS-C.2.4c) -----------------------------
      .get('/notifications/preferences', (c) =>
        c.json(getPreferences(stateKey(c.req.header('cookie')))),
      )
      .patch(
        '/notifications/preferences',
        zValidator('json', notificationPreferencesSchema.partial()),
        (c) => {
          const key = stateKey(c.req.header('cookie'));
          const merged = notificationPreferencesSchema.parse({
            ...getPreferences(key),
            ...c.req.valid('json'),
          });
          setPreferences(key, merged);
          return c.json(merged);
        },
      )
  );
}

export type V1Routes = ReturnType<typeof createV1Routes>;

/** Test helper: clear in-memory settings between cases. */
export function resetSettingsState(): void {
  settingsBySession.clear();
}
