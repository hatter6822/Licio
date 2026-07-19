// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Attention-ingestion acceptance (WS-E.1.3a-e): authentication, ownership,
// replay protection (nonce + durable backstop), timestamp windows, per-user
// sliding-window rate limiting with fail-closed fallback, server-side privacy
// enforcement, pseudonymization at rest, and the log-redaction guarantee
// (no attention values in logs or metrics).
import { defaultPrivacySettings } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ingestAttentionEvents,
  OFFLINE_SYNC_ACCEPTANCE,
  ONLINE_ACCEPTANCE,
  PSEUDONYMOUS_USER_ID,
} from '../events/ingest.js';
import { IngestRateLimiter, type SlidingWindowStore } from '../events/ingest-limiter.js';
import { PRIVACY_BUCKET } from '../events/stores.js';
import { createV1Routes } from '../routes/v1.js';
import {
  attentionEvent,
  type EventServicesFixture,
  freshEventServices,
  legacyAggregate,
  seedUserWithSession,
  sourceOpenEvent,
} from './event-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`http://local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

let fixture: EventServicesFixture;
let logged: Array<{ event: string; meta: Record<string, unknown> }>;

beforeEach(() => {
  logged = [];
  fixture = freshEventServices({
    log: (event, meta) => logged.push({ event, meta }),
  });
});

