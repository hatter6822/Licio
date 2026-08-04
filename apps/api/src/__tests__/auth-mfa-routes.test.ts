// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Steward TOTP MFA routes (WS-D.1.5): enroll → confirm → per-session verify, with
// replay rejection, single-use recovery codes, and disable.  The secret is sealed
// at rest (AES-256-GCM); the route never returns or stores it in plaintext.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { SoftwareAuthenticator } from '../identity/__tests__/software-authenticator.js';
import { sha256Hex } from '../identity/crypto.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  type IdentityServices,
  setIdentityServices,
} from '../identity/services.js';
import { createSession, type StoredSession } from '../identity/sessions.js';
import { base32Decode, hashRecoveryCode, totp } from '../identity/totp.js';
import { signupCaptcha } from './pow-test-helpers.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
  signupPow: { maxNumber: 16 },
};
let services: IdentityServices;

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
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Passkey signup → returns the app, the authenticator, and the session cookie. */
async function signup(handle: string) {
  const app = createApp();
  const authenticator = new SoftwareAuthenticator();
  const opt = await app.request('/v1/auth/webauthn/signup/options', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      handle,
      display_name: handle,
      date_of_birth: '1990-01-01',
      captcha: await signupCaptcha(app),
    }),
  });
  const options = await readJson<{ challenge: string }>(opt);
  const verify = await app.request('/v1/auth/webauthn/signup/verify', {
    method: 'POST',
    headers: headers(cookie(opt, '__Host-pksignup')),
    body: JSON.stringify({
      response: authenticator.register(options.challenge, 'localhost', 'http://localhost'),
    }),
  });
  return { app, authenticator, sid: cookie(verify, '__Host-sid') };
}

function secretFromUri(uri: string): Buffer {
  const b32 = uri.match(/secret=([A-Z2-7]+)/)?.[1] as string;
  return base32Decode(b32);
}
async function sessionMfaVerified(sid: string): Promise<boolean> {
  const token = sid.split('=')[1] as string;
  return (await services.sessions.get(sha256Hex(token)))?.record.mfa_verified ?? false;
}

beforeEach(async () => {
  services = createInMemoryIdentityServices(CONFIG);
  setIdentityServices(services);
});
afterEach(() => services.store.clear());

