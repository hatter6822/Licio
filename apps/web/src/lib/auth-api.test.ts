// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Auth flows (WS-D.1.2d): wire-shape validation, the UserContext mapping, the
// anti-enumeration registration outcome, code normalization, and the
// current-session revoke — against a mocked fetch (the same seam api.test.ts
// uses).  The WebAuthn ceremony module is mocked; its own tests cover it.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientState } from './api.js';
import {
  addEmail,
  confirmTotp,
  enrollTotp,
  fetchCredentials,
  fetchSecurityActivity,
  loginWithPasskey,
  registerWithEmail,
  removePasskey,
  renamePasskey,
  revokeCurrentSession,
  revokeOtherSessions,
  StepUpRequiredError,
  startEmailLogin,
  toUserContext,
  verifyEmail,
  verifyEmailLogin,
} from './auth-api.js';
import { resetSignupCaptcha } from './pow-captcha.js';

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

// A real, solvable sign-up proof-of-work challenge (secret number = 3): the
// register flows fetch + solve it against the mocked route table, exercising
// the full client path.  The signature is not client-verified (server-only).
let captchaChallenge: Record<string, unknown>;
beforeAll(async () => {
  const salt = 'a'.repeat(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}.3`));
  const target = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  captchaChallenge = {
    algorithm: 'SHA-256',
    challenge_id: 'b'.repeat(32),
    salt,
    target,
    max_number: 8,
    signature: 'c'.repeat(64),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  };
});

beforeEach(() => {
  resetApiClientState();
  resetSignupCaptcha();
  calls.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('toUserContext', () => {
  it('maps the echoed public user, defaulting a null locale (roles default empty — the strict login echo cannot carry them)', () => {
    expect(toUserContext(USER_PUBLIC as never)).toEqual({
      id: USER_PUBLIC.user_id,
      handle: 'ada',
      display_name: 'Ada',
      account_state: 'active',
      locale: 'en-US',
      roles: [],
      steward_roles: [],
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

  it('a successful login refreshes the context from /status — roles ride ONLY the status contract, so console nav unhides immediately after sign-in', async () => {
    mockRoutes({
      'POST /v1/auth/email/verify-login': () => jsonResponse(SESSION_RESULT),
      'GET /v1/auth/status': () =>
        jsonResponse({
          authenticated: true,
          user: {
            id: USER_PUBLIC.user_id,
            handle: 'ada',
            display_name: 'Ada',
            account_state: 'active',
            locale: 'en-US',
            roles: ['user', 'compliance'],
            steward_roles: ['ROLE_SAFETY'],
          },
        }),
    });
    const user = await verifyEmailLogin('AB12CD34');
    expect(user.roles).toEqual(['user', 'compliance']);
    expect(user.steward_roles).toEqual(['ROLE_SAFETY']);
  });

  it('an unauthenticated (or failing) status re-read falls back to the login echo — sign-in never regresses on a status hiccup', async () => {
    mockRoutes({
      'POST /v1/auth/email/verify-login': () => jsonResponse(SESSION_RESULT),
      'GET /v1/auth/status': () => jsonResponse({ authenticated: false }),
    });
    const user = await verifyEmailLogin('AB12CD34');
    expect(user.id).toBe(USER_PUBLIC.user_id);
    expect(user.roles).toEqual([]); // the strict echo cannot carry roles
  });

  it('a status answer for a DIFFERENT account is refused — the SW NetworkFirst cache can serve an OLDER session after a network failure (codex: only trust the refreshed status for the echoed user)', async () => {
    mockRoutes({
      'POST /v1/auth/email/verify-login': () => jsonResponse(SESSION_RESULT),
      'GET /v1/auth/status': () =>
        jsonResponse({
          authenticated: true,
          user: {
            id: '22222222-2222-4222-8222-222222222222',
            handle: 'stale_other',
            display_name: 'Stale Other',
            account_state: 'active',
            locale: 'en-US',
            roles: ['user', 'compliance'],
            steward_roles: ['ROLE_SAFETY'],
          },
        }),
    });
    const user = await verifyEmailLogin('AB12CD34');
    // The just-verified echo wins wholesale — no foreign identity, no
    // foreign roles adopted into the persisted context.
    expect(user.id).toBe(USER_PUBLIC.user_id);
    expect(user.handle).toBe('ada');
    expect(user.roles).toEqual([]);
    expect(user.steward_roles).toEqual([]);
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
    expect((verify?.body as { response: { type: string } | undefined })?.response?.type).toBe(
      'public-key',
    );
  });
});

describe('registerWithEmail (anti-enumeration outcome)', () => {
  it('solves the sign-up proof-of-work, attaches it, and returns the user when a session minted', async () => {
    mockRoutes({
      'POST /v1/auth/captcha/challenge': () => jsonResponse(captchaChallenge),
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
    const register = calls.find((c) => c.url.includes('/v1/auth/register'));
    // The REAL solve rode along: the brute-forced secret for the fixture is 3.
    const registerBody = register?.body as { captcha?: { number?: number } } | undefined;
    expect(registerBody?.captcha?.number).toBe(3);
  });

  it('returns null (neutral guidance) when no session appears', async () => {
    mockRoutes({
      'POST /v1/auth/captcha/challenge': () => jsonResponse(captchaChallenge),
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

  it('retries ONCE with a fresh solve when the server rejects the captcha', async () => {
    let registerAttempts = 0;
    mockRoutes({
      'POST /v1/auth/captcha/challenge': () => jsonResponse(captchaChallenge),
      'POST /v1/auth/register': () => {
        registerAttempts += 1;
        return registerAttempts === 1
          ? jsonResponse(
              { error: { code: 'captcha_invalid', message: 'Sign-up verification required.' } },
              403,
            )
          : jsonResponse({ age_band: 'adult' });
      },
      'GET /v1/auth/status': () => jsonResponse({ authenticated: false }),
    });
    const outcome = await registerWithEmail({
      handle: 'ada',
      display_name: 'Ada',
      date_of_birth: '1990-01-01',
      email: 'a@example.com',
    });
    expect(registerAttempts).toBe(2);
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

describe('security management flows (WS-D.1.2c/1.4a/1.5)', () => {
  const CRED_ID = 'AQIDBA';
  const CREDENTIALS = {
    passkeys: [
      {
        credential_id: CRED_ID,
        device_name: 'iPhone',
        device_type: 'platform',
        backed_up: true,
        created_at: '2026-06-10T00:00:00.000Z',
        last_used_at: null,
      },
    ],
    wallets: [],
    email: { present: true, verified: true },
    totp: { enabled: false, pending: false },
  };

  it('fetches the credential inventory including TOTP state', async () => {
    mockRoutes({ 'GET /v1/auth/credentials': () => jsonResponse(CREDENTIALS) });
    const creds = await fetchCredentials();
    expect(creds.passkeys[0]?.device_name).toBe('iPhone');
    expect(creds.totp).toEqual({ enabled: false, pending: false });
  });

  it('surfaces a step-up challenge on passkey removal as a typed error', async () => {
    mockRoutes({
      [`DELETE /v1/auth/credentials/webauthn/${CRED_ID}`]: () =>
        jsonResponse({ status: 'step_up_required', methods: ['webauthn', 'email_otp'] }, 401),
    });
    await expect(removePasskey(CRED_ID)).rejects.toBeInstanceOf(StepUpRequiredError);

    mockRoutes({
      [`DELETE /v1/auth/credentials/webauthn/${CRED_ID}`]: () => jsonResponse({ ok: true }),
    });
    await expect(removePasskey(CRED_ID)).resolves.toBeUndefined();
  });

  it('keeps the last-method refusal as a normal typed error (not step-up)', async () => {
    mockRoutes({
      [`DELETE /v1/auth/credentials/webauthn/${CRED_ID}`]: () =>
        jsonResponse(
          { error: { code: 'last_method', message: 'Set up another way to sign in first.' } },
          409,
        ),
    });
    await expect(removePasskey(CRED_ID)).rejects.toMatchObject({ code: 'last_method' });
  });

  it('renames a passkey', async () => {
    mockRoutes({
      [`PATCH /v1/auth/credentials/webauthn/${CRED_ID}`]: () => jsonResponse({ ok: true }),
    });
    await renamePasskey(CRED_ID, 'Work laptop');
    expect(calls[0]?.body).toEqual({ device_name: 'Work laptop' });
  });

  it('revokes other sessions and returns the count', async () => {
    mockRoutes({
      'POST /v1/auth/sessions/revoke-others': () => jsonResponse({ ok: true, revoked: 3 }),
    });
    await expect(revokeOtherSessions()).resolves.toBe(3);
  });

  it('drives the email-factor add → verify lifecycle', async () => {
    mockRoutes({
      'POST /v1/auth/email/add': () => jsonResponse({ status: 'sent' }),
      'POST /v1/auth/email/verify': () => jsonResponse({ status: 'verified' }),
    });
    await addEmail('new@example.com');
    expect(calls[0]?.body).toEqual({ email: 'new@example.com' });
    await verifyEmail('  abcd1234 ');
    expect(calls[1]?.body).toEqual({ code: 'ABCD1234' });
  });

  it('drives TOTP enrolment: enroll returns the URI, confirm returns 10 codes', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `RECOVERY${i}`);
    mockRoutes({
      'POST /v1/auth/mfa/totp/enroll': () =>
        jsonResponse({ otpauth_uri: 'otpauth://totp/Licio:ada?secret=ABC&issuer=Licio' }),
      'POST /v1/auth/mfa/totp/confirm': () => jsonResponse({ recovery_codes: codes }),
    });
    const uri = await enrollTotp();
    expect(uri).toContain('otpauth://');
    await expect(confirmTotp(' 123456 ')).resolves.toEqual(codes);
    expect(calls[1]?.body).toEqual({ code: '123456' });
  });

  it('fetches owner-scoped security activity', async () => {
    mockRoutes({
      'GET /v1/auth/security-activity': () =>
        jsonResponse({
          activity: [
            {
              event_id: '44444444-4444-4444-8444-444444444444',
              event_type: 'login_success',
              context: {
                device: 'iOS/Safari',
                auth_method: 'webauthn',
                setting: null,
                previous_value: null,
                new_value: null,
                reason: null,
              },
              created_at: '2026-06-10T00:00:00.000Z',
            },
          ],
        }),
    });
    const activity = await fetchSecurityActivity();
    expect(activity[0]?.event_type).toBe('login_success');
  });
});
