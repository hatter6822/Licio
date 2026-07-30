// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { SoftwareAuthenticator } from '../identity/__tests__/software-authenticator.js';
import { sha256Hex } from '../identity/crypto.js';
import {
  AUTH_RATE_LIMITS,
  AuthRateLimiter,
  InMemoryAuthRateLimitStore,
} from '../identity/rate-limit-auth.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  type IdentityServices,
  RecordingMailer,
  setIdentityServices,
} from '../identity/services.js';
import { createSession } from '../identity/sessions.js';
import { accountRefForUser } from '../routes/auth-support.js';
import { signupCaptcha } from './pow-test-helpers.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
  signupPow: { maxNumber: 16 },
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
    body: JSON.stringify({
      handle,
      display_name: handle,
      date_of_birth: dob,
      captcha: await signupCaptcha(app),
    }),
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

beforeEach(async () => {
  services = createInMemoryIdentityServices(CONFIG);
  setIdentityServices(services);
});
afterEach(() => services.store.clear());

describe('passkey-first signup', () => {
  it('creates a passkey-only account with NO email and logs in', async () => {
    const { verify, sid } = await passkeySignup('passkeyuser');
    expect(verify.status).toBe(200);
    expect((await readJson<{ status: string }>(verify)).status).toBe('authenticated');
    const user = await services.store.getUserByHandle('passkeyuser');
    expect(user?.email).toBeNull();
    expect(await services.store.listWebauthn(user?.userId as string)).toHaveLength(1);
    expect(sid.startsWith('__Host-sid=')).toBe(true);
  });

  it('blocks an under-13 passkey signup before issuing options', async () => {
    const app = createApp();
    const dob = `${new Date().getUTCFullYear() - 9}-01-01`;
    const res = await app.request('/v1/auth/webauthn/signup/options', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        handle: 'kid',
        display_name: 'Kid',
        date_of_birth: dob,
        captcha: await signupCaptcha(app),
      }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a duplicate handle', async () => {
    await passkeySignup('taken');
    const app = createApp();
    const res = await app.request('/v1/auth/webauthn/signup/options', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        handle: 'taken',
        display_name: 'Dup',
        date_of_birth: '1990-01-01',
        captcha: await signupCaptcha(app),
      }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects a corrupted pending-signup record instead of casting it through', async () => {
    const app = createApp();
    const authenticator = new SoftwareAuthenticator();
    const opt = await app.request('/v1/auth/webauthn/signup/options', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        handle: 'forged',
        display_name: 'Forged',
        date_of_birth: '1990-01-01',
        captcha: await signupCaptcha(app),
      }),
    });
    const attempt = cookie(opt, '__Host-pksignup');
    const options = await readJson<{ challenge: string }>(opt);
    // Overwrite the ephemeral pending record with a malformed payload (a forged /
    // corrupted store entry): the verify path must reject on validation, not cast.
    const attemptId = attempt.split('=')[1] as string;
    await services.challenges.set(`pksignup:${attemptId}`, '{ not json', 60_000);
    const verify = await app.request('/v1/auth/webauthn/signup/verify', {
      method: 'POST',
      headers: headers(attempt),
      body: JSON.stringify({ response: authenticator.register(options.challenge, RP, ORIGIN) }),
    });
    expect(verify.status).toBe(400);
    expect(await services.store.getUserByHandle('forged')).toBeNull();
  });
});

