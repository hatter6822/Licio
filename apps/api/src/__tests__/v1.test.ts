// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  attentionAggregateSchema,
  branchContentSchema,
  DEFAULT_USER_SETTINGS,
  feedResponseSchema,
  notificationPreferencesSchema,
  roomListResponseSchema,
  signalLedgerResponseSchema,
  storyDetailSchema,
  threadDetailSchema,
  userSettingsSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPushState } from '../lib/push-service.js';
import { createV1Routes, resetSettingsState } from '../routes/v1.js';
import { freshEventServices, legacyAggregate, seedUserWithSession } from './event-test-helpers.js';
import { freshForumServices, seedThread } from './forum-test-helpers.js';

// Mount the v1 router on a bare app: this unit-tests the contract handlers in
// isolation. CSRF/CORS/security middleware is exercised by their own suites.
function app() {
  return new Hono().route('/v1', createV1Routes());
}

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`http://local${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  resetPushState();
  resetSettingsState();
});

afterEach(() => {
  resetPushState();
  resetSettingsState();
});

describe('v1 read models', () => {
  it('returns a schema-valid feed page with demo items', async () => {
    const res = await app().request('/v1/feed');
    expect(res.status).toBe(200);
    const body = feedResponseSchema.parse(await res.json());
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('rejects a non-uuid story id with 400', async () => {
    const res = await app().request('/v1/stories/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns a known demo story', async () => {
    freshForumServices();
    const res = await app().request('/v1/stories/5f5e1000-0000-4000-8000-000000000001');
    expect(res.status).toBe(200);
    const body = storyDetailSchema.parse(await res.json());
    expect(body.story_id).toBe('5f5e1000-0000-4000-8000-000000000001');
  });

  it('serves schema-valid thread / branch / room bodies from the REAL stores', async () => {
    const fixture = freshForumServices();
    const a = app();
    const { threadId } = await seedThread(fixture);
    // Each body must satisfy its shared schema (the server re-validates on
    // egress; this guards the contract end to end).
    threadDetailSchema.parse(await (await a.request(`/v1/threads/${threadId}`)).json());
    branchContentSchema.parse(
      await (await a.request(`/v1/threads/${threadId}/branches/overview`)).json(),
    );
    roomListResponseSchema.parse(await (await a.request('/v1/rooms')).json());
  });

  it('requires authentication for the Signal Ledger (owner-only, WS-E.2.1d)', async () => {
    const res = await app().request('/v1/signal-ledger');
    expect(res.status).toBe(401);
  });

  it('serves an authenticated user their own (initially empty) Signal Ledger', async () => {
    const { identity } = freshEventServices();
    const { cookie } = await seedUserWithSession(identity);
    const res = await app().request(
      new Request('http://local/v1/signal-ledger', { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = signalLedgerResponseSchema.parse(await res.json());
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it('returns 404 for a valid-but-unknown story id', async () => {
    const res = await app().request(`/v1/stories/${VALID_UUID}`);
    expect(res.status).toBe(404);
  });

  it('rejects an unknown thread branch with 400', async () => {
    const res = await app().request(`/v1/threads/${VALID_UUID}/branches/bogus`);
    expect(res.status).toBe(400);
  });
});

describe('v1 auth + settings + flags', () => {
  it('reports unauthenticated without a session backend', async () => {
    const res = await app().request('/v1/auth/status');
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it('returns default settings then persists a patch', async () => {
    const a = app();
    expect(await (await a.request('/v1/settings')).json()).toEqual(DEFAULT_USER_SETTINGS);

    const patched = await a.request(
      jsonRequest('/v1/settings', 'PATCH', { feed_mode: 'chronological' }),
    );
    const body = userSettingsSchema.parse(await patched.json());
    expect(body.feed_mode).toBe('chronological');
    expect(body.personalization_enabled).toBe(true);
  });

  it('serves fail-closed crypto/governance + the WS-Q content surface', async () => {
    const res = await app().request('/v1/feature-flags');
    expect(await res.json()).toEqual({
      cryptoEnabled: false,
      governanceEnabled: false,
      regionFlags: {},
      // WS-Q.6.2 — content flags default ON (the live model); the video caps
      // mirror ingestion config (defaults). Crypto/governance stay fail-closed.
      content: {
        media_posts_enabled: true,
        in_room_visibility_enabled: true,
        binary_visibility_ui: true,
        video_max_bytes: 200 * 1024 * 1024,
        video_max_seconds: 600,
      },
    });
  });
});

describe('v1 writes', () => {
  it('requires authentication for contribution creation (WS-G.3.1)', async () => {
    freshForumServices();
    const res = await app().request(
      jsonRequest('/v1/contributions', 'POST', {
        thread_id: VALID_UUID,
        type: 'question',
        body: 'What evidence supports this?',
        client_draft_id: 'draft-1',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a malformed unauthenticated contribution with 401 (auth precedes validation)', async () => {
    freshForumServices();
    const res = await app().request(
      jsonRequest('/v1/contributions', 'POST', { thread_id: 'nope', type: 'evidence' }),
    );
    // Authentication runs BEFORE body validation: anonymous callers learn
    // nothing about the contract from malformed probes.
    expect(res.status).toBe(401);
  });

  it('acknowledges a safety report', async () => {
    const res = await app().request(
      jsonRequest('/v1/reports', 'POST', {
        target_type: 'contribution',
        target_id: VALID_UUID,
        reason: 'Off-topic harassment',
        local_operation_id: 'op-1',
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'received', local_operation_id: 'op-1' });
  });

  it('rejects an unauthenticated attention upload (WS-E.1.3a)', async () => {
    const aggregate = attentionAggregateSchema.parse({
      aggregate_id: VALID_UUID,
      user_id_or_privacy_bucket: 'privacy-bucket',
      story_id: '22222222-2222-4222-8222-222222222222',
      session_bucket: '2026-06-09T13:00:00.000Z',
      active_dwell_bucket: 'short',
      source_opened: true,
      context_opened: false,
      branch_depth_bucket: 'shallow',
      return_visit_count_bucket: 'none',
      privacy_level: 'minimum',
      created_at: '2026-06-09T13:30:00.000Z',
    });
    const res = await app().request(
      jsonRequest('/v1/attention/aggregates', 'POST', { aggregates: [aggregate] }),
    );
    expect(res.status).toBe(401);
  });

  it('ingests an authenticated attention aggregate batch through the WS-E pipeline', async () => {
    const { identity } = freshEventServices();
    const { userId, cookie } = await seedUserWithSession(identity);
    const aggregate = legacyAggregate(userId);
    const res = await app().request(
      new Request('http://local/v1/attention/aggregates', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ aggregates: [aggregate] }),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
  });

  it('ingests a privacy-safe telemetry batch and acks the accepted count', async () => {
    const events = [
      {
        name: 'navigation',
        bucket: '/stories/$storyId',
        value: 12.5,
        at: '2026-06-09T13:30:00.000Z',
      },
      {
        name: 'web_vital',
        metric: 'LCP',
        value: 980,
        rating: 'good',
        at: '2026-06-09T13:30:01.000Z',
      },
    ];
    const res = await app().request(jsonRequest('/v1/telemetry', 'POST', { events }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2 });
  });

  it('rejects a malformed telemetry event (unknown name) with 400', async () => {
    const res = await app().request(
      jsonRequest('/v1/telemetry', 'POST', {
        events: [{ name: 'not-an-event', at: '2026-06-09T13:30:00.000Z' }],
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('v1 push + notifications', () => {
  it('reports push unconfigured when no VAPID env is set', async () => {
    const res = await app().request('/v1/push/vapid-public-key');
    expect(res.status).toBe(503);
  });

  it('registers and removes a push subscription', async () => {
    const a = app();
    const sub = {
      subscription: {
        endpoint: 'https://push.example/abc',
        keys: { p256dh: 'x', auth: 'y' },
      },
    };
    const reg = await a.request(jsonRequest('/v1/push/subscriptions', 'POST', sub));
    expect(reg.status).toBe(201);
    expect(await reg.json()).toEqual({ ok: true });

    const del = await a.request(
      jsonRequest('/v1/push/subscriptions', 'DELETE', { endpoint: sub.subscription.endpoint }),
    );
    expect(await del.json()).toEqual({ ok: true });
  });

  it('returns default notification preferences then merges a patch', async () => {
    const a = app();
    const prefs = notificationPreferencesSchema.parse(
      await (await a.request('/v1/notifications/preferences')).json(),
    );
    expect(prefs.grouping).toBe(true);

    const patched = await a.request(
      jsonRequest('/v1/notifications/preferences', 'PATCH', { daily_digest: true }),
    );
    const body = notificationPreferencesSchema.parse(await patched.json());
    expect(body.daily_digest).toBe(true);
    expect(body.grouping).toBe(true);
  });
});
