// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Same-site CSRF defense-in-depth (Codex P2): every credentialed state-changing
// request — including the SameSite-only /v1/auth and /v1/privacy endpoints — must
// carry an Origin/Referer that matches the canonical app origin, so a malicious
// sibling subdomain cannot drive a plain form POST.  A header-less (non-browser)
// request is not a CSRF vector and is allowed; GETs and the beacon/report ingest
// paths are unaffected.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  setIdentityServices,
} from '../identity/services.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
};
const APP_ORIGIN = 'https://app.licio.test';

let prevCors: string | undefined;
let prevNodeEnv: string | undefined;

beforeEach(() => {
  prevCors = process.env['CORS_ORIGIN'];
  prevNodeEnv = process.env['NODE_ENV'];
  process.env['CORS_ORIGIN'] = APP_ORIGIN;
  process.env['NODE_ENV'] = 'test';
  setIdentityServices(createInMemoryIdentityServices(CONFIG));
});
afterEach(() => {
  if (prevCors === undefined) delete process.env['CORS_ORIGIN'];
  else process.env['CORS_ORIGIN'] = prevCors;
  if (prevNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = prevNodeEnv;
});

function start(headers: Record<string, string>) {
  return createApp().request('/v1/auth/email/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'origin@example.com' }),
  });
}

describe('same-site Origin enforcement on identity mutations', () => {
  it('rejects a state-changing request from a non-canonical Origin (403)', async () => {
    const res = await start({ origin: 'https://evil.licio.test' });
    expect(res.status).toBe(403);
  });

  it('allows the canonical Origin', async () => {
    const res = await start({ origin: APP_ORIGIN });
    expect(res.status).toBe(202);
  });

  it('allows a header-less (non-browser) request', async () => {
    const res = await start({});
    expect(res.status).toBe(202);
  });

  it('falls back to Referer and rejects a non-canonical one', async () => {
    const res = await start({ referer: 'https://evil.licio.test/attack' });
    expect(res.status).toBe(403);
  });
});
