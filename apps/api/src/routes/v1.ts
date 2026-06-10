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
import { classifyAccusationV0 } from '@licio/invariants';
import {
  type AttentionIngestAck,
  attentionAggregateBatchSchema,
  attentionIngestAckSchema,
  branchContentSchema,
  branchIdSchema,
  contributionCreatedEventSchema,
  contributionSchema,
  createContributionRequestSchema,
  createReportRequestSchema,
  DEFAULT_USER_SETTINGS,
  type EventContributionType,
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
  type SignalLedgerEntry,
  type SignalLedgerResponse,
  signalLedgerResponseSchema,
  storyDetailSchema,
  type TelemetryIngestAck,
  TOPIC_REGISTRY,
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
import {
  aggregateBelongsToSession,
  aggregateToCanonicalEvent,
  ingestAttentionEvents,
  OFFLINE_SYNC_ACCEPTANCE,
} from '../events/ingest.js';
import { getEventPipelineServices } from '../events/services.js';
import type { SignalLedgerRecord } from '../events/stores.js';
import { accountRef } from '../identity/crypto.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { readSessionToken, validateSession } from '../identity/sessions.js';
import {
  DEMO_FEED,
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
import { type AuthEnv, authMiddleware, getAuth } from '../middleware/auth.js';
import { createAuthRoutes } from './auth.js';
import { createEventsRoutes } from './events.js';
import { createPrivacyRoutes } from './privacy.js';

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

/** Client composer mode → event-pipeline contribution taxonomy (WS-E.1.1c). */
const COMPOSER_TO_EVENT_TYPE: Readonly<Record<string, EventContributionType>> = {
  ask: 'question',
  evidence: 'evidence',
  correction: 'correction',
  synthesis: 'synthesis',
  counterexample: 'counterexample',
  experience: 'experience',
  explain: 'explanation',
  flag: 'flag',
};

/**
 * Soft session read: the user id when a valid session cookie is present, else
 * null — never a 401 (used by routes whose contract is unauthenticated but
 * which emit owned events only for signed-in users).
 */
async function readSessionUserId(
  cookieHeader: string | undefined,
  identity: IdentityServices,
): Promise<string | null> {
  const token = readSessionToken(cookieHeader);
  if (!token) return null;
  try {
    const validated = await validateSession(identity.sessions, token);
    return validated?.record.user_id ?? null;
  } catch {
    return null;
  }
}

/** Scoring annotation → the §5.3 anti-signal name shown in the ledger. */
const ANNOTATION_TO_LEDGER_ANTI_SIGNAL: Readonly<
  Record<string, NonNullable<SignalLedgerEntry['anti_signals']>[number]>
> = {
  source_free_accusation_downweight: 'source_free_accusation',
  rapid_repetition_dampened: 'rapid_repetition',
  coordinated_burst_placeholder_dampening: 'coordinated_burst',
  harassment_cascade_review: 'harassment_cascade',
};

/** Map a stored Signal Ledger row to the wire entry (validated on egress). */
function toLedgerEntry(row: SignalLedgerRecord): SignalLedgerEntry {
  const signals = row.signals as {
    active_dwell_bucket?: string;
    source_opened?: boolean;
    context_opened?: boolean;
    branch_depth_bucket?: string;
    return_visit_count_bucket?: string;
    cap_reached?: boolean;
  };
  const antiSignals = [
    ...new Set(
      row.antiSignals
        .map((annotation) => ANNOTATION_TO_LEDGER_ANTI_SIGNAL[annotation])
        .filter((mapped): mapped is NonNullable<typeof mapped> => mapped !== undefined),
    ),
  ];
  return {
    item_id: row.itemId,
    story_title: row.storyTitle,
    recorded_at: row.recordedAt,
    active_dwell_bucket: (signals.active_dwell_bucket ??
      'none') as SignalLedgerEntry['active_dwell_bucket'],
    source_opened: signals.source_opened ?? false,
    context_opened: signals.context_opened ?? false,
    branch_depth_bucket: (signals.branch_depth_bucket ??
      'none') as SignalLedgerEntry['branch_depth_bucket'],
    return_visit_count_bucket: (signals.return_visit_count_bucket ??
      'none') as SignalLedgerEntry['return_visit_count_bucket'],
    cap_reached: signals.cap_reached ?? false,
    anti_signals: antiSignals,
    pwatt_v0_score: row.pwattScore,
    summary: row.summary,
  };
}

/**
 * Build the v1 router. Every route is chained so `typeof createV1Routes()` is the
 * precise contract the RPC client consumes. The env is AuthEnv (a superset of
 * AppEnv) so per-route auth middleware can attach the session context.
 */
export function createV1Routes() {
  return (
    new Hono<AuthEnv>()
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
      // Owner-only (WS-E.2.1d): the ledger returns ONLY the authenticated
      // user's entries — there is no path to another user's ledger (the
      // endpoint takes no user parameter), and it is excluded from public
      // APIs and search surfaces by construction.
      .get(
        '/signal-ledger',
        authMiddleware(),
        zValidator('query', z.object({ cursor: z.string().min(1).max(512).optional() })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(notFound, 404);
          const events = getEventPipelineServices();
          const { cursor } = c.req.valid('query');
          const page = await events.ledgerStore.listForUser(auth.userId, 50, cursor);
          const response: SignalLedgerResponse = {
            items: page.entries.map(toLedgerEntry),
            nextCursor: page.nextCursor,
          };
          return c.json(signalLedgerResponseSchema.parse(response));
        },
      )

      // --- Identity & privacy (WS-D) ----------------------------------------
      .route('/auth', createAuthRoutes())
      .route('/privacy', createPrivacyRoutes())

      // --- Event pipeline (WS-E) --------------------------------------------
      .route('/events', createEventsRoutes())

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
      .post('/contributions', zValidator('json', createContributionRequestSchema), async (c) => {
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
        // WS-E.1.1c: emit `contribution.created` into the event pipeline for
        // signed-in users (participation scoring input). The event carries NO
        // body text — only the type, citation flag, and the conservative v0
        // accusation classification (WS-E.2.2b) computed here, where the body
        // is available, then discarded.
        const identity = getIdentityServices();
        const userId = await readSessionUserId(c.req.header('cookie'), identity);
        if (userId) {
          const events = getEventPipelineServices();
          const event = contributionCreatedEventSchema.parse({
            event_id: randomUUID(),
            event_type: 'contribution.created',
            timestamp: created.created_at,
            schema_version: '1',
            contribution_id: created.contribution_id,
            thread_id: request.thread_id,
            user_id: userId,
            contribution_type: COMPOSER_TO_EVENT_TYPE[request.type] ?? 'low_info_reply',
            target_claim_id: request.target_claim_id ?? null,
            parent_contribution_id: request.parent_id ?? null,
            has_citation: request.citations.length > 0,
            accusation_flag: classifyAccusationV0(request.body),
            privacy_classification: 'public',
            retention_tier: 'public_contribution',
          });
          const registryEntry = TOPIC_REGISTRY['contribution.created'];
          await events.eventStore.insertMany([
            {
              eventId: event.event_id,
              eventType: event.event_type,
              topic: event.event_type,
              timestamp: event.timestamp,
              privacyClassification: registryEntry.privacy_classification,
              retentionTier: registryEntry.retention_tier,
              payload: event as unknown as Record<string, unknown>,
              ownerUserId: userId,
              purgeAfter: null,
            },
          ]);
          await events.router.publish(event);
        }
        return c.json(created, 201);
      })
      .post('/reports', zValidator('json', createReportRequestSchema), (c) => {
        const request = c.req.valid('json');
        return c.json(
          { status: 'received' as const, local_operation_id: request.local_operation_id },
          202,
        );
      })

      // --- Attention ingestion (WS-C.4.4 → attention.aggregate, WS-E.1.3) ---
      // The WS-C client batch wire. Each §22.1 aggregate is converted into a
      // canonical single-item `attention.aggregate` event and flows through
      // the SAME hardened pipeline as POST /v1/events/attention (WS-E.1.3e:
      // identical auth, ownership, replay, rate-limit, and privacy guards) —
      // with the OFFLINE acceptance window, because the durable pending queue
      // replays batches when connectivity returns (§6.9). Replay safety never
      // depends on the window: every aggregate_id is a single-use nonce AND
      // the event store's id-uniqueness rejects re-ingestion forever, so a
      // replayed batch acks `accepted: 0` (idempotent retry semantics for the
      // sync queue) instead of double-counting.
      .post(
        '/attention/aggregates',
        authMiddleware(),
        zValidator('json', attentionAggregateBatchSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(notFound, 404);
          const events = getEventPipelineServices();
          const identity = getIdentityServices();
          const { aggregates } = c.req.valid('json');
          // Ownership (WS-E.1.3a): every aggregate must belong to the session
          // user; a batch attributing attention to anyone else is rejected.
          if (!aggregates.every((a) => aggregateBelongsToSession(a, auth.userId))) {
            return c.json(
              { error: { code: 'forbidden', message: 'Aggregate owner does not match session' } },
              403,
            );
          }
          // Per-user sliding-window rate limit (one request = one hit).
          const decision = await events.ingestLimiter.hit(
            accountRef(identity.config.masterSecret, auth.userId),
            events.now(),
          );
          if (!decision.allowed) {
            c.header('Retry-After', String(decision.retryAfterSec));
            return c.json(
              { error: { code: 'rate_limited', message: 'Too many attention uploads' } },
              429,
            );
          }
          const result = await ingestAttentionEvents(
            events,
            identity,
            auth.userId,
            aggregates.map((aggregate) => aggregateToCanonicalEvent(aggregate, auth.userId)),
            OFFLINE_SYNC_ACCEPTANCE,
          );
          // Hints, never ground truth (§25.5): the ack reports how many were
          // actually accepted after every guard.
          const ack: AttentionIngestAck = attentionIngestAckSchema.parse({
            accepted: result.accepted,
          });
          return c.json(ack, 202);
        },
      )

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
