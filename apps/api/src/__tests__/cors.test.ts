// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

describe('CORS', () => {
  const app = createApp();

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
});
