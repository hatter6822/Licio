// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createLogger } from '../lib/logger.js';

describe('Logger', () => {
  it('should create a logger with the specified level', () => {
    const logger = createLogger('warn');
    expect(logger.level).toBe('warn');
  });

  it('should default to info level', () => {
    const logger = createLogger();
    expect(logger.level).toBe('info');
  });

  it('should redact sensitive fields', () => {
    const chunks: string[] = [];
    const dest = {
      write: (s: string) => {
        chunks.push(s);
      },
    };
    const logger = createLogger('info', dest);
    logger.info(
      {
        token: 't',
        secret: 's',
        apiKey: 'k',
        privateKey: 'pk',
        seedPhrase: 'sp',
        mnemonic: 'mn',
        password: 'pw',
        req: { headers: { authorization: 'Bearer x', cookie: 'sid=1' } },
        res: { headers: { 'set-cookie': 'sid=1' } },
      },
      'msg',
    );
    const line: Record<string, unknown> = JSON.parse(chunks.at(-1) ?? '{}');

    expect(line['token']).toBe('[REDACTED]');
    expect(line['secret']).toBe('[REDACTED]');
    expect(line['apiKey']).toBe('[REDACTED]');
    expect(line['privateKey']).toBe('[REDACTED]');
    expect(line['seedPhrase']).toBe('[REDACTED]');
    expect(line['mnemonic']).toBe('[REDACTED]');
    expect(line['password']).toBe('[REDACTED]');

    const req = line['req'] as { headers: Record<string, unknown> };
    expect(req.headers['authorization']).toBe('[REDACTED]');
    expect(req.headers['cookie']).toBe('[REDACTED]');

    // This assertion catches a typo in the bracketed 'res.headers["set-cookie"]' path.
    const res = line['res'] as { headers: Record<string, unknown> };
    expect(res.headers['set-cookie']).toBe('[REDACTED]');
  });
});

describe('Logger middleware', () => {
  it('echoes a valid client X-Request-ID', async () => {
    const app = createApp();
    const clientId = '550e8400-e29b-41d4-a716-446655440000';
    const res = await app.request('/health', {
      headers: { 'X-Request-ID': clientId },
    });
    expect(res.headers.get('X-Request-ID')).toBe(clientId);
  });

  it('generates a new ID when client X-Request-ID is not a valid UUID', async () => {
    const app = createApp();
    const res = await app.request('/health', {
      headers: { 'X-Request-ID': 'not-a-uuid' },
    });
    const id = res.headers.get('X-Request-ID');
    expect(id).toBeDefined();
    expect(id).not.toBe('not-a-uuid');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('generates a new ID when no X-Request-ID is provided', async () => {
    const app = createApp();
    const res = await app.request('/health');
    const id = res.headers.get('X-Request-ID');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('handles requests with content-length header', async () => {
    const app = createApp();
    const res = await app.request('/health', {
      headers: { 'Content-Length': '42' },
    });
    expect(res.status).toBe(200);
  });

  it('handles requests with user-agent header', async () => {
    const app = createApp();
    const res = await app.request('/health', {
      headers: { 'User-Agent': 'test-agent/1.0' },
    });
    expect(res.status).toBe(200);
  });
});
