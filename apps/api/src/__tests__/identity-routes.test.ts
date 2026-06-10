// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { SoftwareAuthenticator } from '../identity/__tests__/software-authenticator.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  type IdentityServices,
  type RecordingMailer,
  setIdentityServices,
} from '../identity/services.js';
import { createRegistrationOptions, verifyRegistration } from '../identity/webauthn.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
};

let services: IdentityServices;

/** Typed JSON reader (Node undici types Response.json() as unknown). */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function jsonHeaders(cookie?: string): Record<string, string> {
  return { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
}
function extractCookie(res: Response, name: string): string | undefined {
  for (const sc of res.headers.getSetCookie()) {
    const value = sc.match(new RegExp(`^${name}=([^;]*)`))?.[1];
    if (value) return `${name}=${value}`;
  }
  return undefined;
}

function seedVerifiedUser(overrides: { email?: string; handle?: string } = {}) {
  const user = services.store.createUser({
    handle: overrides.handle ?? 'user1',
    displayName: 'User One',
    email: overrides.email ?? 'user@example.com',
    accountState: 'active',
    locale: null,
    ageBand: 'adult',
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    reputationSummary: emptyReputationSummary(),
    roles: ['user'],
  });
  services.store.setAuth(user.userId, {
    emailVerified: true,
    emailVerifiedAt: new Date().toISOString(),
  });
  return user;
}

/** Drive the email-OTP login and return the session cookie. */
async function loginViaEmail(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const start = await app.request('/v1/auth/email/start', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email }),
  });
  const attempt = extractCookie(start, '__Host-otp') as string;
  const code = (services.mailer as RecordingMailer).codes.at(-1)?.code as string;
  const verify = await app.request('/v1/auth/email/verify-login', {
    method: 'POST',
    headers: jsonHeaders(attempt),
    body: JSON.stringify({ code }),
  });
  expect(verify.status).toBe(200);
  return extractCookie(verify, '__Host-sid') as string;
}

beforeEach(() => {
  services = createInMemoryIdentityServices(CONFIG);
  setIdentityServices(services);
});
afterEach(() => {
  services.store.clear();
});

describe('POST /v1/auth/register (age gating)', () => {
  it('blocks under-13 and creates NO user', async () => {
    const app = createApp();
    const dob = `${new Date().getUTCFullYear() - 10}-01-01`;
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        handle: 'kiddo',
        display_name: 'Kid',
        email: 'kid@example.com',
        date_of_birth: dob,
      }),
    });
    expect(res.status).toBe(403);
    expect(services.store.getUserByHandle('kiddo')).toBeNull();
  });

  it('creates an adult account and emails a verification code', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        handle: 'adult1',
        display_name: 'Adult',
        email: 'adult@example.com',
        date_of_birth: '1990-01-01',
      }),
    });
    expect(res.status).toBe(200);
    expect((await readJson<{ age_band: string }>(res)).age_band).toBe('adult');
    expect(services.store.getUserByHandle('adult1')).not.toBeNull();
    expect((services.mailer as RecordingMailer).codes.some((c) => c.kind === 'verify')).toBe(true);
  });

  it('seeds teen accounts with the stricter privacy floor', async () => {
    const app = createApp();
    const dob = `${new Date().getUTCFullYear() - 14}-01-01`;
    await app.request('/v1/auth/register', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        handle: 'teen1',
        display_name: 'Teen',
        email: 'teen@example.com',
        date_of_birth: dob,
      }),
    });
    const user = services.store.getUserByHandle('teen1');
    expect(user?.ageBand).toBe('teen_13_15');
    expect(user?.privacySettings.attention_retention_preference).toBe('minimal');
  });

  it('returns a generic response on a duplicate email and notifies the owner (anti-enumeration)', async () => {
    seedVerifiedUser({ email: 'dup@example.com', handle: 'owner' });
    const app = createApp();
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        handle: 'attacker',
        display_name: 'X',
        email: 'dup@example.com',
        date_of_birth: '1990-01-01',
      }),
    });
    expect(res.status).toBe(200); // identical to the success shape
    expect(services.store.getUserByHandle('attacker')).toBeNull(); // no second account
    expect(
      (services.mailer as RecordingMailer).notices.some((n) => n.kind === 'duplicate_registration'),
    ).toBe(true);
  });
});

