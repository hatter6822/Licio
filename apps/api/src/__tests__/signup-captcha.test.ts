// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Route-level sign-up proof-of-work gating (WS-D bot-prevention layer 1):
// every account-minting entry point demands a solved, single-use challenge
// BEFORE any store work, and the challenge endpoint issues verifiable puzzles.
import { powCaptchaDisabledSchema, powChallengeSchema } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { solvePowChallengeSync } from '../identity/pow-captcha.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  type IdentityServices,
  setIdentityServices,
} from '../identity/services.js';
import { signupCaptcha } from './pow-test-helpers.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
  signupPow: { maxNumber: 16 },
};

let services: IdentityServices;

beforeEach(() => {
  services = createInMemoryIdentityServices(CONFIG);
  setIdentityServices(services);
});
afterEach(async () => {
  await services.store.clear();
});

const headers = { 'content-type': 'application/json' };
const registerBody = (handle: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    handle,
    display_name: handle,
    email: `${handle}@example.com`,
    date_of_birth: '1990-01-01',
    ...extra,
  });

async function readError(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? '';
}

describe('POST /v1/auth/captcha/challenge', () => {
  it('issues a schema-valid, solvable challenge', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/captcha/challenge', { method: 'POST' });
    expect(res.status).toBe(200);
    const challenge = powChallengeSchema.parse(await res.json());
    expect(challenge.max_number).toBe(16);
    // Solvable end-to-end: the digest relation holds for some n in range.
    const solution = solvePowChallengeSync(challenge);
    expect(solution.challenge_id).toBe(challenge.challenge_id);
  });
});

describe('the operator opt-out (SIGNUP_POW_MAX_NUMBER=0) disables the gate cleanly', () => {
  beforeEach(() => {
    // Rebuild with the gate DISABLED for this block.
    services = createInMemoryIdentityServices({ ...CONFIG, signupPow: { maxNumber: 0 } });
    setIdentityServices(services);
  });

  it('returns the disabled sentinel (never a 500) instead of a puzzle', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/captcha/challenge', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(powCaptchaDisabledSchema.parse(await res.json())).toEqual({ disabled: true });
  });

  it('lets /register succeed with NO captcha when disabled', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers,
      body: registerBody('nogate'),
    });
    expect(res.status).toBe(200);
    expect(await services.store.getUserByHandle('nogate')).not.toBeNull();
  });
});

describe('sign-up endpoints demand the proof-of-work', () => {
  it('rejects /register without a captcha (captcha_required) and creates NO user', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers,
      body: registerBody('nocaptcha'),
    });
    expect(res.status).toBe(403);
    expect(await readError(res)).toBe('captcha_required');
    expect(await services.store.getUserByHandle('nocaptcha')).toBeNull();
  });

  it('rejects /register with a wrong-number solution (captcha_invalid)', async () => {
    const app = createApp();
    const solution = await signupCaptcha(app);
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers,
      body: registerBody('badsolve', {
        captcha: { ...solution, number: (solution.number + 1) % (solution.max_number + 1) },
      }),
    });
    expect(res.status).toBe(403);
    expect(await readError(res)).toBe('captcha_invalid');
    expect(await services.store.getUserByHandle('badsolve')).toBeNull();
  });

  it('accepts /register with a valid solution and rejects the SAME solution replayed', async () => {
    const app = createApp();
    const solution = await signupCaptcha(app);
    const first = await app.request('/v1/auth/register', {
      method: 'POST',
      headers,
      body: registerBody('solved', { captcha: solution }),
    });
    expect(first.status).toBe(200);
    expect(await services.store.getUserByHandle('solved')).not.toBeNull();

    // One solve mints ONE account: the consumed challenge cannot be replayed.
    const replay = await app.request('/v1/auth/register', {
      method: 'POST',
      headers,
      body: registerBody('replayer', { captcha: solution }),
    });
    expect(replay.status).toBe(403);
    expect(await readError(replay)).toBe('captcha_invalid');
    expect(await services.store.getUserByHandle('replayer')).toBeNull();
  });

  it('gates the passkey signup entry (/webauthn/signup/options) the same way', async () => {
    const app = createApp();
    const res = await app.request('/v1/auth/webauthn/signup/options', {
      method: 'POST',
      headers,
      body: JSON.stringify({ handle: 'pkuser', display_name: 'P', date_of_birth: '1990-01-01' }),
    });
    expect(res.status).toBe(403);
    expect(await readError(res)).toBe('captcha_required');
  });

  it('runs the captcha check BEFORE the duplicate-email anti-enumeration branch', async () => {
    const app = createApp();
    // Seed an existing account, then probe its email WITHOUT a captcha: the
    // response must be the captcha rejection, not the enumeration-safe 200 —
    // and no owner notice may be sent for an unpaid probe.
    const solution = await signupCaptcha(app);
    await app.request('/v1/auth/register', {
      method: 'POST',
      headers,
      body: registerBody('owner', { captcha: solution }),
    });
    const probe = await app.request('/v1/auth/register', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        handle: 'prober',
        display_name: 'X',
        email: 'owner@example.com',
        date_of_birth: '1990-01-01',
      }),
    });
    expect(probe.status).toBe(403);
    expect(await readError(probe)).toBe('captcha_required');
  });
});
