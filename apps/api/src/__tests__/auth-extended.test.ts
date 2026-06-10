// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { SoftwareAuthenticator } from '../identity/__tests__/software-authenticator.js';
import { sha256Hex } from '../identity/crypto.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  type IdentityServices,
  type RecordingMailer,
  setIdentityServices,
} from '../identity/services.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
};
const RP = CONFIG.webauthn.rpID;
const ORIGIN = CONFIG.webauthn.origin;

let services: IdentityServices;

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
const headers = (cookie?: string): Record<string, string> => ({
  'content-type': 'application/json',
  ...(cookie ? { cookie } : {}),
});
function cookie(res: Response, name: string): string {
  for (const sc of res.headers.getSetCookie()) {
    const v = sc.match(new RegExp(`^${name}=([^;]*)`))?.[1];
    if (v) return `${name}=${v}`;
  }
  return '';
}

/** Sign up a passkey-first account; returns { app, authenticator, sid }. */
async function passkeySignup(handle: string, dob = '1990-01-01') {
  const app = createApp();
  const authenticator = new SoftwareAuthenticator();
  const opt = await app.request('/v1/auth/webauthn/signup/options', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ handle, display_name: handle, date_of_birth: dob }),
  });
  const attempt = cookie(opt, '__Host-pksignup');
  const options = await readJson<{ challenge: string }>(opt);
  const verify = await app.request('/v1/auth/webauthn/signup/verify', {
    method: 'POST',
    headers: headers(attempt),
    body: JSON.stringify({ response: authenticator.register(options.challenge, RP, ORIGIN) }),
  });
  return { app, authenticator, verify, sid: cookie(verify, '__Host-sid') };
}

/** Force the current session's step-up assurance to be stale. */
async function ageAssurance(sid: string, ms: number) {
  const token = sid.split('=')[1] as string;
  const stored = await services.sessions.get(sha256Hex(token));
  if (!stored) throw new Error('no session');
  await services.sessions.put(sha256Hex(token), {
    ...stored,
    record: {
      ...stored.record,
      auth_assurance: { level: 'full', last_verified_at: new Date(Date.now() - ms).toISOString() },
    },
  });
}

beforeEach(() => {
  services = createInMemoryIdentityServices(CONFIG);
  setIdentityServices(services);
});
afterEach(() => services.store.clear());

describe('passkey-first signup', () => {
  it('creates a passkey-only account with NO email and logs in', async () => {
    const { verify, sid } = await passkeySignup('passkeyuser');
    expect(verify.status).toBe(200);
    expect((await readJson<{ status: string }>(verify)).status).toBe('authenticated');
    const user = services.store.getUserByHandle('passkeyuser');
    expect(user?.email).toBeNull();
    expect(services.store.listWebauthn(user?.userId as string)).toHaveLength(1);
    expect(sid.startsWith('__Host-sid=')).toBe(true);
  });

  it('blocks an under-13 passkey signup before issuing options', async () => {
    const app = createApp();
    const dob = `${new Date().getUTCFullYear() - 9}-01-01`;
    const res = await app.request('/v1/auth/webauthn/signup/options', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ handle: 'kid', display_name: 'Kid', date_of_birth: dob }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a duplicate handle', async () => {
    await passkeySignup('taken');
    const app = createApp();
    const res = await app.request('/v1/auth/webauthn/signup/options', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ handle: 'taken', display_name: 'Dup', date_of_birth: '1990-01-01' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('email factor verify/resend gating', () => {
  async function registerEmail(app: ReturnType<typeof createApp>, email: string, handle: string) {
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ handle, display_name: handle, email, date_of_birth: '1990-01-01' }),
    });
    return cookie(res, '__Host-sid');
  }

  it('registers (reduced capability) then verify unlocks the privacy controls', async () => {
    const app = createApp();
    const sid = await registerEmail(app, 'reg@example.com', 'reguser');
    // Reduced capability: privacy settings are blocked until the email is verified.
    expect((await app.request('/v1/privacy/settings', { headers: { cookie: sid } })).status).toBe(
      403,
    );

    const code = (services.mailer as RecordingMailer).codes.at(-1)?.code as string;
    const verify = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);
    // The session rotated; use the new cookie.
    const sid2 = cookie(verify, '__Host-sid') || sid;
    expect((await app.request('/v1/privacy/settings', { headers: { cookie: sid2 } })).status).toBe(
      200,
    );
  });

  it('enforces the 60-second resend cooldown', async () => {
    const app = createApp();
    const sid = await registerEmail(app, 'res@example.com', 'resuser');
    expect(
      (await app.request('/v1/auth/email/resend', { method: 'POST', headers: headers(sid) }))
        .status,
    ).toBe(200);
    expect(
      (await app.request('/v1/auth/email/resend', { method: 'POST', headers: headers(sid) }))
        .status,
    ).toBe(429);
  });
});