describe('email factor verify/resend gating', () => {
  async function registerEmail(app: ReturnType<typeof createApp>, email: string, handle: string) {
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        handle,
        display_name: handle,
        email,
        date_of_birth: '1990-01-01',
        captcha: await signupCaptcha(app),
      }),
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

  it('resend targets the STAGED address when an email change is pending', async () => {
    // `/email/add` stages a `pendingEmail` and sends its code DETACHED, so an SES
    // fault leaves the address staged and the code undelivered.  This route used
    // to send only to the address ON FILE and refuse outright when that factor
    // was already verified — so a member changing an already-verified email
    // waited for a code that was never sent, and the advertised resend path
    // answered `not_applicable`: the one state where resend is most obviously
    // needed was the one it excluded.
    const app = createApp();
    const sid = await registerEmail(app, 'staged-from@example.com', 'stageduser');
    // Verify the current factor, so the OLD guard would refuse the resend.
    const user = await services.store.getUserByEmail('staged-from@example.com');
    if (!user) throw new Error('fixture user missing');
    await services.store.setAuth(user.userId, {
      emailVerified: true,
      pendingEmail: 'staged-to@example.com',
    });
    const mailer = services.mailer as RecordingMailer;
    const before = mailer.codes.length;
    const res = await app.request('/v1/auth/email/resend', {
      method: 'POST',
      headers: headers(sid),
    });
    expect(res.status).toBe(200);
    // The code went to the STAGED address — the one the member is waiting on —
    // not to the verified address already on file.
    const sent = mailer.codes.slice(before);
    expect(sent.map((entry) => entry.to)).toEqual(['staged-to@example.com']);
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
    const userId = (await services.store.getUserByHandle('creduser'))?.userId as string;

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
    expect(await services.store.listWebauthn(userId)).toHaveLength(2);

    // Rename a passkey (no rotation).
    const first = (await services.store.listWebauthn(userId))[0];
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
    expect(await services.store.listWebauthn(userId)).toHaveLength(1);

    // Removing the LAST credential is refused (last-method guard).
    const last = (await services.store.listWebauthn(userId))[0];
    const delLast = await app.request(`/v1/auth/credentials/webauthn/${last?.credentialId}`, {
      method: 'DELETE',
      headers: headers(session),
    });
    expect(delLast.status).toBe(409);
    expect(await services.store.listWebauthn(userId)).toHaveLength(1);
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
    const user = await services.store.getUserByHandle('suspendme');
    await services.store.updateUser(user?.userId as string, { accountState: 'suspended' });
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
    const user = await services.store.createUser({
      handle: 'susmail',
      displayName: 'S',
      email: 'sus@example.com',
      accountState: 'suspended',
      locale: null,
      ageBand: 'adult',
      privacySettings: (await import('@licio/shared')).defaultPrivacySettings(),
      personalizationSettings: (await import('@licio/shared')).defaultPersonalizationSettings(),
      roles: ['user'],
    });
    await services.store.setAuth(user.userId, { emailVerified: true });
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

  // The mint chokepoint must ADMIT exactly what the middleware admits.  A
  // `restricted` account (WS-J `restrict` sanction) is allowed to authenticate
  // and self-serve — appeals, notices, data rights — so refusing it a session
  // would turn the sanction into a silent lockout the moment the old session
  // expired, with the appeal path locked behind the very sanction being
  // appealed.  Write denial stays where it belongs: `requireUnrestricted()`.
  it('MINTS a session for a RESTRICTED account, then denies only its public writes', async () => {
    const app = createApp();
    const user = await services.store.createUser({
      handle: 'restrictme',
      displayName: 'R',
      email: 'restrict@example.com',
      accountState: 'restricted',
      locale: null,
      ageBand: 'adult',
      privacySettings: (await import('@licio/shared')).defaultPrivacySettings(),
      personalizationSettings: (await import('@licio/shared')).defaultPersonalizationSettings(),
      roles: ['user'],
    });
    await services.store.setAuth(user.userId, { emailVerified: true });
    const start = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email: 'restrict@example.com' }),
    });
    const attempt = cookie(start, '__Host-otp');
    const code = (services.mailer as RecordingMailer).codes.at(-1)?.code as string;
    const verify = await app.request('/v1/auth/email/verify-login', {
      method: 'POST',
      headers: headers(attempt),
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);
    const sid = cookie(verify, '__Host-sid');
    expect(sid.startsWith('__Host-sid=')).toBe(true);
    expect(await services.sessions.listForUser(user.userId)).toHaveLength(1);

    // The self-serve surface the sanction promises is reachable with that session.
    const settings = await app.request('/v1/privacy/settings', { headers: headers(sid) });
    expect(settings.status).toBe(200);

    // ...and public contribution is still refused, by the write guard, not the mint.
    const tokenRes = await app.request('/api/csrf-token', { headers: headers(sid) });
    const { token } = await readJson<{ token: string }>(tokenRes);
    const post = await app.request('/v1/stories', {
      method: 'POST',
      headers: { ...headers(sid), 'x-csrf-token': token },
      body: JSON.stringify({ url: 'https://example.com/a', title: 'T' }),
    });
    expect(post.status).toBe(403);
    expect((await readJson<{ error: { code: string } }>(post)).error.code).toBe(
      'account_restricted',
    );
  });
});