describe('email-OTP login', () => {
  it('returns 202 with a uniform body whether or not the email exists', async () => {
    const app = createApp();
    const unknown = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toEqual({ status: 'accepted' });
    // No code is minted for a non-account.
    expect((services.mailer as RecordingMailer).codes).toHaveLength(0);
  });

  it('logs a verified user in and sets the __Host-sid session cookie', async () => {
    seedVerifiedUser({ email: 'login@example.com', handle: 'loginuser' });
    const app = createApp();
    const start = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: 'login@example.com' }),
    });
    const attempt = extractCookie(start, '__Host-otp') as string;
    const code = (services.mailer as RecordingMailer).codes.at(-1)?.code as string;
    const verify = await app.request('/v1/auth/email/verify-login', {
      method: 'POST',
      headers: jsonHeaders(attempt),
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);
    const sidCookie = verify.headers.getSetCookie().find((c) => c.startsWith('__Host-sid='));
    expect(sidCookie).toContain('HttpOnly');
    expect(sidCookie).toContain('Secure');
    expect(sidCookie).toContain('SameSite=Strict');
  });

  it('rejects a correct code presented WITHOUT the matching attempt cookie (browser binding)', async () => {
    seedVerifiedUser({ email: 'bind@example.com', handle: 'binduser' });
    const app = createApp();
    await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: 'bind@example.com' }),
    });
    const code = (services.mailer as RecordingMailer).codes.at(-1)?.code as string;
    const verify = await app.request('/v1/auth/email/verify-login', {
      method: 'POST',
      headers: jsonHeaders(), // no attempt cookie
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(400);
  });
});

describe('GET /v1/auth/status', () => {
  it('is unauthenticated without a session and authenticated with one', async () => {
    seedVerifiedUser({ email: 's@example.com', handle: 'statususer' });
    const app = createApp();
    const anon = await app.request('/v1/auth/status');
    expect((await readJson<{ authenticated: boolean }>(anon)).authenticated).toBe(false);

    const sid = await loginViaEmail(app, 's@example.com');
    const authed = await app.request('/v1/auth/status', { headers: { cookie: sid } });
    const body = await readJson<{ authenticated: boolean; user: { handle: string } }>(authed);
    expect(body.authenticated).toBe(true);
    expect(body.user.handle).toBe('statususer');
  });
});

describe('active sessions', () => {
  it('lists, revokes by ref, and 404s a cross-user ref', async () => {
    seedVerifiedUser({ email: 'sess@example.com', handle: 'sessuser' });
    const app = createApp();
    const sid = await loginViaEmail(app, 'sess@example.com');

    const list = await app.request('/v1/auth/sessions', { headers: { cookie: sid } });
    const { sessions } = await readJson<{
      sessions: Array<{ current: boolean; session_ref: string }>;
    }>(list);
    expect(sessions).toHaveLength(1);
    const only = sessions[0];
    if (!only) throw new Error('expected one session');
    expect(only.current).toBe(true);

    // A made-up ref belonging to no session of this user → 404 (no oracle).
    const bad = await app.request('/v1/auth/sessions/deadbeefdead', {
      method: 'DELETE',
      headers: { cookie: sid },
    });
    expect(bad.status).toBe(404);

    const del = await app.request(`/v1/auth/sessions/${only.session_ref}`, {
      method: 'DELETE',
      headers: { cookie: sid },
    });
    expect(del.status).toBe(200);
    // The session is gone → subsequent requests are unauthenticated.
    const after = await app.request('/v1/auth/sessions', { headers: { cookie: sid } });
    expect(after.status).toBe(401);
  });

  it('rejects protected routes with no session (fail-closed)', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/sessions');
    expect(res.status).toBe(401);
  });

  it('denies a suspended account', async () => {
    const user = seedVerifiedUser({ email: 'susp@example.com', handle: 'suspuser' });
    const app = createApp();
    const sid = await loginViaEmail(app, 'susp@example.com');
    services.store.updateUser(user.userId, { accountState: 'suspended' });
    const res = await app.request('/v1/auth/sessions', { headers: { cookie: sid } });
    expect(res.status).toBe(403);
  });
});

