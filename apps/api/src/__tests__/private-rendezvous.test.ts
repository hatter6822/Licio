// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.6 — server-blind rendezvous tests (PRIVATE_SPEC §15.3, §15.4, §21.5,
// §27.2): the service-level TTL bound (reject-not-clamp, since `expires_at` is
// AAD-bound) + no-existence-oracle + signal round-trip + aggregate-only metrics;
// the route-level shape validation / oversized rejection (with AND without
// Content-Length); and the full-app mount proving the endpoints are CSRF-exempt
// (a P2P client holds no session) and never 404 on poll.
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { runRendezvousTick } from '../private-rendezvous/scheduler.js';
import {
  DEFAULT_RENDEZVOUS_CONFIG,
  RendezvousService,
  setRendezvousService,
} from '../private-rendezvous/service.js';
import { InMemoryRendezvousStore } from '../private-rendezvous/stores.js';
import { createPrivateRendezvousRoutes } from '../routes/private-rendezvous.js';

const ROOM_BLIND = 'cm9vbS1ibGluZA';
const PEER_BLIND = 'cGVlci1ibGluZA';
const PEER_BLIND_2 = 'cGVlci1ibGluZC0y';
const ANNOUNCEMENT = 'c2VhbGVkLWFubm91bmNlbWVudA';

function announceBody(over: Record<string, unknown> = {}) {
  return {
    room_blind_id: ROOM_BLIND,
    peer_blind_id: PEER_BLIND,
    encrypted_announcement: ANNOUNCEMENT,
    expires_at: Date.now() + 10 * 60_000,
    ...over,
  };
}

describe('RendezvousService — TTL bound + no-existence-oracle (§15.3)', () => {
  it('announces then polls the record back', async () => {
    const svc = new RendezvousService(new InMemoryRendezvousStore());
    await svc.announce(announceBody());
    const { records } = await svc.poll(ROOM_BLIND);
    expect(records).toHaveLength(1);
    expect(records[0]?.peer_blind_id).toBe(PEER_BLIND);
    expect(records[0]?.encrypted_announcement).toBe(ANNOUNCEMENT);
  });

  it('rejects a far-future TTL beyond the server bound (no silent clamp)', async () => {
    const clock = 1_000_000;
    const svc = new RendezvousService(
      new InMemoryRendezvousStore(),
      DEFAULT_RENDEZVOUS_CONFIG,
      () => clock,
    );
    // A 10-hour TTL far exceeds maxTtlMs + skew; the server REJECTS it rather than
    // clamping — clamping would rewrite the AAD-bound expiry and break peer decrypt.
    const { stored } = await svc.announce(announceBody({ expires_at: clock + 10 * 60 * 60_000 }));
    expect(stored).toBe(false);
    expect((await svc.poll(ROOM_BLIND)).records).toHaveLength(0);
  });

  it('stores a max-TTL expiry VERBATIM despite minor client-ahead clock skew', async () => {
    let clock = 1_000_000;
    const svc = new RendezvousService(
      new InMemoryRendezvousStore(),
      DEFAULT_RENDEZVOUS_CONFIG,
      () => clock,
    );
    // Client clock 2 min ahead: it stamps expires_at = serverNow + 30min + 2min,
    // within the 35-min bound (maxTtl 30 + skew 5), so it stores UNCHANGED.
    const expiresAt = clock + 30 * 60_000 + 2 * 60_000;
    const { stored } = await svc.announce(announceBody({ expires_at: expiresAt }));
    expect(stored).toBe(true);
    expect((await svc.poll(ROOM_BLIND)).records[0]?.expires_at).toBe(expiresAt);
    clock += 31 * 60_000; // past a hypothetical 30-min clamp, before the real 32-min expiry
    expect((await svc.poll(ROOM_BLIND)).records).toHaveLength(1);
  });

  it('drops an already-expired announcement', async () => {
    const clock = 5_000_000;
    const svc = new RendezvousService(
      new InMemoryRendezvousStore(),
      DEFAULT_RENDEZVOUS_CONFIG,
      () => clock,
    );
    const { stored } = await svc.announce(announceBody({ expires_at: clock - 1 }));
    expect(stored).toBe(false);
    expect((await svc.poll(ROOM_BLIND)).records).toHaveLength(0);
  });

  it('poll of an unknown blind id returns the SAME empty-list shape (no oracle)', async () => {
    const svc = new RendezvousService(new InMemoryRendezvousStore());
    const unknown = await svc.poll('dW5rbm93bg');
    expect(unknown).toStrictEqual({ records: [] });
  });

  it('a re-announce by the same peer replaces its record', async () => {
    const svc = new RendezvousService(new InMemoryRendezvousStore());
    await svc.announce(announceBody({ encrypted_announcement: 'Zmlyc3Q' }));
    await svc.announce(announceBody({ encrypted_announcement: 'c2Vjb25k' }));
    const { records } = await svc.poll(ROOM_BLIND);
    expect(records).toHaveLength(1);
    expect(records[0]?.encrypted_announcement).toBe('c2Vjb25k');
  });
});

