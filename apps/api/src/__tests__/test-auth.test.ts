// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The test-only auth route (BFF E2E harness, WS-P). It mints a real session
// cookie for an existing ACTIVE user and refuses anything else. This route is
// mounted only by the in-memory e2e-server, never the production app — these
// tests pin that boundary (no session for an unknown/absent user).
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { buildIdentityServicesFromEnv } from '../identity/services.js';
import { SESSION_COOKIE, validateSession } from '../identity/sessions.js';
import { createTestAuthRoute } from '../routes/test-auth.js';

const ENV = { SESSION_SECRET: 'x'.repeat(40), CORS_ORIGIN: 'http://localhost:4173' };
const USER_ID = '5f5e0000-0000-4000-8000-000000000001';

function identityWith(user?: { state: 'active' | 'suspended' }) {
  const identity = buildIdentityServicesFromEnv(ENV);
  if (user) {
    void identity.store.createUser({
      userId: USER_ID,
      handle: 'demo',
      displayName: 'Demo',
      email: null,
      accountState: user.state,
      locale: 'en',
      ageBand: 'adult',
      privacySettings: defaultPrivacySettings(),
      personalizationSettings: defaultPersonalizationSettings(),
      roles: ['user'],
    });
  }
  return identity;
}

async function login(
  app: ReturnType<typeof createTestAuthRoute>,
  body: unknown,
): Promise<Response> {
  return app.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('test-auth route (WS-P E2E harness)', () => {
  it('mints a valid session cookie for the seeded active user', async () => {
    const identity = identityWith({ state: 'active' });
    const res = await login(createTestAuthRoute(identity), {});
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    const token = setCookie.match(/__Host-sid=([^;]+)/)?.[1];
    expect(token).toBeDefined();
    // The minted token is a REAL session the production validator accepts.
    const validated = await validateSession(identity.sessions, token as string);
    expect(validated?.record.user_id).toBe(USER_ID);
  });

  it('refuses (404, no cookie) when the user does not exist', async () => {
    const res = await login(createTestAuthRoute(identityWith()), { userId: USER_ID });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a non-active account', async () => {
    const res = await login(createTestAuthRoute(identityWith({ state: 'suspended' })), {});
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('an OPERATOR account arrives fully MFA-cleared — the identity record AND the session flag (codex: mfaActive derives from mfaEnabled)', async () => {
    const identity = identityWith({ state: 'active' });
    await identity.store.updateUser(USER_ID, { roles: ['user', 'admin'] });
    const res = await login(createTestAuthRoute(identity), {});
    expect(res.status).toBe(200);
    const token = (res.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? '';
    const validated = await validateSession(identity.sessions, token);
    expect(validated?.record.mfa_verified).toBe(true);
    // BOTH halves: require* checks `mfaActive && mfaVerified`, and
    // authMiddleware derives mfaActive from the identity record.
    expect((await identity.store.getAuth(USER_ID))?.mfaEnabled).toBe(true);
  });

  it('a plain user gets NO phantom MFA enrollment', async () => {
    const identity = identityWith({ state: 'active' });
    const res = await login(createTestAuthRoute(identity), {});
    expect(res.status).toBe(200);
    const token = (res.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? '';
    const validated = await validateSession(identity.sessions, token);
    expect(validated?.record.mfa_verified).toBe(false);
    expect((await identity.store.getAuth(USER_ID))?.mfaEnabled ?? false).toBe(false);
  });
});