describe('email issuance cooldown (anti-mail-bombing, §19.1-aligned)', () => {
  it('sends at most ONE login code per mailbox per window, with identical 202s', async () => {
    const app = createApp();
    const user = await services.store.createUser({
      handle: 'bombme',
      displayName: 'B',
      email: 'bomb@example.com',
      accountState: 'active',
      locale: null,
      ageBand: 'adult',
      privacySettings: (await import('@licio/shared')).defaultPrivacySettings(),
      personalizationSettings: (await import('@licio/shared')).defaultPersonalizationSettings(),
      roles: ['user'],
    });
    await services.store.setAuth(user.userId, { emailVerified: true });

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
    await services.store.createUser({
      handle: 'dupowner',
      displayName: 'D',
      email: 'dup@example.com',
      accountState: 'active',
      locale: null,
      ageBand: 'adult',
      privacySettings: (await import('@licio/shared')).defaultPrivacySettings(),
      personalizationSettings: (await import('@licio/shared')).defaultPersonalizationSettings(),
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
          captcha: await signupCaptcha(app),
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

describe('step-up email send cooldown', () => {
  it('rate-limits step-up email code sends to one per cooldown window', async () => {
    const app = createApp();
    const shared = await import('@licio/shared');
    const user = await services.store.createUser({
      handle: 'stepupmail',
      displayName: 'S',
      email: 'su@example.com',
      accountState: 'active',
      locale: null,
      ageBand: 'adult',
      privacySettings: shared.defaultPrivacySettings(),
      personalizationSettings: shared.defaultPersonalizationSettings(),
      roles: ['user'],
    });
    await services.store.setAuth(user.userId, { emailVerified: true });
    const session = await createSession(services.sessions, {
      userId: user.userId,
      authMethod: 'email_otp',
      deviceLabel: 'device',
      rememberMe: false,
    });
    const sid = `__Host-sid=${session.token}`;

    const first = await app.request('/v1/auth/step-up/email/start', {
      method: 'POST',
      headers: headers(sid),
    });
    expect(first.status).toBe(200);
    const second = await app.request('/v1/auth/step-up/email/start', {
      method: 'POST',
      headers: headers(sid),
    });
    expect(second.status).toBe(429);
    // Exactly one code left the building.
    expect(
      (services.mailer as RecordingMailer).codes.filter((c) => c.to === 'su@example.com'),
    ).toHaveLength(1);
  });
});

describe('email account recovery + pending email change', () => {
  it('recovers a stranded unverified signup via OTP login (verifying on success)', async () => {
    const app = createApp();
    // Register but NEVER verify, and discard the session (simulate a lost cookie).
    await app.request('/v1/auth/register', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        handle: 'stranded',
        display_name: 'S',
        email: 'stranded@example.com',
        date_of_birth: '1990-01-01',
        captcha: await signupCaptcha(app),
      }),
    });
    const userId = (await services.store.getUserByEmail('stranded@example.com'))?.userId as string;
    expect((await services.store.getAuth(userId))?.emailVerified).toBe(false);

    // email/start now sends a LOGIN code to the unverified-but-registered email.
    const start = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email: 'stranded@example.com' }),
    });
    const attempt = cookie(start, '__Host-otp');
    const loginCode = (services.mailer as RecordingMailer).codes
      .filter((c) => c.kind === 'login')
      .at(-1)?.code as string;
    expect(loginCode).toBeTruthy();

    const verify = await app.request('/v1/auth/email/verify-login', {
      method: 'POST',
      headers: headers(attempt),
      body: JSON.stringify({ code: loginCode }),
    });
    expect(verify.status).toBe(200);
    // Completing the OTP proved mailbox control → the email is now verified.
    expect((await services.store.getAuth(userId))?.emailVerified).toBe(true);
  });

  it('stages an email change as pending, keeping the current email verified until confirmed', async () => {
    const app = createApp();
    const reg = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        handle: 'changer',
        display_name: 'C',
        email: 'old@example.com',
        date_of_birth: '1990-01-01',
        captcha: await signupCaptcha(app),
      }),
    });
    let sid = cookie(reg, '__Host-sid');
    const regCode = (services.mailer as RecordingMailer).codes
      .filter((c) => c.kind === 'verify')
      .at(-1)?.code as string;
    sid =
      cookie(
        await app.request('/v1/auth/email/verify', {
          method: 'POST',
          headers: headers(sid),
          body: JSON.stringify({ code: regCode }),
        }),
        '__Host-sid',
      ) || sid;
    const userId = (await services.store.getUserByEmail('old@example.com'))?.userId as string;
    expect((await services.store.getAuth(userId))?.emailVerified).toBe(true);

    // Add a NEW email → staged as pending; the current verified email is untouched.
    const add = await app.request('/v1/auth/email/add', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(add.status).toBe(200);
    expect((await services.store.getUser(userId))?.email).toBe('old@example.com'); // still the old one
    expect((await services.store.getAuth(userId))?.emailVerified).toBe(true); // still verified
    expect((await services.store.getAuth(userId))?.pendingEmail).toBe('new@example.com');

    // Confirm the new address → promoted; pending cleared.
    const newCode = (services.mailer as RecordingMailer).codes
      .filter((c) => c.kind === 'verify')
      .at(-1)?.code as string;
    const confirm = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: newCode }),
    });
    expect(confirm.status).toBe(200);
    expect((await services.store.getUser(userId))?.email).toBe('new@example.com');
    expect((await services.store.getAuth(userId))?.pendingEmail).toBeNull();
  });

  it('does not promote a pending email change with a code delivered to the OLD address (WS-D.1.4b)', async () => {
    const app = createApp();
    const reg = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        handle: 'victim',
        display_name: 'V',
        email: 'a@example.com',
        date_of_birth: '1990-01-01',
        captcha: await signupCaptcha(app),
      }),
    });
    let sid = cookie(reg, '__Host-sid');
    const regCode = (services.mailer as RecordingMailer).codes
      .filter((c) => c.to === 'a@example.com' && c.kind === 'verify')
      .at(-1)?.code as string;
    sid =
      cookie(
        await app.request('/v1/auth/email/verify', {
          method: 'POST',
          headers: headers(sid),
          body: JSON.stringify({ code: regCode }),
        }),
        '__Host-sid',
      ) || sid;
    const userId = (await services.store.getUserByEmail('a@example.com'))?.userId as string;

    // Stage a change to B (the fresh session satisfies step-up).
    expect(
      (
        await app.request('/v1/auth/email/add', {
          method: 'POST',
          headers: headers(sid),
          body: JSON.stringify({ email: 'b@example.com' }),
        })
      ).status,
    ).toBe(200);
    expect((await services.store.getAuth(userId))?.pendingEmail).toBe('b@example.com');

    // Obtain a code delivered to the CURRENT address A via step-up start.  Before
    // the fix, this code shared the /email/verify slot and could confirm B.
    expect(
      (
        await app.request('/v1/auth/step-up/email/start', {
          method: 'POST',
          headers: headers(sid),
          body: '{}',
        })
      ).status,
    ).toBe(200);
    const codeToA = (services.mailer as RecordingMailer).codes
      .filter((c) => c.to === 'a@example.com' && c.kind === 'verify')
      .at(-1)?.code as string;

    // Submitting the A-delivered code to /email/verify must NOT promote B: the
    // pending change is unchanged and the account email stays A.
    const attack = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: codeToA }),
    });
    expect(attack.status).toBe(400);
    expect((await services.store.getUser(userId))?.email).toBe('a@example.com');
    expect((await services.store.getAuth(userId))?.pendingEmail).toBe('b@example.com');
  });
});