describe('POST /v1/events/attention (WS-E.1.3a)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app().request(
      post('/v1/events/attention', attentionEvent('33333333-3333-4333-8333-333333333333')),
    );
    expect(res.status).toBe(401);
  });

  it('accepts a valid event with 202 and an event receipt id', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const event = attentionEvent(userId);
    const res = await app().request(post('/v1/events/attention', event, cookie));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ receipt_id: event.event_id, status: 'accepted' });
    // Stored durably with classification + tier (WS-E.3.1).
    const stored = await fixture.events.eventStore.listByOwner(userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.privacyClassification).toBe('aggregated');
    expect(stored[0]?.retentionTier).toBe('attention_aggregated');
    // The §22.1 aggregate row was written for the durable aggregation.
    expect(await fixture.events.attentionStore.listByUser(userId)).toHaveLength(1);
  });

  it('rejects an event whose user_id is not the session user with 403', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const other = await seedUserWithSession(fixture.identity, { handle: 'otherreader' });
    const res = await app().request(
      post('/v1/events/attention', attentionEvent(other.userId), cookie),
    );
    expect(res.status).toBe(403);
  });

  it('rejects a replayed nonce with 409 (WS-E.1.3b)', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const event = attentionEvent(userId);
    expect((await app().request(post('/v1/events/attention', event, cookie))).status).toBe(202);
    const replay = await app().request(post('/v1/events/attention', event, cookie));
    expect(replay.status).toBe(409);
  });

  it('rejects replays even after the nonce TTL via the durable event-id backstop', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const event = attentionEvent(userId);
    expect((await app().request(post('/v1/events/attention', event, cookie))).status).toBe(202);
    // Simulate the Redis nonce expiring: the fast layer forgets the nonce.
    await fixture.events.replay.clear();
    const replay = await app().request(post('/v1/events/attention', event, cookie));
    expect(replay.status).toBe(409);
    // The replay added NOTHING durable: §22.1 aggregate rows are dropped with
    // the duplicate event, never double-counted in retention/export/scoring.
    expect(await fixture.events.attentionStore.listByUser(userId)).toHaveLength(1);
  });

  it('rejects an offline-sync replay past the 10-min TTL, even after the durable row is purged (WS-E.1.3b)', async () => {
    // The `none`/shortened-retention gap: the durable event row is purged before
    // the 7-day offline window closes, so ONLY the replay nonce can catch a
    // re-ingest.  The nonce must therefore span the acceptance window.
    let clock = Date.parse('2026-06-22T00:00:00Z');
    const local = freshEventServices({ now: () => clock });
    const { userId } = await seedUserWithSession(local.identity, { nowMs: clock });
    const event = attentionEvent(userId, { timestamp: new Date(clock).toISOString() });
    const first = await ingestAttentionEvents(
      local.events,
      local.identity,
      userId,
      [event],
      OFFLINE_SYNC_ACCEPTANCE,
    );
    expect(first.outcomes).toEqual(['accepted']);
    // Simulate the retention sweep purging the durable row (the `none` case).
    await local.events.eventStore.deleteByOwner(userId);
    // 20 minutes later — past the OLD 10-min nonce TTL, still inside the 7 days.
    clock += 20 * 60_000;
    const replay = await ingestAttentionEvents(
      local.events,
      local.identity,
      userId,
      [event],
      OFFLINE_SYNC_ACCEPTANCE,
    );
    expect(replay.outcomes).toEqual(['replay']);
  });

  it('rejects stale (> 5 min) and future (> 30 s) timestamps with 400', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const stale = attentionEvent(userId, {
      timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
    });
    const staleRes = await app().request(post('/v1/events/attention', stale, cookie));
    expect(staleRes.status).toBe(400);
    expect(((await staleRes.json()) as { error: { code: string } }).error.code).toBe(
      'stale_timestamp',
    );
    const future = attentionEvent(userId, {
      timestamp: new Date(Date.now() + 60_000).toISOString(),
    });
    const futureRes = await app().request(post('/v1/events/attention', future, cookie));
    expect(futureRes.status).toBe(400);
    expect(((await futureRes.json()) as { error: { code: string } }).error.code).toBe(
      'future_timestamp',
    );
  });

  it('rejects schema-invalid events with 400 (raw dwell values can never enter)', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const forged = {
      ...attentionEvent(userId),
      items: [{ story_id: userId, active_dwell_bucket: 145_000 }],
    };
    const res = await app().request(post('/v1/events/attention', forged, cookie));
    expect(res.status).toBe(400);
  });

  it('accepts source.opened.aggregate through the identical guards (WS-E.1.3e)', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const event = sourceOpenEvent(userId, { bounce: true });
    const res = await app().request(post('/v1/events/attention', event, cookie));
    expect(res.status).toBe(202);
    // The bounce flag is preserved end to end for the clickbait guardrail.
    const stored = await fixture.events.eventStore.listByOwner(userId);
    expect(stored[0]?.payload['bounce']).toBe(true);
    // And the replay guard applies identically.
    expect((await app().request(post('/v1/events/attention', event, cookie))).status).toBe(409);
  });

  it('enforces the per-user rate limit with 429 + Retry-After (WS-E.1.3c)', async () => {
    fixture = freshEventServices({ limits: { perMinute: 2, perHour: 100 } });
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    expect(
      (await app().request(post('/v1/events/attention', attentionEvent(userId), cookie))).status,
    ).toBe(202);
    expect(
      (await app().request(post('/v1/events/attention', attentionEvent(userId), cookie))).status,
    ).toBe(202);
    const limited = await app().request(
      post('/v1/events/attention', attentionEvent(userId), cookie),
    );
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(61);
  });

  it('malformed bodies consume the rate-limit budget (no free validation hammering)', async () => {
    fixture = freshEventServices({ limits: { perMinute: 2, perHour: 100 } });
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    // Two schema-invalid requests: rejected 400, but each consumed a hit —
    // the limiter runs BEFORE validation (the documented guard chain).
    expect((await app().request(post('/v1/events/attention', { junk: true }, cookie))).status).toBe(
      400,
    );
    expect((await app().request(post('/v1/events/attention', { junk: true }, cookie))).status).toBe(
      400,
    );
    const limited = await app().request(
      post('/v1/events/attention', attentionEvent(userId), cookie),
    );
    expect(limited.status).toBe(429);
  });
});

