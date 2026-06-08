// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { _tokenStore, setSessionCookie } from '../middleware/csrf.js';

describe('CSRF protection', () => {
  afterEach(() => {
    _tokenStore.clear();
  });

  it('allows GET requests without a CSRF token', async () => {
    const app = createApp();
    const res = await app.request('/health', { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('rejects POST without a session cookie', async () => {
    const app = createApp();
    const res = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('rejects POST without a CSRF token', async () => {
    const app = createApp();
    const res = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=test-session-id',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('CSRF token required');
  });

  it('issues and accepts a valid CSRF token', async () => {
    const app = createApp();

    const tokenRes = await app.request('/api/csrf-token', {
      method: 'GET',
      headers: { Cookie: '__Host-session=session-abc' },
    });
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    expect(token).toBeDefined();
    expect(token.length).toBe(64);

    const postRes = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=session-abc',
        'X-CSRF-Token': token,
      },
      body: '{}',
    });
    expect(postRes.status).not.toBe(403);
  });

  it('rejects a token from a different session', async () => {
    const app = createApp();

    const tokenRes = await app.request('/api/csrf-token', {
      method: 'GET',
      headers: { Cookie: '__Host-session=session-one' },
    });
    const { token } = (await tokenRes.json()) as { token: string };

    const postRes = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=session-two',
        'X-CSRF-Token': token,
      },
      body: '{}',
    });
    expect(postRes.status).toBe(403);
    const body = (await postRes.json()) as { error: string };
    expect(body.error).toMatch(/CSRF token/);
  });

  it('rejects an invalid CSRF token', async () => {
    const app = createApp();

    await app.request('/api/csrf-token', {
      method: 'GET',
      headers: { Cookie: '__Host-session=session-xyz' },
    });

    const postRes = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=session-xyz',
        'X-CSRF-Token': 'a'.repeat(64),
      },
      body: '{}',
    });
    expect(postRes.status).toBe(403);
    const body = (await postRes.json()) as { error: string };
    expect(body.error).toBe('CSRF token invalid');
  });

  it('exempts the CSP report endpoint from CSRF', async () => {
    const app = createApp();
    const res = await app.request('/api/security/csp-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': {} }),
    });
    expect(res.status).not.toBe(403);
  });

  it('exempts the health endpoint from CSRF', async () => {
    const app = createApp();
    const res = await app.request('/health', { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('consumes tokens after use (single-use)', async () => {
    const app = createApp();

    const tokenRes = await app.request('/api/csrf-token', {
      method: 'GET',
      headers: { Cookie: '__Host-session=session-reuse' },
    });
    const { token } = (await tokenRes.json()) as { token: string };

    await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=session-reuse',
        'X-CSRF-Token': token,
      },
      body: '{}',
    });

    const replayRes = await app.request('/api/csrf-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-session=session-reuse',
        'X-CSRF-Token': token,
      },
      body: '{}',
    });
    expect(replayRes.status).toBe(403);
  });

  it('generates the correct session cookie attributes', () => {
    const cookie = setSessionCookie('abc123');
    expect(cookie).toContain('__Host-session=abc123');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=');
  });

  it('rejects GET to csrf-token without a session', async () => {
    const app = createApp();
    const res = await app.request('/api/csrf-token', { method: 'GET' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('No session');
  });
});
