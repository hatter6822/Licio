// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { getIdentityServices } from '../identity/services.js';
import { createSession } from '../identity/sessions.js';
import {
  getTokenStore,
  RedisTokenStore,
  setTokenStore,
  type TokenStore,
} from '../middleware/csrf.js';

/** Create a REAL session in the singleton (test-mode) identity store and return
 *  its `__Host-sid` cookie — the CSRF token route now mints only for a session
 *  that actually exists, so a forged cookie no longer works. */
async function sessionCookie(): Promise<string> {
  const { token } = await createSession(getIdentityServices().sessions, {
    userId: randomUUID(),
    authMethod: 'email_otp',
    deviceLabel: 'test',
    rememberMe: false,
  });
  return `__Host-sid=${token}`;
}

describe('CSRF protection', () => {
  afterEach(async () => {
    await getTokenStore().clear();
  });

  it('allows GET requests without a CSRF token', async () => {
    const app = createApp();
    const res = await app.request('/health', { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('rejects POST without a session cookie', async () => {
    const app = createApp();
    const res = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('rejects POST without a CSRF token', async () => {
    const app = createApp();
    const res = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=test-session-id',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('CSRF token required');
  });

  it('issues and accepts a valid CSRF token', async () => {
    const app = createApp();
    const cookie = await sessionCookie();

    const tokenRes = await app.request('/api/csrf-token', {
      method: 'GET',
      headers: { Cookie: cookie },
    });
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    expect(token).toBeDefined();
    expect(token.length).toBe(64);

    const postRes = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': token,
      },
      body: '{}',
    });
    expect(postRes.status).not.toBe(403);
  });

  it('does NOT mint a token for a forged (non-existent) session', async () => {
    const app = createApp();
    const res = await app.request('/api/csrf-token', {
      method: 'GET',
      headers: { Cookie: '__Host-sid=forged-never-issued' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('No session');
    // No store entry was created for the forged id (the unbounded-growth fix).
    expect(await getTokenStore().get('forged-never-issued')).toBeUndefined();
  });

  it('rejects a token from a different session', async () => {
    const app = createApp();
    const cookieOne = await sessionCookie();
    const cookieTwo = await sessionCookie();

    const tokenRes = await app.request('/api/csrf-token', {
      method: 'GET',
      headers: { Cookie: cookieOne },
    });
    const { token } = (await tokenRes.json()) as { token: string };

    const postRes = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieTwo,
        'X-CSRF-Token': token,
      },
      body: '{}',
    });
    expect(postRes.status).toBe(403);
    const body = (await postRes.json()) as { error: string };
    expect(body.error).toMatch(/CSRF token/);
  });

  it('rejects an invalid CSRF token', async () => {
    const app = createApp();
    const cookie = await sessionCookie();

    await app.request('/api/csrf-token', {
      method: 'GET',
      headers: { Cookie: cookie },
    });

    const postRes = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': 'a'.repeat(64),
      },
      body: '{}',
    });
    expect(postRes.status).toBe(403);
    const body = (await postRes.json()) as { error: string };
    expect(body.error).toBe('CSRF token invalid');
  });

  it('exempts the CSP report endpoint from CSRF', async () => {
    const app = createApp();
    const res = await app.request('/api/security/csp-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': {} }),
    });
    expect(res.status).not.toBe(403);
  });

  it('exempts the health endpoint from CSRF', async () => {
    const app = createApp();
    const res = await app.request('/health', { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('consumes tokens after use (single-use)', async () => {
    const app = createApp();
    const cookie = await sessionCookie();

    const tokenRes = await app.request('/api/csrf-token', {
      method: 'GET',
      headers: { Cookie: cookie },
    });
    const { token } = (await tokenRes.json()) as { token: string };

    await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': token,
      },
      body: '{}',
    });

    const replayRes = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': token,
      },
      body: '{}',
    });
    expect(replayRes.status).toBe(403);
  });

  it('rejects GET to csrf-token without a session', async () => {
    const app = createApp();
    const res = await app.request('/api/csrf-token', { method: 'GET' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('No session');
  });

  it('rejects an expired CSRF token', async () => {
    const store = getTokenStore();
    await store.set('session-expired', {
      token: 'b'.repeat(64),
      expiresAt: Date.now() - 1000,
    });

    const app = createApp();
    const res = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=session-expired',
        'X-CSRF-Token': 'b'.repeat(64),
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('CSRF token expired');
  });

  it('rejects a token with different length via constant-time compare', async () => {
    const store = getTokenStore();
    await store.set('session-len', {
      token: 'c'.repeat(64),
      expiresAt: Date.now() + 60_000,
    });

    const app = createApp();
    const res = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=session-len',
        'X-CSRF-Token': 'short',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('supports setTokenStore to swap store implementation', async () => {
    const customStore: TokenStore = {
      async get() {
        return { token: 'x'.repeat(64), expiresAt: Date.now() + 60_000 };
      },
      async set() {},
      async delete() {},
      async clear() {},
    };
    setTokenStore(customStore);

    const app = createApp();
    const res = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=custom-session',
        'X-CSRF-Token': 'x'.repeat(64),
      },
      body: '{}',
    });
    expect(res.status).not.toBe(403);
  });

  it('handles PATCH and DELETE as state-changing methods', async () => {
    const app = createApp();

    const patchRes = await app.request('/api/csrf-token', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=test-methods',
      },
      body: '{}',
    });
    expect(patchRes.status).toBe(403);

    const deleteRes = await app.request('/api/csrf-token', {
      method: 'DELETE',
      headers: {
        Cookie: '__Host-session=test-methods',
      },
    });
    expect(deleteRes.status).toBe(403);
  });
});

