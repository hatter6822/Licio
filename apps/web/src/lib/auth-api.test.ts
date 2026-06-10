// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Auth flows (WS-D.1.2d): wire-shape validation, the UserContext mapping, the
// anti-enumeration registration outcome, code normalization, and the
// current-session revoke — against a mocked fetch (the same seam api.test.ts
// uses).  The WebAuthn ceremony module is mocked; its own tests cover it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientState } from './api.js';
import {
  loginWithPasskey,
  registerWithEmail,
  revokeCurrentSession,
  startEmailLogin,
  toUserContext,
  verifyEmailLogin,
} from './auth-api.js';

vi.mock('./webauthn.js', () => ({
  createPasskey: vi.fn(),
  getPasskeyAssertion: vi.fn(async () => ({
    id: 'AQI',
    rawId: 'AQI',
    type: 'public-key',
    response: { clientDataJSON: 'Yw', authenticatorData: 'YQ', signature: 'cw' },
    clientExtensionResults: {},
  })),
}));

const realFetch = globalThis.fetch;

const USER_PUBLIC = {
  user_id: '11111111-1111-4111-8111-111111111111',
  handle: 'ada',
  display_name: 'Ada',
  locale: null,
  account_state: 'active',
  created_at: '2026-06-10T00:00:00.000Z',
};

const SESSION_RESULT = { status: 'authenticated', user: USER_PUBLIC };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];

/** Route-table fetch mock; records every non-CSRF call. */
function mockRoutes(routes: Record<string, (body: unknown) => Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/csrf-token')) return jsonResponse({ token: 'csrf-token' });
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${new URL(url, 'http://localhost').pathname}`;
    const handler = routes[key];
    if (!handler) return jsonResponse({ error: { code: 'not_found', message: 'no route' } }, 404);
    return handler(body);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetApiClientState();
  calls.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('toUserContext', () => {
  it('maps the echoed public user, defaulting a null locale', () => {
    expect(toUserContext(USER_PUBLIC as never)).toEqual({
      id: USER_PUBLIC.user_id,
      handle: 'ada',
      display_name: 'Ada',
      account_state: 'active',
      locale: 'en-US',
    });
  });
});

describe('email code login', () => {
  it('startEmailLogin posts the address and accepts the generic ack', async () => {
    mockRoutes({ 'POST /v1/auth/email/start': () => jsonResponse({ status: 'accepted' }) });
    await startEmailLogin('a@example.com');
    expect(calls[0]?.body).toEqual({ email: 'a@example.com' });
  });

  it('verifyEmailLogin normalizes the code and returns the user context', async () => {
    mockRoutes({ 'POST /v1/auth/email/verify-login': () => jsonResponse(SESSION_RESULT) });
    const user = await verifyEmailLogin('  ab12cd34 ');
    expect(calls[0]?.body).toEqual({ code: 'AB12CD34' });
    expect(user.id).toBe(USER_PUBLIC.user_id);
  });

  it('surfaces a typed error for an invalid code', async () => {
    mockRoutes({
      'POST /v1/auth/email/verify-login': () =>
        jsonResponse({ error: { code: 'invalid_code', message: 'Invalid or expired code.' } }, 400),
    });
    await expect(verifyEmailLogin('AAAAAAAA')).rejects.toMatchObject({ code: 'invalid_code' });
  });
});

describe('passkey login', () => {
  it('drives options → assertion → verify and returns the context', async () => {
    mockRoutes({
      'POST /v1/auth/webauthn/authenticate/options': () =>
        jsonResponse({ challenge: 'Y2hhbGxlbmdl', rpId: 'localhost' }),
      'POST /v1/auth/webauthn/authenticate/verify': () => jsonResponse(SESSION_RESULT),
    });
    const user = await loginWithPasskey();
    expect(user.handle).toBe('ada');
    const verify = calls.find((c) => c.url.includes('/verify'));
    expect((verify?.body as { response: { type: string } }).response.type).toBe('public-key');
  });
});

describe('registerWithEmail (anti-enumeration outcome)', () => {
  it('returns the user when the registration minted a session', async () => {
    mockRoutes({
      'POST /v1/auth/register': () => jsonResponse({ age_band: 'adult' }),
      'GET /v1/auth/status': () =>
        jsonResponse({
          authenticated: true,
          user: {
            id: USER_PUBLIC.user_id,
            handle: 'ada',
            display_name: 'Ada',
            account_state: 'active',
            locale: 'en-US',
          },
        }),
    });
    const outcome = await registerWithEmail({
      handle: 'ada',
      display_name: 'Ada',
      date_of_birth: '1990-01-01',
      email: 'a@example.com',
    });
    expect(outcome.user?.handle).toBe('ada');
  });

  it('returns null (neutral guidance) when no session appears', async () => {
    mockRoutes({
      'POST /v1/auth/register': () => jsonResponse({ age_band: 'adult' }),
      'GET /v1/auth/status': () => jsonResponse({ authenticated: false }),
    });
    const outcome = await registerWithEmail({
      handle: 'ada',
      display_name: 'Ada',
      date_of_birth: '1990-01-01',
      email: 'taken@example.com',
    });
    expect(outcome.user).toBeNull();
  });
});

describe('revokeCurrentSession', () => {
  const summary = (ref: string, current: boolean) => ({
    session_ref: ref,
    device_label: 'iOS/Safari',
    auth_method: 'webauthn',
    created_at: '2026-06-10T00:00:00.000Z',
    last_active_at: '2026-06-10T00:00:00.000Z',
    current,
  });

  it('revokes exactly the current session', async () => {
    mockRoutes({
      'GET /v1/auth/sessions': () =>
        jsonResponse({ sessions: [summary('other', false), summary('me', true)] }),
      'DELETE /v1/auth/sessions/me': () => jsonResponse({ ok: true }),
    });
    await revokeCurrentSession();
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toContain('/v1/auth/sessions/me');
  });

  it('is a no-op when no current session is listed', async () => {
    mockRoutes({ 'GET /v1/auth/sessions': () => jsonResponse({ sessions: [] }) });
    await revokeCurrentSession();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});
