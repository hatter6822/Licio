// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The global fixed-window budget is deliberately IDENTITY-FREE (SPEC §19.1):
// it reads nothing about the requester — no IP, no headers — so the tests
// assert pure process-wide counting and the Retry-After contract.
import { apiErrorSchema } from '@licio/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { perAccountRateLimit, rateLimit } from '../lib/rate-limit.js';

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

describe('perAccountRateLimit (the abuse budget, not the load-shedding ceiling)', () => {
  /** An app whose "account" comes from a header, standing in for the auth
   *  context — still identity-free in the §19.1 sense: an account id is a
   *  first-party resource, never a network address. */
  function appWith(limit: number) {
    return new Hono()
      .use(
        '*',
        perAccountRateLimit({
          limit,
          windowMs: 60_000,
          accountId: (c) => c.req.header('x-test-account') ?? null,
        }),
      )
      .get('/', (c) => c.text('ok'));
  }
  const asAccount = (app: Hono, account: string) =>
    app.request('/', { headers: { 'x-test-account': account } });

  it('one account exhausting its budget does NOT lock out another', async () => {
    // The whole point.  A single global window counts every caller into one
    // bucket, so one authenticated account could spend the entire allowance —
    // with invalid bodies too, since a limiter runs before validation — and
    // every other user would receive 429 for the rest of the window.  For an
    // authenticated abuse budget that lets one reporter disable a feature
    // platform-wide, which is worse than the unbounded writes it guards.
    const app = appWith(2);
    expect((await asAccount(app, 'noisy')).status).toBe(200);
    expect((await asAccount(app, 'noisy')).status).toBe(200);
    expect((await asAccount(app, 'noisy')).status).toBe(429);
    // The quiet account still has its full budget.
    expect((await asAccount(app, 'quiet')).status).toBe(200);
    expect((await asAccount(app, 'quiet')).status).toBe(200);
    expect((await asAccount(app, 'quiet')).status).toBe(429);
  });

  it('answers 429 in the shared apiErrorSchema shape with Retry-After', async () => {
    const app = appWith(0);
    const res = await asAccount(app, 'anyone');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const parsed = apiErrorSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.error.code).toBe('rate_limited');
  });

  it('passes through when there is no account to bill', async () => {
    // Such a route is either unauthenticated — the global limiter is its
    // budget — or the auth middleware has already refused it.  Charging an
    // absent account to a shared bucket would rebuild the very thing this
    // limiter replaces.
    const app = appWith(0);
    expect((await app.request('/')).status).toBe(200);
  });

  it('resets per window rather than accumulating forever', async () => {
    let now = 1_000;
    const app = new Hono()
      .use(
        '*',
        perAccountRateLimit({
          limit: 1,
          windowMs: 60_000,
          now: () => now,
          accountId: (c) => c.req.header('x-test-account') ?? null,
        }),
      )
      .get('/', (c) => c.text('ok'));
    expect((await asAccount(app, 'a')).status).toBe(200);
    expect((await asAccount(app, 'a')).status).toBe(429);
    now += 60_001;
    expect((await asAccount(app, 'a')).status).toBe(200);
  });
});