describe('credential management + last-method guard', () => {
  it('lists, adds, renames, and removes passkeys with the last-method guard', async () => {
    const { app, sid } = await passkeySignup('creduser');
    const userId = services.store.getUserByHandle('creduser')?.userId as string;

    const list1 = await readJson<{ passkeys: unknown[] }>(
      await app.request('/v1/auth/credentials', { headers: { cookie: sid } }),
    );
    expect(list1.passkeys).toHaveLength(1);

    // Adding/removing a credential ROTATES the session (privilege change), so the
    // cookie must be re-read after each such call.
    let session = sid;

    // Add a second passkey (step-up satisfied by the fresh session).
    const second = new SoftwareAuthenticator();
    const opt = await app.request('/v1/auth/webauthn/register/options', {
      method: 'POST',
      headers: headers(session),
    });
    const options = await readJson<{ challenge: string }>(opt);
    const add = await app.request('/v1/auth/webauthn/register/verify', {
      method: 'POST',
      headers: headers(session),
      body: JSON.stringify({
        response: second.register(options.challenge, RP, ORIGIN),
        device_name: 'Second Key',
      }),
    });
    expect(add.status).toBe(200);
    session = cookie(add, '__Host-sid') || session; // session rotated
    expect(services.store.listWebauthn(userId)).toHaveLength(2);

    // Rename a passkey (no rotation).
    const first = services.store.listWebauthn(userId)[0];
    const rename = await app.request(`/v1/auth/credentials/webauthn/${first?.credentialId}`, {
      method: 'PATCH',
      headers: headers(session),
      body: JSON.stringify({ device_name: 'Renamed' }),
    });
    expect(rename.status).toBe(200);

    // Remove one passkey (2 → 1) succeeds and rotates again.
    const del = await app.request(`/v1/auth/credentials/webauthn/${first?.credentialId}`, {
      method: 'DELETE',
      headers: headers(session),
    });
    expect(del.status).toBe(200);
    session = cookie(del, '__Host-sid') || session;
    expect(services.store.listWebauthn(userId)).toHaveLength(1);

    // Removing the LAST credential is refused (last-method guard).
    const last = services.store.listWebauthn(userId)[0];
    const delLast = await app.request(`/v1/auth/credentials/webauthn/${last?.credentialId}`, {
      method: 'DELETE',
      headers: headers(session),
    });
    expect(delLast.status).toBe(409);
    expect(services.store.listWebauthn(userId)).toHaveLength(1);
  });

  it('404s a cross-user credential reference (no oracle)', async () => {
    const { app, sid } = await passkeySignup('owneruser');
    const res = await app.request('/v1/auth/credentials/webauthn/someoneelsescred', {
      method: 'DELETE',
      headers: headers(sid),
    });
    expect(res.status).toBe(404);
  });
});

describe('step-up satisfaction', () => {
  it('a stale session is challenged, then a WebAuthn step-up lets the action proceed', async () => {
    const { app, authenticator, sid } = await passkeySignup('stepupuser');
    // Make the session assurance stale so a step-up-protected action is challenged.
    await ageAssurance(sid, 10 * 60_000);
    const blocked = await app.request('/v1/privacy/export', {
      method: 'POST',
      headers: headers(sid),
    });
    expect(blocked.status).toBe(401);
    expect((await readJson<{ status: string }>(blocked)).status).toBe('step_up_required');

    // Satisfy the step-up with a fresh passkey assertion.
    const opt = await app.request('/v1/auth/step-up/webauthn/options', {
      method: 'POST',
      headers: headers(sid),
    });
    const suCookie = cookie(opt, '__Host-su');
    const options = await readJson<{ challenge: string }>(opt);
    const su = await app.request('/v1/auth/step-up/webauthn/verify', {
      method: 'POST',
      headers: headers(`${sid}; ${suCookie}`),
      body: JSON.stringify({
        response: authenticator.authenticate(options.challenge, RP, ORIGIN, 11),
      }),
    });
    expect(su.status).toBe(200);

    // The in-progress action now succeeds.
    const ok = await app.request('/v1/privacy/export', { method: 'POST', headers: headers(sid) });
    expect(ok.status).toBe(202);
  });
});