describe('TOTP MFA enroll → confirm → verify', () => {
  it('enrolls, confirms (issues 10 recovery codes), and per-session verifies', async () => {
    const { app, sid } = await signup('mfauser');

    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    expect(enroll.status).toBe(200);
    const { otpauth_uri } = await readJson<{ otpauth_uri: string }>(enroll);
    expect(otpauth_uri).toContain('issuer=Licio');
    // The secret is sealed at rest — never plaintext in the stored auth row.
    const sealed = (
      await services.store.getAuth(
        (
          await services.store.getUserByHandle('mfauser')
        )?.userId as string,
      )
    )?.mfaSecret;
    expect(sealed?.startsWith('v1.')).toBe(true);

    const secret = secretFromUri(otpauth_uri);
    const confirm = await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    expect(confirm.status).toBe(200);
    const { recovery_codes } = await readJson<{ recovery_codes: string[] }>(confirm);
    expect(recovery_codes).toHaveLength(10);
    // Confirm rotated the session and marked it MFA-verified (per-session MFA).
    const sid2 = cookie(confirm, '__Host-sid');
    expect(await sessionMfaVerified(sid2)).toBe(true);
  });

  it('rejects a replayed TOTP code within the same step', async () => {
    const { app, sid } = await signup('replayuser');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const sidAfterConfirm = cookie(
      await app.request('/v1/auth/mfa/totp/confirm', {
        method: 'POST',
        headers: headers(sid),
        body: JSON.stringify({ code: totp(secret) }),
      }),
      '__Host-sid',
    );

    // The confirm above burned its own step (WS-D.1.5b closes the enrollment-code
    // replay).  Simulate the next step arriving — clearing the high-water mark —
    // so a genuine later verify can succeed and its replay can then be rejected.
    const replayUid = (await services.store.getUserByHandle('replayuser'))?.userId as string;
    await services.otp.delete(`mfastep:${replayUid}`);

    const code = totp(secret, Date.now());
    const first = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sidAfterConfirm),
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);
    // The successful verify rotates the session (privilege-change fixation defense),
    // so the replay must ride the NEW cookie.
    const sidAfterFirst = cookie(first, '__Host-sid') || sidAfterConfirm;
    const replay = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sidAfterFirst),
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(400);
    expect((await readJson<{ error: { code: string } }>(replay)).error.code).toBe('replayed');
  });

  it('accepts a single-use recovery code, then rejects its reuse', async () => {
    const { app, sid } = await signup('recoveryuser');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const confirm = await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    const sid2 = cookie(confirm, '__Host-sid');
    const recovery = (await readJson<{ recovery_codes: string[] }>(confirm))
      .recovery_codes[0] as string;

    const use = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sid2),
      body: JSON.stringify({ code: recovery }),
    });
    expect(use.status).toBe(200);
    expect((await readJson<{ recovery_remaining: number }>(use)).recovery_remaining).toBe(9);

    // The successful verify rotated the session; the reuse attempt rides the new cookie.
    const sidAfterUse = cookie(use, '__Host-sid') || sid2;
    const reuse = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sidAfterUse),
      body: JSON.stringify({ code: recovery }),
    });
    expect(reuse.status).toBe(400);
  });

  it('does NOT burn the recovery code when the audit append fails', async () => {
    // The code was spent by a `setAuth` BEFORE `finishMfa` opened its unit, so
    // an audit failure answered 500 having permanently consumed it while
    // granting nothing — and on a user's last code that is the account. The
    // consumption now runs inside the same unit as the record, so a failing
    // append takes it down with it.
    const { app, sid } = await signup('recoveryaudit');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const confirm = await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    const sid2 = cookie(confirm, '__Host-sid');
    const recovery = (await readJson<{ recovery_codes: string[] }>(confirm))
      .recovery_codes[0] as string;

    // ONE failing append, on the verification record only.
    const realAppend = services.audit.append.bind(services.audit);
    let failed = false;
    services.audit.append = async (entry, createdAt) => {
      if (!failed && entry.eventType === 'mfa_verify') {
        failed = true;
        throw new Error('audit store unavailable');
      }
      return realAppend(entry, createdAt);
    };

    const attempt = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sid2),
      body: JSON.stringify({ code: recovery }),
    });
    expect(attempt.status).toBeGreaterThanOrEqual(500);
    services.audit.append = realAppend;

    // The code still works: nothing was consumed, so the user is not locked out
    // by a failure on the platform's side.
    const retry = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sid2),
      body: JSON.stringify({ code: recovery }),
    });
    expect(retry.status).toBe(200);
    expect((await readJson<{ recovery_remaining: number }>(retry)).recovery_remaining).toBe(9);
  });

  it('does NOT verify the session when the unit fails to commit', async () => {
    // `markMfaVerified` writes to Redis and cannot join the Postgres
    // transaction, so its ORDER is the whole guarantee. Inside the unit, a
    // commit failure left the session already privileged while the consumption
    // and the record rolled back — steward authority with nothing accounting
    // for it, and the code still reusable. After the commit, a failure grants
    // nothing.
    const { app, sid } = await signup('mfacommit');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const confirm = await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    const sid2 = cookie(confirm, '__Host-sid');
    const recovery = (await readJson<{ recovery_codes: string[] }>(confirm))
      .recovery_codes[0] as string;
    // A session that has NOT cleared MFA this session (the confirm rotated it).
    const { token: sid3 } = await createSession(services.sessions, {
      userId: (await services.sessions.get(sha256Hex(sid2.split('=')[1] as string)))?.record
        .user_id as string,
      authMethod: 'email_otp',
      deviceLabel: 'test',
      rememberMe: false,
    });
    expect(await sessionMfaVerified(`__Host-sid=${sid3}`)).toBe(false);

    // The unit accepts its writes and then fails to commit.
    const realTransact = services.transact.bind(services);
    services.transact = async (work) => {
      await realTransact(work);
      throw new Error('commit failed');
    };
    const attempt = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(`__Host-sid=${sid3}`),
      body: JSON.stringify({ code: recovery }),
    });
    services.transact = realTransact;
    expect(attempt.status).toBeGreaterThanOrEqual(500);
    // The session is STILL unverified: no privilege was granted by a request
    // whose record did not survive.
    expect(await sessionMfaVerified(`__Host-sid=${sid3}`)).toBe(false);
  });

  it('RESUMES a verification whose grant failed, so the last code is not lost', async () => {
    // The consumption commits before the Redis grant, which is the right order
    // — a privilege must not be granted ahead of the record of it. What that
    // leaves is the unit committing and the grant then failing: on any code but
    // the last, a retry with another one; on the LAST, the account, permanently,
    // for a fault on our side. So the spent code resumes its own verification.
    const { app, sid } = await signup('mfaresume');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const confirm = await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    const recovery = (await readJson<{ recovery_codes: string[] }>(confirm))
      .recovery_codes[0] as string;
    // A session that has NOT cleared MFA (the confirm rotated the other one).
    const userId = (
      await services.sessions.get(sha256Hex(cookie(confirm, '__Host-sid').split('=')[1] as string))
    )?.record.user_id as string;
    const { token: sid3 } = await createSession(services.sessions, {
      userId,
      authMethod: 'email_otp',
      deviceLabel: 'test',
      rememberMe: false,
    });

    // The grant fails after the unit commits.
    // `markMfaVerified` is a free function over the store's `put`, so the fault
    // is injected there — the first write of the verified flag fails.
    const realPut = services.sessions.put.bind(services.sessions);
    let failed = false;
    services.sessions.put = async (tokenHash: string, record: StoredSession) => {
      if (!failed && record.record.mfa_verified === true) {
        failed = true;
        throw new Error('session store unavailable');
      }
      return realPut(tokenHash, record);
    };
    const attempt = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(`__Host-sid=${sid3}`),
      body: JSON.stringify({ code: recovery }),
    });
    services.sessions.put = realPut;
    expect(attempt.status).toBeGreaterThanOrEqual(500);
    expect(await sessionMfaVerified(`__Host-sid=${sid3}`)).toBe(false);

    // The SAME code, from the SAME session, completes it.
    const retry = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(`__Host-sid=${sid3}`),
      body: JSON.stringify({ code: recovery }),
    });
    expect(retry.status).toBe(200);
    // The completion rotates the session id on the privilege change, exactly as
    // an ordinary verification does, so the verified session is the rotated one.
    expect(await sessionMfaVerified(cookie(retry, '__Host-sid'))).toBe(true);

    // …and from ANY OTHER session it is still spent: the code grants MFA to
    // exactly one session, which is what single-use means here.
    const { token: sid4 } = await createSession(services.sessions, {
      userId,
      authMethod: 'email_otp',
      deviceLabel: 'other',
      rememberMe: false,
    });
    const elsewhere = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(`__Host-sid=${sid4}`),
      body: JSON.stringify({ code: recovery }),
    });
    expect(elsewhere.status).toBe(400);

    // …and not from the ROTATED session either: completing rotates the id on the
    // privilege change, so the stored hash stops matching the moment the grant
    // lands. The resume window is only ever between the commit that spent the
    // code and the completion it was spent for.
    const afterRotation = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(cookie(retry, '__Host-sid')),
      body: JSON.stringify({ code: recovery }),
    });
    expect(afterRotation.status).toBe(400);
  });

  it('lets only ONE session adopt an abandoned continuation', async () => {
    // Two primary-authenticated sessions can both find the original session gone
    // and both conclude they may finish it — and a code that is single-use by
    // construction would then grant steward assurance to both.
    const { app, sid } = await signup('mfaadopt');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const confirm = await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    const sid2 = cookie(confirm, '__Host-sid');
    const recovery = (await readJson<{ recovery_codes: string[] }>(confirm))
      .recovery_codes[0] as string;
    const userId = (await services.sessions.get(sha256Hex(sid2.split('=')[1] as string)))?.record
      .user_id as string;
    const { token: doomed } = await createSession(services.sessions, {
      userId,
      authMethod: 'email_otp',
      deviceLabel: 'doomed',
      rememberMe: false,
    });

    // Spend the code with the grant failing, then destroy that session.
    const realPut = services.sessions.put.bind(services.sessions);
    let failed = false;
    services.sessions.put = async (tokenHash: string, record: StoredSession) => {
      if (!failed && record.record.mfa_verified === true) {
        failed = true;
        throw new Error('session store unavailable');
      }
      return realPut(tokenHash, record);
    };
    await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(`__Host-sid=${doomed}`),
      body: JSON.stringify({ code: recovery }),
    });
    services.sessions.put = realPut;
    await services.sessions.delete(sha256Hex(doomed));

    // Two fresh sessions race to adopt it.
    const tokens = await Promise.all([
      createSession(services.sessions, {
        userId,
        authMethod: 'email_otp',
        deviceLabel: 'a',
        rememberMe: false,
      }),
      createSession(services.sessions, {
        userId,
        authMethod: 'email_otp',
        deviceLabel: 'b',
        rememberMe: false,
      }),
    ]);
    const results = await Promise.all(
      tokens.map((t) =>
        app.request('/v1/auth/mfa/totp/verify', {
          method: 'POST',
          headers: headers(`__Host-sid=${t.token}`),
          body: JSON.stringify({ code: recovery }),
        }),
      ),
    );
    const verified = results.filter((r) => r.status === 200);
    expect(verified).toHaveLength(1);
  });

  it('does NOT let a pending code survive a factor RESET', async () => {
    // A continuation is about the factor it was issued for. Nothing bound it to
    // an enrollment generation, so a second verified session could disable MFA
    // and enrol a fresh secret with fresh codes — and the old session could then
    // present its already-spent OLD code and be verified against the NEW factor.
    const { app, sid } = await signup('mfareset');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const confirm = await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    const sid2 = cookie(confirm, '__Host-sid');
    const recovery = (await readJson<{ recovery_codes: string[] }>(confirm))
      .recovery_codes[0] as string;
    const userId = (await services.sessions.get(sha256Hex(sid2.split('=')[1] as string)))?.record
      .user_id as string;
    const { token: sid3 } = await createSession(services.sessions, {
      userId,
      authMethod: 'email_otp',
      deviceLabel: 'test',
      rememberMe: false,
    });

    // The grant fails after the unit commits: the code is spent and pending.
    const realPut = services.sessions.put.bind(services.sessions);
    let failed = false;
    services.sessions.put = async (tokenHash: string, record: StoredSession) => {
      if (!failed && record.record.mfa_verified === true) {
        failed = true;
        throw new Error('session store unavailable');
      }
      return realPut(tokenHash, record);
    };
    await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(`__Host-sid=${sid3}`),
      body: JSON.stringify({ code: recovery }),
    });
    services.sessions.put = realPut;

    // …then MFA is re-enrolled from elsewhere, which replaces the code set.
    await services.store.setAuth(userId, {
      mfaEnabled: true,
      recoveryCodeHashes: [hashRecoveryCode('brand-new-code')],
    });

    // The old code is no longer a way in, spent or not.
    const stale = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(`__Host-sid=${sid3}`),
      body: JSON.stringify({ code: recovery }),
    });
    expect(stale.status).toBe(400);
    expect(await sessionMfaVerified(`__Host-sid=${sid3}`)).toBe(false);
  });

  it('records a REJECTED attempt as a failure, not as a verification', async () => {
    // Both paths appended `mfa_verify`, so the trail could not answer "did this
    // account clear MFA?" — a brute-force run read exactly like sign-ins.
    const { app, sid } = await signup('mfafailaudit');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const confirm = await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    const sid2 = cookie(confirm, '__Host-sid');

    const bad = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sid2),
      body: JSON.stringify({ code: '000000' }),
    });
    expect(bad.status).toBe(400);

    const token = sid2.split('=')[1] as string;
    const userId = (await services.sessions.get(sha256Hex(token)))?.record.user_id as string;
    const trail = await services.audit.securityActivityForUser(userId);
    const events = trail.map((e) => e.event_type);
    expect(events).toContain('mfa_verify_failed');
    // …and NOT as a success: the whole point is that the two are now distinct.
    expect(events).not.toContain('mfa_verify');
  });

  it('burns the confirm code so it cannot be replayed at /verify (WS-D.1.5b)', async () => {
    const { app, sid } = await signup('confirmreplay');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const code = totp(secret, Date.now());
    const sid2 = cookie(
      await app.request('/v1/auth/mfa/totp/confirm', {
        method: 'POST',
        headers: headers(sid),
        body: JSON.stringify({ code }),
      }),
      '__Host-sid',
    );
    // /confirm now seeds the same forward-only replay memory as /verify, so the
    // identical enrollment code is a spent step — presenting it at /verify replays.
    const replay = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sid2),
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(400);
    expect((await readJson<{ error: { code: string } }>(replay)).error.code).toBe('replayed');
  });

  it('rotates the session id on a successful /verify (privilege change)', async () => {
    const { app, sid } = await signup('verifyrotate');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const confirm = await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    const sid2 = cookie(confirm, '__Host-sid');
    const recovery = (await readJson<{ recovery_codes: string[] }>(confirm))
      .recovery_codes[0] as string;

    // A recovery-code verify succeeds regardless of the TOTP step; it must mint a
    // fresh, MFA-verified session id (mirroring /confirm and /disable rotation).
    const verify = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sid2),
      body: JSON.stringify({ code: recovery }),
    });
    expect(verify.status).toBe(200);
    const sid3 = cookie(verify, '__Host-sid');
    expect(sid3).not.toBe('');
    expect(sid3).not.toBe(sid2);
    expect(await sessionMfaVerified(sid3)).toBe(true);
  });

  it('refuses to re-enroll over active MFA without the current factor', async () => {
    const { app, sid } = await signup('reenroll');
    const userId = (await services.store.getUserByHandle('reenroll'))?.userId as string;
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const sid2 = cookie(
      await app.request('/v1/auth/mfa/totp/confirm', {
        method: 'POST',
        headers: headers(sid),
        body: JSON.stringify({ code: totp(secret) }),
      }),
      '__Host-sid',
    );
    expect((await services.store.getAuth(userId))?.mfaEnabled).toBe(true);
    const activeSecret = (await services.store.getAuth(userId))?.mfaSecret;

    // The attacker case: a FRESH session satisfies primary step-up but has NOT
    // cleared the current TOTP (mfaVerified=false).  Re-enrollment is refused, and
    // the active secret is left intact — the bypass is closed (WS-D.1.5b).
    const fresh = await createSession(services.sessions, {
      userId,
      authMethod: 'webauthn',
      deviceLabel: 'attacker-device',
      rememberMe: false,
    });
    const blocked = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(`__Host-sid=${fresh.token}`),
    });
    expect(blocked.status).toBe(403);
    expect((await readJson<{ error: { code: string } }>(blocked)).error.code).toBe(
      'mfa_reverify_required',
    );
    expect((await services.store.getAuth(userId))?.mfaSecret).toBe(activeSecret);
    expect((await services.store.getAuth(userId))?.mfaEnabled).toBe(true);

    // The legitimate owner (the confirm session is mfaVerified) CAN re-enroll.
    const reenroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid2),
    });
    expect(reenroll.status).toBe(200);
  });

  it('disables MFA (clears the secret and recovery codes)', async () => {
    const { app, sid } = await signup('disableuser');
    const userId = (await services.store.getUserByHandle('disableuser'))?.userId as string;
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    const sid2 = cookie(
      await app.request('/v1/auth/mfa/totp/confirm', {
        method: 'POST',
        headers: headers(sid),
        body: JSON.stringify({ code: totp(secret) }),
      }),
      '__Host-sid',
    );
    expect((await services.store.getAuth(userId))?.mfaEnabled).toBe(true);

    const disable = await app.request('/v1/auth/mfa/totp/disable', {
      method: 'POST',
      headers: headers(sid2),
    });
    expect(disable.status).toBe(200);
    expect((await services.store.getAuth(userId))?.mfaEnabled).toBe(false);
    expect((await services.store.getAuth(userId))?.mfaSecret).toBeNull();
  });

  it('refuses to DISABLE active MFA from a non-mfaVerified session (§WS-D.1.5b)', async () => {
    const { app, sid } = await signup('disableattacker');
    const userId = (await services.store.getUserByHandle('disableattacker'))?.userId as string;
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const secret = secretFromUri((await readJson<{ otpauth_uri: string }>(enroll)).otpauth_uri);
    await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    expect((await services.store.getAuth(userId))?.mfaEnabled).toBe(true);
    const activeSecret = (await services.store.getAuth(userId))?.mfaSecret;

    // A FRESH session satisfies primary step-up but has NOT cleared the current TOTP
    // (mfaVerified=false).  /disable must refuse, leaving MFA intact — otherwise a
    // phished primary credential could disable + re-enroll an attacker-chosen secret.
    const fresh = await createSession(services.sessions, {
      userId,
      authMethod: 'webauthn',
      deviceLabel: 'attacker-device',
      rememberMe: false,
    });
    const blocked = await app.request('/v1/auth/mfa/totp/disable', {
      method: 'POST',
      headers: headers(`__Host-sid=${fresh.token}`),
    });
    expect(blocked.status).toBe(403);
    expect((await readJson<{ error: { code: string } }>(blocked)).error.code).toBe(
      'mfa_reverify_required',
    );
    expect((await services.store.getAuth(userId))?.mfaEnabled).toBe(true);
    expect((await services.store.getAuth(userId))?.mfaSecret).toBe(activeSecret);
  });

  it('caps TOTP verification at 5 attempts per window — even CONCURRENTLY', async () => {
    // `/mfa/totp/verify` carries no `rateLimit()` middleware, so this cap is the
    // ONLY thing standing between an attacker with a valid session cookie and an
    // unbounded 6-digit brute force. It had no test at all, and the counter it
    // reads was a get-then-set: against Redis every overlapping request read the
    // same count, every one passed the check, and every one wrote the same
    // count + 1 — the bound never engaged.
    const { app, sid } = await signup('mfacapuser');
    const enroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid),
    });
    const { otpauth_uri } = await readJson<{ otpauth_uri: string }>(enroll);
    const secret = secretFromUri(otpauth_uri);
    const confirm = await app.request('/v1/auth/mfa/totp/confirm', {
      method: 'POST',
      headers: headers(sid),
      body: JSON.stringify({ code: totp(secret) }),
    });
    expect(confirm.status).toBe(200);
    const sid2 = cookie(confirm, '__Host-sid');

    const guess = () =>
      app.request('/v1/auth/mfa/totp/verify', {
        method: 'POST',
        headers: headers(sid2),
        body: JSON.stringify({ code: '000000' }),
      });

    // Twenty simultaneous guesses: at most five may reach the comparison.
    const statuses = (await Promise.all(Array.from({ length: 20 }, guess))).map((r) => r.status);
    expect(statuses.filter((s) => s === 400)).toHaveLength(5); // invalid_code
    expect(statuses.filter((s) => s === 429)).toHaveLength(15); // rate_limited

    // And the window keeps holding after the burst.
    const after = await guess();
    expect(after.status).toBe(429);
    expect((await readJson<{ error: { code: string } }>(after)).error.code).toBe('rate_limited');

    // A CORRECT code is refused too while the window is closed — the cap gates
    // the comparison itself, so a guessed code cannot slip through on the
    // attempt that happens to be right.
    const correct = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sid2),
      body: JSON.stringify({ code: totp(secret) }),
    });
    expect(correct.status).toBe(429);
  });
});