describe('WebAuthn passkey login (real assertion)', () => {
  it('authenticates a registered passkey end-to-end', async () => {
    const user = seedVerifiedUser({ email: 'pk@example.com', handle: 'pkuser' });
    // Seed a credential by running the registration ceremony through the service.
    const authenticator = new SoftwareAuthenticator();
    const regOptions = await createRegistrationOptions(services.challenges, CONFIG.webauthn, {
      userId: user.userId,
      userName: 'pkuser',
      userDisplayName: 'PK',
      existingCredentials: [],
    });
    const reg = await verifyRegistration(services.challenges, CONFIG.webauthn, {
      userId: user.userId,
      response: authenticator.register(
        regOptions.challenge,
        CONFIG.webauthn.rpID,
        CONFIG.webauthn.origin,
      ),
    });
    if (!reg.ok) throw new Error('seed registration failed');
    services.store.addWebauthn({
      credentialId: reg.credential.credentialId,
      userId: user.userId,
      publicKey: reg.credential.publicKey,
      counter: reg.credential.counter,
      deviceType: reg.credential.deviceType,
      deviceName: 'Test Key',
      transports: reg.credential.transports,
      backedUp: reg.credential.backedUp,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });

    const app = createApp();
    const optRes = await app.request('/v1/auth/webauthn/authenticate/options', {
      method: 'POST',
      headers: jsonHeaders(),
    });
    const attempt = extractCookie(optRes, '__Host-otp') as string;
    const options = await readJson<{ challenge: string }>(optRes);
    const assertion = authenticator.authenticate(
      options.challenge,
      CONFIG.webauthn.rpID,
      CONFIG.webauthn.origin,
      7,
    );
    const verify = await app.request('/v1/auth/webauthn/authenticate/verify', {
      method: 'POST',
      headers: jsonHeaders(attempt),
      body: JSON.stringify({ response: assertion }),
    });
    expect(verify.status).toBe(200);
    expect((await readJson<{ status: string }>(verify)).status).toBe('authenticated');
  });
});

describe('Sign-In with Ethereum (adult-only signup)', () => {
  const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const account = privateKeyToAccount(key);

  async function walletAttempt(app: ReturnType<typeof createApp>, dob: string | undefined) {
    const nonceRes = await app.request('/v1/auth/wallet/nonce', {
      method: 'POST',
      headers: jsonHeaders(),
    });
    const attempt = extractCookie(nonceRes, '__Host-otp') as string;
    const { nonce } = await readJson<{ nonce: string }>(nonceRes);
    const message = createSiweMessage({
      address: account.address,
      domain: CONFIG.siwe.domain,
      uri: CONFIG.siwe.uri,
      version: '1',
      chainId: 1,
      nonce,
      issuedAt: new Date(),
    });
    const signature = await account.signMessage({ message });
    return app.request('/v1/auth/wallet/verify', {
      method: 'POST',
      headers: jsonHeaders(attempt),
      body: JSON.stringify({
        message,
        signature,
        handle: 'walletuser',
        display_name: 'Wallet',
        ...(dob ? { date_of_birth: dob } : {}),
      }),
    });
  }

  it('creates an adult account on first wallet sign-in', async () => {
    const app = createApp();
    const res = await walletAttempt(app, '1990-01-01');
    expect(res.status).toBe(200);
    expect((await readJson<{ status: string }>(res)).status).toBe('authenticated');
    expect(services.store.getUserByHandle('walletuser')).not.toBeNull();
  });

  it('refuses a minor wallet signup (adult-only)', async () => {
    const app = createApp();
    const dob = `${new Date().getUTCFullYear() - 15}-01-01`;
    const res = await walletAttempt(app, dob);
    expect(res.status).toBe(403);
    expect(services.store.getUserByHandle('walletuser')).toBeNull();
  });

  it('resolves an EXISTING auth-wallet on a second sign-in (no signup details needed)', async () => {
    const app = createApp();
    expect((await walletAttempt(app, '1990-01-01')).status).toBe(200);
    const userId = services.store.getUserByHandle('walletuser')?.userId;

    // A second nonce+verify with the same wallet and NO profile fields resolves
    // the existing credential rather than creating a duplicate account.
    const nonceRes = await app.request('/v1/auth/wallet/nonce', {
      method: 'POST',
      headers: jsonHeaders(),
    });
    const attempt = extractCookie(nonceRes, '__Host-otp') as string;
    const { nonce } = await readJson<{ nonce: string }>(nonceRes);
    const message = createSiweMessage({
      address: account.address,
      domain: CONFIG.siwe.domain,
      uri: CONFIG.siwe.uri,
      version: '1',
      chainId: 1,
      nonce,
      issuedAt: new Date(),
    });
    const signature = await account.signMessage({ message });
    const res = await app.request('/v1/auth/wallet/verify', {
      method: 'POST',
      headers: jsonHeaders(attempt),
      body: JSON.stringify({ message, signature }),
    });
    expect(res.status).toBe(200);
    // Same account — no second user created.
    expect(services.store.getUserByHandle('walletuser')?.userId).toBe(userId);
    expect(services.store.listWalletAuth(userId as string)).toHaveLength(1);
  });
});

