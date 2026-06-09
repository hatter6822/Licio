// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { rateLimit } from '../lib/rate-limit.js';

function appWith(limit: number) {
  return new Hono().use('*', rateLimit({ limit, windowMs: 60_000 })).get('/', (c) => c.text('ok'));
}

const from = (ip: string) => ({ headers: { 'x-forwarded-for': ip } });

describe('rateLimit', () => {
  it('allows up to the limit then returns 429', async () => {
    const app = appWith(2);
    expect((await app.request('/', from('1.2.3.4'))).status).toBe(200);
    expect((await app.request('/', from('1.2.3.4'))).status).toBe(200);
    expect((await app.request('/', from('1.2.3.4'))).status).toBe(429);
  });

  it('tracks the window per IP', async () => {
    const app = appWith(1);
    expect((await app.request('/', from('a'))).status).toBe(200);
    expect((await app.request('/', from('b'))).status).toBe(200); // a different IP is independent
    expect((await app.request('/', from('a'))).status).toBe(429);
  });
});