// The PRODUCTION token store (wired at boot alongside the other Redis-backed
// identity stores) — a token minted on one instance must verify on every other.
describe('RedisTokenStore', () => {
  function fakeRedis() {
    const map = new Map<string, string>();
    return {
      map,
      async get(key: string): Promise<string | null> {
        return map.get(key) ?? null;
      },
      async set(key: string, value: string, _ex: 'EX', _ttl: number): Promise<'OK'> {
        map.set(key, value);
        return 'OK';
      },
      async del(...keys: string[]): Promise<number> {
        let removed = 0;
        for (const key of keys) if (map.delete(key)) removed += 1;
        return removed;
      },
      async keys(pattern: string): Promise<string[]> {
        const prefix = pattern.replace(/\*$/, '');
        return [...map.keys()].filter((key) => key.startsWith(prefix));
      },
    };
  }
  const asClient = (r: ReturnType<typeof fakeRedis>) => r as unknown as import('ioredis').default;

  it('round-trips a token under a HASHED csrf: key (never the raw session id)', async () => {
    const redis = fakeRedis();
    const store = new RedisTokenStore(asClient(redis));
    await store.set('sess-1', { token: 'a'.repeat(64), expiresAt: Date.now() + 60_000 });
    const keys = [...redis.map.keys()];
    expect(keys).toHaveLength(1);
    // The cookie value is a bearer session token — the keyspace must expose a
    // SHA-256 of it, never the raw value.
    expect(keys[0]).toMatch(/^csrf:[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain('sess-1');
    expect((await store.get('sess-1'))?.token).toBe('a'.repeat(64));
    await store.delete('sess-1');
    expect(await store.get('sess-1')).toBeUndefined();
  });

  it('never writes an already-expired token', async () => {
    const redis = fakeRedis();
    const store = new RedisTokenStore(asClient(redis));
    await store.set('sess-2', { token: 'b'.repeat(64), expiresAt: Date.now() - 1 });
    expect(redis.map.size).toBe(0);
  });

  it('treats a corrupted stored value as "no token" (fail closed), never a crash', async () => {
    const redis = fakeRedis();
    const store = new RedisTokenStore(asClient(redis));
    // Seed corruption under the REAL (hashed) key by writing then clobbering.
    await store.set('sess-3', { token: 'c'.repeat(64), expiresAt: Date.now() + 60_000 });
    const key = [...redis.map.keys()][0] as string;
    redis.map.set(key, 'not-json');
    expect(await store.get('sess-3')).toBeUndefined();
    redis.map.set(key, JSON.stringify({ token: 42, expiresAt: 'soon' }));
    expect(await store.get('sess-3')).toBeUndefined();
  });

  it('clear() removes only csrf-prefixed keys', async () => {
    const redis = fakeRedis();
    const store = new RedisTokenStore(asClient(redis));
    await store.set('sess-4', { token: 'c'.repeat(64), expiresAt: Date.now() + 60_000 });
    redis.map.set('other:key', 'untouched');
    await store.clear();
    expect(redis.map.has('csrf:sess-4')).toBe(false);
    expect(redis.map.get('other:key')).toBe('untouched');
  });
});

// The WS-D identity/privacy endpoints are exempt from the double-submit token
// (they rely on SameSite=Strict + the opaque session). SameSite=Strict still
// sends the session cookie on SAME-SITE requests, so a malicious sibling
// subdomain could otherwise form-POST to a token-exempt endpoint with the
// victim's cookie attached. The Origin/Referer allowlist closes that gap: it
// runs for EVERY state-changing request, including the token-exempt ones, and
// rejects any present-but-non-canonical Origin/Referer. These tests lock that
// defense in (regression guard for PR #26's same-site CSRF review).
describe('same-site CSRF: Origin/Referer allowlist on token-exempt WS-D endpoints', () => {
  const ORIGIN_REJECTION = { error: 'Forbidden' };
  let priorCorsOrigin: string | undefined;

  beforeEach(() => {
    priorCorsOrigin = process.env['CORS_ORIGIN'];
    process.env['CORS_ORIGIN'] = 'https://licio.app';
  });

  afterEach(async () => {
    if (priorCorsOrigin === undefined) delete process.env['CORS_ORIGIN'];
    else process.env['CORS_ORIGIN'] = priorCorsOrigin;
    await getTokenStore().clear();
  });

  it('rejects a token-exempt POST carrying a sibling-subdomain Origin', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.licio.app' },
      body: JSON.stringify({ email: 'a@example.com' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(ORIGIN_REJECTION);
  });

  it('rejects an authenticated WS-D action (export creation) from a sibling subdomain BEFORE auth', async () => {
    // The reviewer's example: a no-body authenticated POST. The Origin gate
    // runs ahead of the route's auth middleware, so the request is refused at
    // the CSRF layer (403 Forbidden), never reaching the handler.
    const app = createApp();
    const res = await app.request('/v1/privacy/export', {
      method: 'POST',
      headers: { Origin: 'https://evil.licio.app', Cookie: '__Host-sid=stolen-cookie' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(ORIGIN_REJECTION);
  });

  it('rejects a sibling-subdomain Referer when the Origin header is absent', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://evil.licio.app/page' },
      body: JSON.stringify({ email: 'a@example.com' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(ORIGIN_REJECTION);
  });

  it('rejects a malformed Referer on a state-changing request (fail closed)', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'not-a-valid-url' },
      body: JSON.stringify({ email: 'a@example.com' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(ORIGIN_REJECTION);
  });

  it('lets the canonical Origin through the gate to the handler', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://licio.app' },
      body: JSON.stringify({ email: 'a@example.com' }),
    });
    // Passed the Origin gate — the response is the handler's, NOT the gate's 403.
    expect(res.status).not.toBe(403);
    expect(await res.json()).not.toEqual(ORIGIN_REJECTION);
  });

  it('lets a canonical Origin reach auth on an authenticated endpoint (401, not an origin 403)', async () => {
    const app = createApp();
    const res = await app.request('/v1/privacy/export', {
      method: 'POST',
      headers: { Origin: 'https://licio.app' },
    });
    // The Origin gate passed; auth then rejects the unauthenticated request.
    expect(res.status).toBe(401);
    expect(await res.json()).not.toEqual(ORIGIN_REJECTION);
  });

  it('allows a header-less token-exempt request (non-browser client is not a CSRF vector)', async () => {
    // A browser ALWAYS sends Origin on a cross-origin POST, so the only way to
    // reach here with neither header is a non-browser client, which cannot be a
    // CSRF vector (it would already need the cookie). Allowing it avoids
    // breaking server-to-server callers without opening a CSRF hole.
    const app = createApp();
    const res = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com' }),
    });
    expect(res.status).not.toBe(403);
    expect(await res.json()).not.toEqual(ORIGIN_REJECTION);
  });
});