describe('cloned-authenticator detection (counter regression)', () => {
  it('rejects a regressed counter and records a cloned-authenticator alert', async () => {
    const user = seedVerifiedUser({ email: 'clone@example.com', handle: 'cloneuser' });
    const authenticator = new SoftwareAuthenticator();
    const regOptions = await createRegistrationOptions(services.challenges, CONFIG.webauthn, {
      userId: user.userId,
      userName: 'cloneuser',
      userDisplayName: 'Clone',
      existingCredentials: [],
    });
    const reg = await verifyRegistration(services.challenges, CONFIG.webauthn, {
      userId: user.userId,
      response: authenticator.register(
        regOptions.challenge,
        CONFIG.webauthn.rpID,
        CONFIG.webauthn.origin,
      ),
    });
    if (!reg.ok) throw new Error('seed failed');
    services.store.addWebauthn({
      credentialId: reg.credential.credentialId,
      userId: user.userId,
      publicKey: reg.credential.publicKey,
      counter: reg.credential.counter,
      deviceType: reg.credential.deviceType,
      deviceName: null,
      transports: reg.credential.transports,
      backedUp: reg.credential.backedUp,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });

    const app = createApp();
    // First authentication advances the stored counter to 9.
    const opt1 = await app.request('/v1/auth/webauthn/authenticate/options', {
      method: 'POST',
      headers: jsonHeaders(),
    });
    const attempt1 = extractCookie(opt1, '__Host-otp') as string;
    const o1 = await readJson<{ challenge: string }>(opt1);
    await app.request('/v1/auth/webauthn/authenticate/verify', {
      method: 'POST',
      headers: jsonHeaders(attempt1),
      body: JSON.stringify({
        response: authenticator.authenticate(
          o1.challenge,
          CONFIG.webauthn.rpID,
          CONFIG.webauthn.origin,
          9,
        ),
      }),
    });

    // A "clone" presents the SAME counter (9) — a regression.
    const opt2 = await app.request('/v1/auth/webauthn/authenticate/options', {
      method: 'POST',
      headers: jsonHeaders(),
    });
    const attempt2 = extractCookie(opt2, '__Host-otp') as string;
    const o2 = await readJson<{ challenge: string }>(opt2);
    const cloned = await app.request('/v1/auth/webauthn/authenticate/verify', {
      method: 'POST',
      headers: jsonHeaders(attempt2),
      body: JSON.stringify({
        response: authenticator.authenticate(
          o2.challenge,
          CONFIG.webauthn.rpID,
          CONFIG.webauthn.origin,
          9,
        ),
      }),
    });
    expect(cloned.status).toBe(400);
    const activity = await services.audit.securityActivityForUser(user.userId);
    expect(activity.some((e) => e.event_type === 'suspicious_login')).toBe(true);
  });
});

describe('no password-reset route exists', () => {
  it('returns 404 for a forgot/reset-password path', async () => {
    const app = createApp();
    for (const path of [
      '/v1/auth/forgot-password',
      '/v1/auth/reset-password',
      '/v1/auth/password',
    ]) {
      const res = await app.request(path, { method: 'POST', headers: jsonHeaders(), body: '{}' });
      expect(res.status).toBe(404);
    }
  });
});