describe('RendezvousService — signals (§15.4)', () => {
  const signalBody = {
    room_blind_id: ROOM_BLIND,
    sender_blind_id: PEER_BLIND,
    recipient_blind_id: PEER_BLIND_2,
    ciphertext: 'c2VhbGVkLXNpZ25hbA',
    expires_at: Date.now() + 60_000,
  };

  it('queues a signal and drains it once (drain deletes)', async () => {
    const svc = new RendezvousService(new InMemoryRendezvousStore());
    await svc.signal(signalBody);
    const first = await svc.drainSignals(PEER_BLIND_2);
    expect(first.signals).toHaveLength(1);
    expect(first.signals[0]?.ciphertext).toBe('c2VhbGVkLXNpZ25hbA');
    const second = await svc.drainSignals(PEER_BLIND_2);
    expect(second.signals).toHaveLength(0);
  });

  it('tracks aggregate-only metrics (no room identity)', async () => {
    const svc = new RendezvousService(new InMemoryRendezvousStore());
    await svc.announce(announceBody());
    await svc.poll(ROOM_BLIND);
    await svc.signal(signalBody);
    await svc.drainSignals(PEER_BLIND_2);
    const m = svc.metrics();
    expect(m.announces).toBe(1);
    expect(m.polls).toBe(1);
    expect(m.signalsPosted).toBe(1);
    expect(m.signalsDrained).toBe(1);
    expect(Object.keys(m).sort()).toStrictEqual([
      'announces',
      'polls',
      'signalsDrained',
      'signalsPosted',
      'swept',
    ]);
  });

  it('sweep removes expired presence + signals', async () => {
    let clock = 9_000_000;
    const svc = new RendezvousService(
      new InMemoryRendezvousStore(),
      DEFAULT_RENDEZVOUS_CONFIG,
      () => clock,
    );
    await svc.announce(announceBody({ expires_at: clock + 60_000 }));
    clock += 2 * 60_000; // both expired
    expect(await svc.sweep()).toBe(1);
  });

  it('the scheduler tick drives the sweep (and swallows a sweep error)', async () => {
    let clock = 11_000_000;
    const svc = new RendezvousService(
      new InMemoryRendezvousStore(),
      DEFAULT_RENDEZVOUS_CONFIG,
      () => clock,
    );
    await svc.announce(announceBody({ expires_at: clock + 60_000 }));
    clock += 2 * 60_000; // expired
    expect(await runRendezvousTick(svc)).toBe(1);

    // A throwing sweep is reported, not propagated (the tick returns 0).
    const broken = {
      sweep: () => Promise.reject(new Error('boom')),
    } as unknown as RendezvousService;
    let captured: unknown;
    expect(await runRendezvousTick(broken, (err) => (captured = err))).toBe(0);
    expect(captured).toBeInstanceOf(Error);
  });
});

describe('routes — shape validation + bounds', () => {
  beforeEach(() => {
    setRendezvousService(new RendezvousService(new InMemoryRendezvousStore()));
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    createPrivateRendezvousRoutes().request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('announce → 202 then poll → 200 with the record', async () => {
    const a = await post('/announce', announceBody());
    expect(a.status).toBe(202);
    expect(await a.json()).toStrictEqual({ stored: true });

    const p = await post('/poll', { room_blind_id: ROOM_BLIND });
    expect(p.status).toBe(200);
    const body = (await p.json()) as { records: unknown[] };
    expect(body.records).toHaveLength(1);
  });

  it('rejects a malformed body with 400', async () => {
    expect((await post('/announce', { room_blind_id: ROOM_BLIND })).status).toBe(400);
    expect((await post('/poll', { nope: 1 })).status).toBe(400);
    expect(
      (await post('/announce', { ...announceBody(), room_blind_id: 'has space' })).status,
    ).toBe(400);
  });

  it('rejects an oversized body with 413 (declared Content-Length)', async () => {
    const res = await post('/announce', announceBody(), { 'content-length': '200000' });
    expect(res.status).toBe(413);
  });

  it('enforces the size cap even WITHOUT a Content-Length (streamed/chunked body)', async () => {
    // A streamed body carries no Content-Length, so the cap must be enforced as the
    // stream is read — not bypassed until the whole body is buffered + parsed.
    const huge = 'x'.repeat(200_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    const res = await createPrivateRendezvousRoutes().request('/announce', {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'application/json' },
      // A streaming request body requires half-duplex per the Fetch standard.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(res.status).toBe(413);
  });

  it('signal → 202 then signal/poll → 200 drains it', async () => {
    const s = await post('/signal', {
      room_blind_id: ROOM_BLIND,
      sender_blind_id: PEER_BLIND,
      recipient_blind_id: PEER_BLIND_2,
      ciphertext: 'c2ln',
      expires_at: Date.now() + 60_000,
    });
    expect(s.status).toBe(202);
    const d = await post('/signal/poll', { peer_blind_id: PEER_BLIND_2 });
    expect(d.status).toBe(200);
    expect(((await d.json()) as { signals: unknown[] }).signals).toHaveLength(1);
  });
});

describe('full-app mount — CSRF-exempt + no existence oracle', () => {
  beforeEach(() => {
    setRendezvousService(new RendezvousService(new InMemoryRendezvousStore()));
  });

  it('poll is reachable WITHOUT a CSRF token and never 404s on an unknown room', async () => {
    const app = createApp();
    const res = await app.request('/v1/private-rendezvous/poll', {
      method: 'POST',
      body: JSON.stringify({ room_blind_id: 'dW5rbm93bi1yb29t' }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    // Not 403 (CSRF would block a tokenless POST otherwise); a bounded empty list.
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ records: [] });
  });

  it('announce is reachable WITHOUT a CSRF token (device-authenticated, sessionless)', async () => {
    const app = createApp();
    const res = await app.request('/v1/private-rendezvous/announce', {
      method: 'POST',
      body: JSON.stringify(announceBody()),
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(202);
  });
});
