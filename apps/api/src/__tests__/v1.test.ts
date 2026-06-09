// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  attentionAggregateSchema,
  contributionSchema,
  DEFAULT_USER_SETTINGS,
  feedResponseSchema,
  notificationPreferencesSchema,
  userSettingsSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPushState } from '../lib/push-service.js';
import { createV1Routes, resetSettingsState } from '../routes/v1.js';

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
  it('returns an empty, schema-valid feed page', async () => {
    const res = await app().request('/v1/feed');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => feedResponseSchema.parse(body)).not.toThrow();
  });

  it('rejects a non-uuid story id with 400', async () => {
    const res = await app().request('/v1/stories/not-a-uuid');
    expect(res.status).toBe(400);
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

  it('serves fail-closed feature flags', async () => {
    const res = await app().request('/v1/feature-flags');
    expect(await res.json()).toEqual({
      cryptoEnabled: false,
      governanceEnabled: false,
      regionFlags: {},
    });
  });
});

describe('v1 writes', () => {
  it('accepts a contribution and echoes the local draft id', async () => {
    const res = await app().request(
      jsonRequest('/v1/contributions', 'POST', {
        thread_id: VALID_UUID,
        branch: 'evidence',
        type: 'evidence',
        body: 'A primary source worth inspecting.',
        citations: ['https://example.org/doc'],
        local_draft_id: 'draft-1',
      }),
    );
    expect(res.status).toBe(201);
    const created = contributionSchema.parse(await res.json());
    expect(created.local_draft_id).toBe('draft-1');
    expect(created.moderation_state).toBe('pending');
  });

  it('rejects a malformed contribution with 400', async () => {
    const res = await app().request(
      jsonRequest('/v1/contributions', 'POST', { thread_id: 'nope', type: 'evidence' }),
    );
    expect(res.status).toBe(400);
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

  it('ingests an attention aggregate batch and acks the count', async () => {
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
    expect(await res.json()).toEqual({ accepted: 1 });
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
