// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

const app = createApp();

describe('CSP report endpoint', () => {
  it('accepts a valid CSP violation report', async () => {
    const report = {
      'csp-report': {
        'document-uri': 'https://example.com',
        'violated-directive': "script-src 'self'",
        'blocked-uri': 'https://evil.com/script.js',
      },
    };

    const res = await app.request('/api/security/csp-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: JSON.stringify(report),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);
  });

  it('also accepts application/reports+json content type', async () => {
    const report = { 'csp-report': {} };
    const res = await app.request('/api/security/csp-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/reports+json' },
      body: JSON.stringify(report),
    });

    expect(res.status).toBe(200);
  });

  it('rejects invalid content type', async () => {
    const res = await app.request('/api/security/csp-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid content type');
  });

  it('rejects payloads exceeding 10KB', async () => {
    const largeBody = JSON.stringify({ 'csp-report': { data: 'x'.repeat(11_000) } });
    const res = await app.request('/api/security/csp-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: largeBody,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Payload too large');
  });

  it('rejects invalid JSON', async () => {
    const res = await app.request('/api/security/csp-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: 'not json{{{',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid JSON');
  });

  it('rejects non-object JSON body', async () => {
    const res = await app.request('/api/security/csp-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: '"just a string"',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid report format');
  });
});
