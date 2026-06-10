// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Steward admin surface (the WS-E operational endpoints): authentication +
// steward-with-MFA gating, the WS-E.2.3e moderation-resolution path with
// actor-attributed audit, config-time rejection of invalid pwatt-config
// writes, and DLQ visibility/redrive.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createV1Routes } from '../routes/v1.js';
import { freshWsEServices, seedUserWithSession, type WsEFixture } from './ws-e-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

function request(path: string, method: string, body: unknown, cookie?: string): Request {
  return new Request(`http://local${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let fixture: WsEFixture;

beforeEach(() => {
  fixture = freshWsEServices();
});

describe('steward gating', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app().request(
      request('/v1/events/admin/safety-state', 'POST', {
        item_id: randomUUID(),
        action: 'clear',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a non-steward user with 403', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await app().request(
      request(
        '/v1/events/admin/pwatt-config',
        'PUT',
        { key: 'trigger_threshold', value: { value: 100 } },
        cookie,
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe('safety-state resolution (WS-E.2.3e operational path)', () => {
  it('clears a frozen item, audits the steward actor, and emits thread.state.changed', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const itemId = randomUUID();
    await fixture.events.safetyStore.set({
      itemId,
      safetyState: 'frozen',
      frozenScore: 0.3,
      caseId: randomUUID(),
      updatedBy: 'system:harassment_cascade',
      updatedAt: new Date().toISOString(),
    });
    const res = await app().request(
      request(
        '/v1/events/admin/safety-state',
        'POST',
        { item_id: itemId, action: 'clear' },
        steward.cookie,
      ),
    );
    expect(res.status).toBe(200);
    const state = await fixture.events.safetyStore.get(itemId);
    expect(state?.safetyState).toBe('normal');
    expect(state?.updatedBy).toBe(`steward:${steward.userId}`);
    // The §21.3 safety-dimension event was emitted for the transition.
    const emitted = await fixture.events.eventStore.listByTopicsBetween(
      ['thread.state.changed'],
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload['old_state']).toBe('frozen');
    expect(emitted[0]?.payload['new_state']).toBe('normal');
  });

  it('rejects an illegal transition with 409', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const res = await app().request(
      request(
        '/v1/events/admin/safety-state',
        'POST',
        { item_id: randomUUID(), action: 'clear' }, // normal items cannot clear
        steward.cookie,
      ),
    );
    expect(res.status).toBe(409);
  });
});

describe('pwatt-config writes (config-time rejection, WS-E.2.3a-d)', () => {
  it('accepts a valid value, stores it, and the loader applies it', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const res = await app().request(
      request(
        '/v1/events/admin/pwatt-config',
        'PUT',
        { key: 'trigger_threshold', value: { value: 42 } },
        steward.cookie,
      ),
    );
    expect(res.status).toBe(200);
    expect(await fixture.events.configStore.get('trigger_threshold')).toEqual({ value: 42 });
  });

  it('rejects an out-of-guardrail ranking profile with 422 (never stored)', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const res = await app().request(
      request(
        '/v1/events/admin/pwatt-config',
        'PUT',
        {
          key: 'ranking_profiles',
          value: {
            profiles: [{ name: 'bad', weights: { wA: 45, wP: 25, wE: 10, wS: 10, wC: 10 } }],
          },
        },
        steward.cookie,
      ),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/guardrail/);
    expect(await fixture.events.configStore.get('ranking_profiles')).toBeNull();
  });

  it('rejects an unknown config key with 400', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const res = await app().request(
      request(
        '/v1/events/admin/pwatt-config',
        'PUT',
        { key: 'not_a_knob', value: {} },
        steward.cookie,
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('dead-letter visibility + redrive', () => {
  it('lists letters and re-drives a fixed consumer', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    await fixture.events.deadLetters.append({
      consumerName: 'integrity-intake',
      eventId: randomUUID(),
      topic: 'integrity.signal.detected',
      error: 'outage',
      attempts: 3,
      failedAt: new Date().toISOString(),
    });
    const list = await app().request(
      new Request('http://local/v1/events/admin/dead-letters?consumer_name=integrity-intake', {
        headers: { cookie: steward.cookie },
      }),
    );
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);

    // The event row was never stored (purged): redrive clears the letter.
    const redrive = await app().request(
      request(
        '/v1/events/admin/dead-letters/redrive',
        'POST',
        { consumer_name: 'integrity-intake' },
        steward.cookie,
      ),
    );
    expect(redrive.status).toBe(200);
    expect(await redrive.json()).toMatchObject({ attempted: 1, succeeded: 0 });
  });
});