describe('account-state login gate (fail closed at the session mint)', () => {
  it('denies a SUSPENDED account a session even with a valid passkey', async () => {
    const { app, authenticator } = await passkeySignup('suspendme');
    const user = services.store.getUserByHandle('suspendme');
    services.store.updateUser(user?.userId as string, { accountState: 'suspended' });
    const sessionsBefore = (await services.sessions.listForUser(user?.userId as string)).length;

    const opt = await app.request('/v1/auth/webauthn/authenticate/options', {
      method: 'POST',
      headers: headers(),
    });
    const attempt = cookie(opt, '__Host-wa');
    const options = await readJson<{ challenge: string }>(opt);
    const verify = await app.request('/v1/auth/webauthn/authenticate/verify', {
      method: 'POST',
      headers: headers(attempt),
      body: JSON.stringify({
        response: authenticator.authenticate(options.challenge, RP, ORIGIN, 5),
      }),
    });
    expect(verify.status).toBe(403);
    expect((await readJson<{ error: { code: string } }>(verify)).error.code).toBe(
      'account_suspended',
    );
    // No session cookie was minted and no NEW session row exists (the prior
    // signup session is untouched — suspension enforcement on existing sessions
    // is the middleware's job, which 403s non-active accounts on every request).
    expect(cookie(verify, '__Host-sid')).toBe('');
    expect(await services.sessions.listForUser(user?.userId as string)).toHaveLength(
      sessionsBefore,
    );
  });

  it('denies a suspended account the email path too (post-credential proof)', async () => {
    const app = createApp();
    const user = services.store.createUser({
      handle: 'susmail',
      displayName: 'S',
      email: 'sus@example.com',
      accountState: 'suspended',
      locale: null,
      ageBand: 'adult',
      privacySettings: (await import('@licio/shared')).defaultPrivacySettings(),
      personalizationSettings: (await import('@licio/shared')).defaultPersonalizationSettings(),
      reputationSummary: (await import('@licio/shared')).emptyReputationSummary(),
      roles: ['user'],
    });
    services.store.setAuth(user.userId, { emailVerified: true });
    const start = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email: 'sus@example.com' }),
    });
    const attempt = cookie(start, '__Host-otp');
    const code = (services.mailer as RecordingMailer).codes.at(-1)?.code as string;
    const verify = await app.request('/v1/auth/email/verify-login', {
      method: 'POST',
      headers: headers(attempt),
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(403);
    expect((await readJson<{ error: { code: string } }>(verify)).error.code).toBe(
      'account_suspended',
    );
  });
});

describe('email issuance cooldown (anti-mail-bombing, §19.1-aligned)', () => {
  it('sends at most ONE login code per mailbox per window, with identical 202s', async () => {
    const app = createApp();
    const user = services.store.createUser({
      handle: 'bombme',
      displayName: 'B',
      email: 'bomb@example.com',
      accountState: 'active',
      locale: null,
      ageBand: 'adult',
      privacySettings: (await import('@licio/shared')).defaultPrivacySettings(),
      personalizationSettings: (await import('@licio/shared')).defaultPersonalizationSettings(),
      reputationSummary: (await import('@licio/shared')).emptyReputationSummary(),
      roles: ['user'],
    });
    services.store.setAuth(user.userId, { emailVerified: true });

    const mailer = services.mailer as RecordingMailer;
    const responses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/auth/email/start', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ email: 'bomb@example.com' }),
      });
      responses.push(res.status);
    }
    // Five identical 202s (no observable difference)…
    expect(responses).toEqual([202, 202, 202, 202, 202]);
    // …but exactly ONE email left the building.
    expect(mailer.codes.filter((c2) => c2.to === 'bomb@example.com')).toHaveLength(1);
  });

  it('coalesces duplicate-registration notices under the same cooldown', async () => {
    const app = createApp();
    services.store.createUser({
      handle: 'dupowner',
      displayName: 'D',
      email: 'dup@example.com',
      accountState: 'active',
      locale: null,
      ageBand: 'adult',
      privacySettings: (await import('@licio/shared')).defaultPrivacySettings(),
      personalizationSettings: (await import('@licio/shared')).defaultPersonalizationSettings(),
      reputationSummary: (await import('@licio/shared')).emptyReputationSummary(),
      roles: ['user'],
    });
    const mailer = services.mailer as RecordingMailer;
    for (let i = 0; i < 4; i += 1) {
      const res = await app.request('/v1/auth/register', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          handle: `duptry${i}`,
          display_name: 'Dup',
          email: 'dup@example.com',
          date_of_birth: '1990-01-01',
        }),
      });
      expect(res.status).toBe(200); // generic success — no enumeration
    }
    expect(
      mailer.notices.filter(
        (n) => n.to === 'dup@example.com' && n.kind === 'duplicate_registration',
      ),
    ).toHaveLength(1);
  });
});