describe('mail delivery is best-effort, never a 500 on the response path', () => {
  /** A mailer that fails the way `SesMailer` does: a throw carrying only a status. */
  function failingMailer(): RecordingMailer {
    const mailer = new RecordingMailer();
    mailer.sendCode = async () => {
      throw new Error('SES send failed: 429');
    };
    mailer.sendNotice = async () => {
      throw new Error('SES send failed: 429');
    };
    return mailer;
  }

  it('completes /v1/auth/register with a session when the verification mail throws', async () => {
    services.mailer = failingMailer();
    const app = createApp();
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        handle: 'sesdown',
        display_name: 'S',
        email: 'sesdown@example.com',
        date_of_birth: '1990-01-01',
        captcha: await signupCaptcha(app),
      }),
    });
    // The user row is committed BEFORE the send, so a throwing mailer must not
    // turn the request into a 500 that strands a real account with no session:
    // the user is signed in and can pull a fresh code from /email/resend.
    expect(res.status).toBe(200);
    expect(cookie(res, '__Host-sid').startsWith('__Host-sid=')).toBe(true);
    const user = await services.store.getUserByHandle('sesdown');
    expect(user).not.toBeNull();
    expect(await services.sessions.listForUser(user?.userId as string)).toHaveLength(1);
  });

  it('answers /v1/auth/email/resend 200 when the mail throws', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        handle: 'resenddown',
        display_name: 'R',
        email: 'resenddown@example.com',
        date_of_birth: '1990-01-01',
        captcha: await signupCaptcha(app),
      }),
    });
    const sid = cookie(res, '__Host-sid');
    services.mailer = failingMailer();
    // The cooldown is the real bound on this route; delivery is best-effort, so
    // an SES fault must not 500 a resend the caller then has to wait out.
    const resend = await app.request('/v1/auth/email/resend', {
      method: 'POST',
      headers: headers(sid),
    });
    expect(resend.status).toBe(200);
  });
});