describe('server-side privacy enforcement (WS-E.1.3d)', () => {
  it('discards events from personalization-disabled users with 204', async () => {
    const settings = { ...defaultPrivacySettings(), personalization_enabled: false };
    const { userId, cookie } = await seedUserWithSession(fixture.identity, {
      privacySettings: settings,
    });
    const res = await app().request(post('/v1/events/attention', attentionEvent(userId), cookie));
    expect(res.status).toBe(204);
    // Nothing was stored anywhere.
    expect(await fixture.events.eventStore.listByOwner(userId)).toHaveLength(0);
    expect(await fixture.events.attentionStore.listByUser(userId)).toHaveLength(0);
    // The enforcement decision is compliance-logged (action only, no payload).
    const enforcement = logged.find((l) => l.event === 'events.attention.privacy_enforced');
    expect(enforcement?.meta).toEqual({
      user_id: userId,
      enforcement_action: 'personalization_disabled',
    });
  });

  it('honors retention `none`: real-time only, purge after the ranking window', async () => {
    const settings = {
      ...defaultPrivacySettings(),
      attention_retention_preference: 'none' as const,
    };
    const { userId, cookie } = await seedUserWithSession(fixture.identity, {
      privacySettings: settings,
    });
    const res = await app().request(post('/v1/events/attention', attentionEvent(userId), cookie));
    expect(res.status).toBe(202);
    // The event row exists ONLY with a ranking-window purge deadline…
    const stored = await fixture.events.eventStore.listByOwner(userId);
    expect(stored).toHaveLength(1);
    const purgeAfter = Date.parse(stored[0]?.purgeAfter ?? '');
    expect(purgeAfter - Date.now()).toBeLessThanOrEqual(3_600_000 + 5_000);
    // …and NO durable §22.1 aggregate row is written (no long-term trace).
    expect(await fixture.events.attentionStore.listByUser(userId)).toHaveLength(0);
  });

  it('honors retention `minimal`: the 90-day tier minimum', async () => {
    const settings = {
      ...defaultPrivacySettings(),
      attention_retention_preference: 'minimal' as const,
    };
    const { userId, cookie } = await seedUserWithSession(fixture.identity, {
      privacySettings: settings,
    });
    const event = attentionEvent(userId);
    await app().request(post('/v1/events/attention', event, cookie));
    const stored = await fixture.events.eventStore.listByOwner(userId);
    const purgeAfter = Date.parse(stored[0]?.purgeAfter ?? '');
    const expected = Date.parse(event.timestamp) + 90 * 86_400_000;
    expect(Math.abs(purgeAfter - expected)).toBeLessThan(5_000);
  });

  it('neutralizes an incoherent aggregate (reply traversal with zero dwell, §25.5)', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const event = attentionEvent(userId, {
      items: [
        {
          story_id: '55555555-5555-4555-8555-555555555555',
          active_dwell_bucket: 'none',
          source_opened: true, // a real signal, so the item survives normalization
          context_opened: false,
          reply_depth_bucket: 'deep', // client-impossible with zero active dwell
          return_visit_count_bucket: 'none',
        },
      ],
    });
    const res = await app().request(post('/v1/events/attention', event, cookie));
    expect(res.status).toBe(202);
    // The stored event payload has the fabricated traversal neutralized…
    const stored = await fixture.events.eventStore.listByOwner(userId);
    const items = (
      stored[0]?.payload as { items?: Array<{ reply_depth_bucket?: string }> } | undefined
    )?.items;
    expect(items?.[0]?.reply_depth_bucket).toBe('none');
    // …and so does the durable §22.1 aggregate row.
    const rows = await fixture.events.attentionStore.listByUser(userId);
    expect(rows[0]?.reply_depth_bucket).toBe('none');
  });

  it('DISCARDS an aggregate emptied by normalization (no signal-free row, §25.5)', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    // The ONLY signal is reply-depth with zero dwell — neutralized to `none`,
    // which empties the item entirely. It must not be stored (an empty row would
    // still seed eventCount / a burst actor / read history).
    const event = attentionEvent(userId, {
      items: [
        {
          story_id: '55555555-5555-4555-8555-555555555555',
          active_dwell_bucket: 'none',
          source_opened: false,
          context_opened: false,
          reply_depth_bucket: 'deep',
          return_visit_count_bucket: 'none',
        },
      ],
    });
    const res = await app().request(post('/v1/events/attention', event, cookie));
    expect(res.status).toBe(202); // the upload is valid, just empty
    expect(await fixture.events.eventStore.listByOwner(userId)).toHaveLength(0);
    expect(await fixture.events.attentionStore.listByUser(userId)).toHaveLength(0);
  });

  it('a mid-session settings change takes effect on the next event', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    expect(
      (await app().request(post('/v1/events/attention', attentionEvent(userId), cookie))).status,
    ).toBe(202);
    await fixture.identity.store.updateUser(userId, {
      privacySettings: { ...defaultPrivacySettings(), personalization_enabled: false },
    });
    expect(
      (await app().request(post('/v1/events/attention', attentionEvent(userId), cookie))).status,
    ).toBe(204);
  });

  it('pseudonymizes minimum-privacy events at rest (SPEC §19.2 / §22.1)', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const event = attentionEvent(userId, { privacy_level: 'minimum' });
    const res = await app().request(post('/v1/events/attention', event, cookie));
    expect(res.status).toBe(202);
    // The stored event row carries NO owner and a rewritten user_id…
    expect(await fixture.events.eventStore.listByOwner(userId)).toHaveLength(0);
    const all = await fixture.events.eventStore.listByTopicsBetween(
      ['attention.aggregate'],
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(all).toHaveLength(1);
    expect(all[0]?.ownerUserId).toBeNull();
    expect(all[0]?.payload['user_id']).toBe(PSEUDONYMOUS_USER_ID);
    // …and the §22.1 row carries the privacy bucket, never the user id.
    const aggregates = await fixture.events.attentionStore.listByUser(PRIVACY_BUCKET);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]?.privacy_level).toBe('minimum');
  });

  it('enforces the durable identification floor against a weaker claim (§19.2)', async () => {
    // The user's DURABLE setting is `minimum`; a buggy or compromised client
    // claims `standard`. The server must store at the user's floor — the
    // claim can strengthen pseudonymization, never weaken it.
    const settings = {
      ...defaultPrivacySettings(),
      attention_privacy_level: 'minimum' as const,
    };
    const { userId, cookie } = await seedUserWithSession(fixture.identity, {
      privacySettings: settings,
    });
    const event = attentionEvent(userId, { privacy_level: 'standard' });
    const res = await app().request(post('/v1/events/attention', event, cookie));
    expect(res.status).toBe(202);
    // Stored exactly as a minimum-privacy event: de-linked at rest.
    expect(await fixture.events.eventStore.listByOwner(userId)).toHaveLength(0);
    const all = await fixture.events.eventStore.listByTopicsBetween(
      ['attention.aggregate'],
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(all).toHaveLength(1);
    expect(all[0]?.ownerUserId).toBeNull();
    expect(all[0]?.payload['user_id']).toBe(PSEUDONYMOUS_USER_ID);
    // The stored payload carries the SERVER-ENFORCED level, not the `standard`
    // claim: `actorKeyOfPayload` keys on `privacy_level`, so it must read
    // `minimum` here or the row would fold under the synthetic UUID instead of
    // `privacy-bucket` and split this reader into two actors.
    expect(all[0]?.payload['privacy_level']).toBe('minimum');
    const aggregates = await fixture.events.attentionStore.listByUser(PRIVACY_BUCKET);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]?.privacy_level).toBe('minimum');
    expect(await fixture.events.attentionStore.listByUser(userId)).toHaveLength(0);
  });
});

