// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The global fixed-window budget is deliberately IDENTITY-FREE (SPEC §19.1):
// it reads nothing about the requester — no IP, no headers — so the tests
// assert pure process-wide counting and the Retry-After contract.
import { apiErrorSchema } from '@licio/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { rateLimit } from '../lib/rate-limit.js';

function appWith(limit: number) {
  return new Hono().use('*', rateLimit({ limit, windowMs: 60_000 })).get('/', (c) => c.text('ok'));
}

describe('rateLimit (global, identity-free)', () => {
  it('serves up to the budget then returns 429 with Retry-After', async () => {
    const app = appWith(2);
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(200);
    const limited = await app.request('/');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('returns the apiErrorSchema shape with the shared `rate_limited` code', async () => {
    // The client switches on `error.code` (the sign-in page's `rate_limited`
    // branch), so a bare `{ error: 'string' }` here would fall through to the
    // raw HTTP status text — and would be a SECOND shape for the same failure
    // the in-handler limiters on the very same auth routes already report.
    const app = appWith(0);
    const limited = await app.request('/');
    expect(limited.status).toBe(429);
    const body: unknown = await limited.json();
    expect(apiErrorSchema.parse(body).error.code).toBe('rate_limited');
  });

  it('counts globally — requests are never distinguished by client identity', async () => {
    const app = appWith(1);
    // Two requests carrying different forwarded addresses share ONE budget:
    // the limiter is blind to who is asking.
    expect((await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } })).status).toBe(
      200,
    );
    expect((await app.request('/', { headers: { 'x-forwarded-for': '5.6.7.8' } })).status).toBe(
      429,
    );
  });

  it('resets the count once the window elapses (injectable clock)', async () => {
    let t = 0;
    const app = new Hono()
      .use('*', rateLimit({ limit: 1, windowMs: 60_000, now: () => t }))
      .get('/', (c) => c.text('ok'));
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(429);
    t = 60_000;
    expect((await app.request('/')).status).toBe(200);
  });

  it('each limiter instance has its own independent budget', async () => {
    const a = appWith(1);
    const b = appWith(1);
    expect((await a.request('/')).status).toBe(200);
    expect((await b.request('/')).status).toBe(200);
    expect((await a.request('/')).status).toBe(429);
  });
});
