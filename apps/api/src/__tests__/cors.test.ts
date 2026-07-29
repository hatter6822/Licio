// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { getAllowedOrigins } from '../middleware/cors.js';

describe('CORS', () => {
  const app = createApp();

  // Every case below mutates NODE_ENV / CORS_ORIGIN, and both are read by
  // `getAllowedOrigins()` — which feeds the CSRF Origin allowlist as well as
  // CORS. Without save/restore the last value set here leaks into every other
  // suite sharing this worker (a stray `development` would silently widen the
  // allowlist under an unrelated test).
  let priorNodeEnv: string | undefined;
  let priorCorsOrigin: string | undefined;
  beforeEach(() => {
    priorNodeEnv = process.env['NODE_ENV'];
    priorCorsOrigin = process.env['CORS_ORIGIN'];
  });
  afterEach(() => {
    if (priorNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = priorNodeEnv;
    if (priorCorsOrigin === undefined) delete process.env['CORS_ORIGIN'];
    else process.env['CORS_ORIGIN'] = priorCorsOrigin;
  });

  it('should allow requests from the configured origin', async () => {
    process.env['CORS_ORIGIN'] = 'https://licio.app';
    const res = await app.request('/health', {
      headers: { Origin: 'https://licio.app' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://licio.app');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('should reject requests from unauthorized origins', async () => {
    const res = await app.request('/health', {
      headers: { Origin: 'https://evil.com' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('should set Vary: Origin on an allowed-origin response', async () => {
    process.env['CORS_ORIGIN'] = 'https://licio.app';
    const res = await app.request('/health', {
      headers: { Origin: 'https://licio.app' },
    });
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('should set Vary: Origin on a disallowed/absent-origin response', async () => {
    const res = await app.request('/health', {
      headers: { Origin: 'https://evil.com' },
    });
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('should set Vary: Origin on a preflight OPTIONS response', async () => {
    process.env['NODE_ENV'] = 'development';
    const res = await app.request('/health', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('should reject substring-matching origins', async () => {
    process.env['CORS_ORIGIN'] = 'https://licio.app';
    const res = await app.request('/health', {
      headers: { Origin: 'https://evil-licio.app' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('should handle OPTIONS preflight requests', async () => {
    process.env['NODE_ENV'] = 'development';
    const res = await app.request('/health', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(204);
  });

  // The dev-only `http://localhost:5173` entry is the one origin in the set that
  // is CONDITIONAL, and `getAllowedOrigins()` feeds both this middleware and
  // `originMismatch()` (the same-site CSRF gate on the token-exempt /v1/auth and
  // /v1/privacy surfaces).  Assert it as an ALLOWLIST — the exact set per
  // NODE_ENV — so widening the guard to `!== 'production'`, or deleting it while
  // consolidating dev-origin logic, is caught in whichever direction it drifts.
  it('adds the dev localhost origin ONLY under NODE_ENV=development', () => {
    process.env['CORS_ORIGIN'] = 'https://licio.app';
    process.env['NODE_ENV'] = 'development';
    expect([...getAllowedOrigins()]).toEqual(['https://licio.app', 'http://localhost:5173']);
    for (const value of ['production', 'test', 'staging', undefined] as const) {
      if (value === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = value;
      expect([...getAllowedOrigins()]).toEqual(['https://licio.app']);
    }
  });

  // The two localhost cases above assert `Vary` and `204`, which the middleware
  // emits unconditionally — neither observes the allow decision.  These two do.
  it('emits no ACAO for the dev localhost origin in production', async () => {
    process.env['CORS_ORIGIN'] = 'https://licio.app';
    process.env['NODE_ENV'] = 'production';
    const res = await app.request('/health', { headers: { Origin: 'http://localhost:5173' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    // Credentialed CORS is what makes a wrong ACAO readable — pin its absence too.
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('emits ACAO for the dev localhost origin under development', async () => {
    process.env['CORS_ORIGIN'] = 'https://licio.app';
    process.env['NODE_ENV'] = 'development';
    const res = await app.request('/health', { headers: { Origin: 'http://localhost:5173' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});