describe('legacy batch wire (WS-E.1.3e: identical pipeline)', () => {
  it('acks accepted: 0 for a full-duplicate replayed batch (idempotent sync retry)', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const batch = { aggregates: [legacyAggregate(userId), legacyAggregate(userId)] };
    const first = await app().request(post('/v1/attention/aggregates', batch, cookie));
    expect(await first.json()).toEqual({ accepted: 2 });
    const replay = await app().request(post('/v1/attention/aggregates', batch, cookie));
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ accepted: 0 });
    // No double-stored rows.
    expect(await fixture.events.attentionStore.listByUser(userId)).toHaveLength(2);
  });

  it('rejects a batch attributing attention to another user with 403', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const other = await seedUserWithSession(fixture.identity, { handle: 'otherbatch' });
    const res = await app().request(
      post('/v1/attention/aggregates', { aggregates: [legacyAggregate(other.userId)] }, cookie),
    );
    expect(res.status).toBe(403);
  });

  it('accepts privacy-bucket aggregates from an authenticated session', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await app().request(
      post(
        '/v1/attention/aggregates',
        { aggregates: [legacyAggregate(PRIVACY_BUCKET, { privacy_level: 'minimum' })] },
        cookie,
      ),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
  });

  it('accepts offline-sync batches days old (the §6.9 replay window)', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const res = await app().request(
      post(
        '/v1/attention/aggregates',
        { aggregates: [legacyAggregate(userId, { created_at: twoDaysAgo })] },
        cookie,
      ),
    );
    expect(await res.json()).toEqual({ accepted: 1 });
    // But not beyond the 7-day ceiling (attention_raw bound).
    const tooOld = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const rejected = await app().request(
      post(
        '/v1/attention/aggregates',
        { aggregates: [legacyAggregate(userId, { created_at: tooOld })] },
        cookie,
      ),
    );
    expect(await rejected.json()).toEqual({ accepted: 0 });
  });

  it('malformed batches consume the rate-limit budget (identical guard order, WS-E.1.3e)', async () => {
    fixture = freshEventServices({ limits: { perMinute: 2, perHour: 100 } });
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    expect(
      (await app().request(post('/v1/attention/aggregates', { aggregates: 'junk' }, cookie)))
        .status,
    ).toBe(400);
    expect(
      (await app().request(post('/v1/attention/aggregates', { aggregates: 'junk' }, cookie)))
        .status,
    ).toBe(400);
    const limited = await app().request(
      post('/v1/attention/aggregates', { aggregates: [legacyAggregate(userId)] }, cookie),
    );
    expect(limited.status).toBe(429);
  });
});