// The per-account limiter itself is unit-tested in
// identity/__tests__/rate-limit-auth.test.ts; what is exercised here is the
// WIRING at the route.  The passkey path has no other throttle — unlike the
// email path there is no per-code attempt cap behind it — so `checkRateLimit`
// running BEFORE `verifyAuthentication` is the whole brute-force defence for a
// named account, and every existing route test performs exactly one attempt.
describe('per-account auth lockout at the /v1/auth route boundary', () => {
  // Any string the ceremony's stored challenge cannot equal.
  const WRONG_CHALLENGE = 'bm90LXRoZS1yZWFsLWNoYWxsZW5nZQ';

  /** One passkey login attempt end-to-end: fresh options (the challenge is
   *  single-use, so every attempt needs its own), then an assertion over either
   *  the REAL challenge or a bogus one. */
  async function loginAttempt(
    app: ReturnType<typeof createApp>,
    authenticator: SoftwareAuthenticator,
    opts: { challenge: 'real' | 'wrong'; counter: number },
  ): Promise<Response> {
    const optRes = await app.request('/v1/auth/webauthn/authenticate/options', {
      method: 'POST',
      headers: headers(),
    });
    const attempt = cookie(optRes, '__Host-wa');
    const { challenge } = await readJson<{ challenge: string }>(optRes);
    return app.request('/v1/auth/webauthn/authenticate/verify', {
      method: 'POST',
      headers: headers(attempt),
      body: JSON.stringify({
        response: authenticator.authenticate(
          opts.challenge === 'real' ? challenge : WRONG_CHALLENGE,
          RP,
          ORIGIN,
          opts.counter,
        ),
      }),
    });
  }

  /** Swap in a clock-injected limiter (the module's documented deterministic-test
   *  seam) so `Retry-After` is the exact configured cooldown rather than "the
   *  cooldown minus however long the requests took". */
  function pinRateLimitClock(): { advance: (ms: number) => void } {
    let clock = Date.now();
    services.rateLimit = new AuthRateLimiter(new InMemoryAuthRateLimitStore(), () => clock);
    return {
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  const errorCode = async (res: Response): Promise<string> =>
    (await readJson<{ error: { code: string } }>(res)).error.code;

  it('429s the passkey path past the soft threshold — including a VALID assertion', async () => {
    const { app, authenticator } = await passkeySignup('lockme');
    pinRateLimitClock();
    let counter = 1;

    const statuses: number[] = [];
    for (let i = 0; i < AUTH_RATE_LIMITS.account.softDelayAt; i += 1) {
      const res = await loginAttempt(app, authenticator, {
        challenge: 'wrong',
        counter: counter++,
      });
      statuses.push(res.status);
      expect(await errorCode(res)).toBe('auth_failed');
    }
    expect(statuses).toEqual(Array(AUTH_RATE_LIMITS.account.softDelayAt).fill(400));

    const blocked = await loginAttempt(app, authenticator, {
      challenge: 'wrong',
      counter: counter++,
    });
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe('rate_limited');
    expect(Number(blocked.headers.get('retry-after'))).toBe(
      AUTH_RATE_LIMITS.account.softDelayMs / 1000,
    );

    // The gate runs AHEAD of the signature check: the genuine credential is
    // refused too, and mints nothing.  Ordering the two the other way would let
    // an attacker keep probing assertions while the cooldown only shaped the
    // error body.
    const valid = await loginAttempt(app, authenticator, { challenge: 'real', counter: counter++ });
    expect(valid.status).toBe(429);
    expect(cookie(valid, '__Host-sid')).toBe('');
  });

  it('escalates to the 30-minute hard lock and alerts the account owner', async () => {
    const { app, authenticator } = await passkeySignup('lockhard');
    const userId = (await services.store.getUserByHandle('lockhard'))?.userId as string;
    const clock = pinRateLimitClock();

    // One failure short of the lock.  A single sequential attacker cannot walk
    // the ladder there — each cooldown must elapse first, and the 15-minute
    // sliding window prunes older failures faster than the spacing accumulates
    // new ones — but a burst whose attempts all clear `check()` before any
    // failure records does exactly this, which is the case `lockAt` exists for.
    const accountKey = accountRefForUser(services, userId);
    for (let i = 0; i < AUTH_RATE_LIMITS.account.lockAt - 1; i += 1) {
      await services.rateLimit.recordFailure(accountKey);
    }
    // Past the cooldown those failures armed, but far inside the window that
    // keeps them counted.
    clock.advance(AUTH_RATE_LIMITS.account.hardDelayMs + 1);

    // The final failure goes through the ROUTE, so the owner alert fires from
    // the route's own recordAuthFailure rather than from a direct store call.
    const last = await loginAttempt(app, authenticator, { challenge: 'wrong', counter: 1 });
    expect(last.status).toBe(400);
    const activity = await services.audit.securityActivityForUser(userId);
    expect(activity.filter((e) => e.event_type === 'account_lockout')).toHaveLength(1);

    // Locked for thirty minutes, not the thirty-second soft cooldown.
    const locked = await loginAttempt(app, authenticator, { challenge: 'real', counter: 2 });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBe(AUTH_RATE_LIMITS.account.lockMs / 1000);
  });

  it('clears the failure counter on a successful login', async () => {
    const { app, authenticator } = await passkeySignup('clearme');
    pinRateLimitClock();
    let counter = 1;
    const shortOfThreshold = AUTH_RATE_LIMITS.account.softDelayAt - 1;

    for (let i = 0; i < shortOfThreshold; i += 1) {
      const res = await loginAttempt(app, authenticator, {
        challenge: 'wrong',
        counter: counter++,
      });
      expect(res.status).toBe(400);
    }
    const ok = await loginAttempt(app, authenticator, { challenge: 'real', counter: counter++ });
    expect(ok.status).toBe(200);

    // Without the reset the counter would stand at 4 and this batch would cross
    // the threshold on its first failure, 429ing the second — so an all-400
    // batch is what proves `recordSuccess` ran.
    const after: number[] = [];
    for (let i = 0; i < shortOfThreshold; i += 1) {
      const res = await loginAttempt(app, authenticator, {
        challenge: 'wrong',
        counter: counter++,
      });
      after.push(res.status);
    }
    expect(after).toEqual(Array(shortOfThreshold).fill(400));
  });
});
