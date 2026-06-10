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
import { createSession } from '../identity/sessions.js';
import { base32Decode, totp } from '../identity/totp.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
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
    body: JSON.stringify({ handle, display_name: handle, date_of_birth: '1990-01-01' }),
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

beforeEach(() => {
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
    const sealed = services.store.getAuth(
      services.store.getUserByHandle('mfauser')?.userId as string,
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

    const code = totp(secret, Date.now());
    const first = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sidAfterConfirm),
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);
    const replay = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sidAfterConfirm),
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

    const reuse = await app.request('/v1/auth/mfa/totp/verify', {
      method: 'POST',
      headers: headers(sid2),
      body: JSON.stringify({ code: recovery }),
    });
    expect(reuse.status).toBe(400);
  });

  it('refuses to re-enroll over active MFA without the current factor', async () => {
    const { app, sid } = await signup('reenroll');
    const userId = services.store.getUserByHandle('reenroll')?.userId as string;
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
    expect(services.store.getAuth(userId)?.mfaEnabled).toBe(true);
    const activeSecret = services.store.getAuth(userId)?.mfaSecret;

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
    expect(services.store.getAuth(userId)?.mfaSecret).toBe(activeSecret);
    expect(services.store.getAuth(userId)?.mfaEnabled).toBe(true);

    // The legitimate owner (the confirm session is mfaVerified) CAN re-enroll.
    const reenroll = await app.request('/v1/auth/mfa/totp/enroll', {
      method: 'POST',
      headers: headers(sid2),
    });
    expect(reenroll.status).toBe(200);
  });

  it('disables MFA (clears the secret and recovery codes)', async () => {
    const { app, sid } = await signup('disableuser');
    const userId = services.store.getUserByHandle('disableuser')?.userId as string;
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
    expect(services.store.getAuth(userId)?.mfaEnabled).toBe(true);

    const disable = await app.request('/v1/auth/mfa/totp/disable', {
      method: 'POST',
      headers: headers(sid2),
    });
    expect(disable.status).toBe(200);
    expect(services.store.getAuth(userId)?.mfaEnabled).toBe(false);
    expect(services.store.getAuth(userId)?.mfaSecret).toBeNull();
  });
});