describe('observability discipline (WS-E.1.3a)', () => {
  it('logs event ids and user id but never attention values', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [attentionEvent(userId)],
      ONLINE_ACCEPTANCE,
    );
    const accepted = logged.find((l) => l.event === 'events.attention.accepted');
    expect(accepted).toBeDefined();
    const serialized = JSON.stringify(accepted);
    // No bucket names, dwell values, or per-item fields in any log line.
    for (const forbidden of [
      'dwell',
      'bucket',
      'source_opened',
      'context_opened',
      'medium',
      'story_id',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
    expect(accepted?.meta['user_id']).toBe(userId);
    expect(Array.isArray(accepted?.meta['event_ids'])).toBe(true);
  });

  it('counts accepted and rejected events by reason (no values in names)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const event = attentionEvent(userId);
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [event],
      ONLINE_ACCEPTANCE,
    );
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [event],
      ONLINE_ACCEPTANCE,
    );
    expect(fixture.events.metrics.counter('events_attention_accepted')).toBe(1);
    expect(fixture.events.metrics.counter('events_attention_rejected_replay')).toBe(1);
  });
});

describe('rate limiter degradation (WS-E.1.3c fail-closed)', () => {
  it('falls back to conservative in-memory limits when the primary store fails', async () => {
    const failing: SlidingWindowStore = {
      hit: async () => {
        throw new Error('redis down');
      },
      nthOldest: async () => {
        throw new Error('redis down');
      },
      clear: async () => {},
    };
    let degradations = 0;
    const limiter = new IngestRateLimiter(
      failing,
      { perMinute: 10, perHour: 120 },
      { onDegraded: () => (degradations += 1) },
    );
    // 50% of 10 = 5 per minute on the fallback: the 6th hit is denied.
    const decisions = [];
    for (let i = 0; i < 6; i += 1) decisions.push(await limiter.hit('user-1'));
    expect(decisions.slice(0, 5).every((d) => d.allowed && d.degraded)).toBe(true);
    expect(decisions[5]?.allowed).toBe(false);
    expect(degradations).toBe(6);
  });

  it('uses true sliding windows (no burst-at-boundary reset)', async () => {
    const { events } = freshEventServices({ limits: { perMinute: 3, perHour: 100 } });
    const t0 = Date.now();
    expect((await events.ingestLimiter.hit('u', t0)).allowed).toBe(true);
    expect((await events.ingestLimiter.hit('u', t0 + 1_000)).allowed).toBe(true);
    expect((await events.ingestLimiter.hit('u', t0 + 2_000)).allowed).toBe(true);
    // A fixed window would reset at t0+60s; the sliding window still counts
    // the three hits at t0+59.5s and only re-admits after the FIRST ages out.
    const denied = await events.ingestLimiter.hit('u', t0 + 59_500);
    expect(denied.allowed).toBe(false);
    const admitted = await events.ingestLimiter.hit('u', t0 + 61_500);
    expect(admitted.allowed).toBe(true);
  });

  it('OFFLINE acceptance window is exactly the 7-day attention_raw ceiling', () => {
    expect(OFFLINE_SYNC_ACCEPTANCE.maxPastMs).toBe(7 * 86_400_000);
    expect(OFFLINE_SYNC_ACCEPTANCE.maxFutureMs).toBe(ONLINE_ACCEPTANCE.maxFutureMs);
  });
});

describe('endpoint load smoke (WS-E.1.3a)', () => {
  it('sustains a 300-request burst through the full guard chain', async () => {
    fixture = freshEventServices({ limits: { perMinute: 1_000, perHour: 10_000 } });
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const a = app();
    const startedAt = Date.now();
    for (let i = 0; i < 300; i += 1) {
      const res = await a.request(post('/v1/events/attention', attentionEvent(userId), cookie));
      expect(res.status).toBe(202);
    }
    const elapsedMs = Date.now() - startedAt;
    // Generous in-process bound: the chain (auth + limiter + schema +
    // ownership + replay + privacy + store + publish) must not degrade
    // super-linearly. ~<20ms/request average on CI hardware.
    expect(elapsedMs).toBeLessThan(6_000);
    expect(fixture.events.metrics.counter('events_attention_accepted')).toBe(300);
    const { latency } = fixture.events.metrics.snapshot();
    expect(latency.count).toBe(300);
  }, 20_000);
});
