import type { ServerEnv } from '@licio/shared/env/server';
import { describe, expect, it } from 'vitest';
import { createApiApp } from './app.js';

const env: ServerEnv = {
  DATABASE_URL: 'postgresql://licio:licio@localhost:5432/licio',
  REDIS_URL: 'redis://localhost:6379',
  PORT: 3001,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  CORS_ORIGIN: 'https://licio.app',
  SESSION_SECRET: 'api-test-session-secret-with-32-chars',
};

describe('api app security baseline', () => {
  it('serves a health check with strict security headers', async () => {
    const response = await createApiApp({ env }).request('/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
    expect(response.headers.get('strict-transport-security')).toContain('preload');
  });

  it('allows CORS only for the exact configured origin', async () => {
    const app = createApiApp({ env });
    const allowed = await app.request('/health', { headers: { Origin: 'https://licio.app' } });
    const malicious = await app.request('/health', {
      headers: { Origin: 'https://evil-licio.app' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://licio.app');
    expect(malicious.headers.get('access-control-allow-origin')).toBeNull();

    const rejectedPreflight = await app.request('/api/echo', {
      method: 'OPTIONS',
      headers: { Origin: 'https://licio.app.evil.com' },
    });
    expect(rejectedPreflight.status).toBe(403);
  });

  it('validates CSP reports without requiring CSRF tokens', async () => {
    const valid = await createApiApp({ env }).request('/api/csp-report', {
      method: 'POST',
      body: JSON.stringify({
        'csp-report': {
          'document-uri': 'https://licio.app/',
          'violated-directive': "script-src 'self'",
        },
      }),
    });
    expect(valid.status).toBe(204);
  });

  it('bounds and validates CSP report payloads before logging them', async () => {
    const app = createApiApp({ env });
    const oversized = await app.request('/api/csp-report', {
      method: 'POST',
      headers: { 'Content-Length': String(17 * 1024) },
      body: '{}',
    });
    expect(oversized.status).toBe(413);

    const malformed = await app.request('/api/csp-report', {
      method: 'POST',
      body: JSON.stringify({
        'csp-report': { 'document-uri': 'not a url', extra: 'not allowed' },
      }),
    });
    expect(malformed.status).toBe(400);
  });

  it('rejects state-changing requests without CSRF tokens', async () => {
    const response = await createApiApp({ env }).request('/api/echo', { method: 'POST' });
    expect(response.status).toBe(403);
  });

  it('accepts state-changing requests with a session-bound CSRF token', async () => {
    const app = createApiApp({ env });
    const tokenResponse = await app.request('/api/csrf-token');
    const { csrfToken } = (await tokenResponse.json()) as { csrfToken: string };
    const cookie = tokenResponse.headers.get('set-cookie');
    expect(cookie).toContain('__Host-licio-session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');

    const response = await app.request('/api/echo', {
      method: 'POST',
      headers: { Cookie: cookie ?? '', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(response.status).toBe(200);

    const replay = await app.request('/api/echo', {
      method: 'POST',
      headers: { Cookie: cookie ?? '', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ replay: true }),
    });
    expect(replay.status).toBe(403);
  });

  it('rate limits repeated CSP reports', async () => {
    const app = createApiApp({ env });
    let response = new Response();
    for (let index = 0; index < 31; index += 1) {
      response = await app.request('/api/csp-report', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({ 'csp-report': { 'violated-directive': "script-src 'self'" } }),
      });
    }
    expect(response.status).toBe(429);
  });
});
