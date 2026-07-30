// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The terminal error handler (`app.onError`).  Without one, Hono's built-in
// default runs `console.error(err)` — outside pino's redaction, on the richest
// payload the process ever prints — and answers `text/plain "Internal Server
// Error"`, which is not the `apiErrorSchema` contract the web client parses.
// Both properties are asserted here because both regress silently: a missing
// handler produces a 500 either way, and only the BODY and the LOG DESTINATION
// tell the two apart.
import { apiErrorSchema } from '@licio/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../app.js';
import { createApp } from '../app.js';
import { errorHandler } from '../middleware/error-handler.js';

describe('the BFF terminal error handler', () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    for (const method of ['error', 'log', 'warn', 'info', 'debug'] as const) {
      consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
    }
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
    consoleSpies.length = 0;
  });

  /** A throwing route mounted behind the real app's middleware stack. */
  function appThatThrows(error: unknown) {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.get('/boom', () => {
      throw error;
    });
    return app;
  }

  it('answers an uncaught throw in the API error contract, not text/plain', async () => {
    const res = await appThatThrows(new Error('boom')).request('/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body: unknown = await res.json();
    // The shape the client's interceptor parses; a `text/plain` body fails here.
    expect(apiErrorSchema.parse(body).error.code).toBe('internal_error');
  });

  it('never echoes the thrown error message to the client', async () => {
    // A thrown message routinely carries a SQL fragment, a file path or an
    // upstream URL. `select * from users where email = 'a@b.c'` reaching a
    // response body is a disclosure, not a diagnostic.
    const leaky = new Error("select * from users where email = 'victim@example.com'");
    const res = await appThatThrows(leaky).request('/boom');
    const text = await res.text();
    expect(text).not.toContain('victim@example.com');
    expect(text).not.toContain('select *');
  });

  it('does NOT write to console — the redaction path is pino only', async () => {
    await appThatThrows(new Error('boom')).request('/boom');
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('honours a deliberate HTTPException rather than flattening it to 500', async () => {
    const res = await appThatThrows(
      new HTTPException(413, { message: 'Payload too large' }),
    ).request('/boom');
    expect(res.status).toBe(413);
  });

  it('serializes a BARE HTTPException into the API error contract, not plain text', async () => {
    // Asserting the status alone is what let this through: Hono's own
    // `getResponse()` for a bare exception returns PLAIN TEXT, so the client's
    // `normalizeError` could not parse it, fell back to `http_413`, and threw
    // away the deliberate refusal message — the response-shape problem this
    // handler exists to eliminate, in the one branch that looked already right.
    const res = await appThatThrows(
      new HTTPException(413, { message: 'Payload too large' }),
    ).request('/boom');
    expect(res.headers.get('content-type')).toContain('application/json');
    const parsed = apiErrorSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The status maps to the spelling the rest of the API already uses for it,
    // so a client `switch` sees one vocabulary wherever the refusal came from.
    // `payload_too_large` — the spelling `stories.ts`/`forum.ts` already use for
    // this condition.  `oversized_request` lives only in the LCAP
    // `{error: '<string>'}` envelope, which is not `apiErrorSchema`, so mapping
    // 413 to it gave the one condition the docstring cites as its example TWO
    // spellings.
    expect(parsed.data.error.code).toBe('payload_too_large');
    expect(parsed.data.error.message).toBe('Payload too large');
  });

  it('passes a route-supplied response through UNCHANGED', async () => {
    // A route that built its own body already chose its shape; the handler must
    // not second-guess it.
    const custom = new Response(JSON.stringify({ error: { code: 'teapot', message: 'no' } }), {
      status: 418,
      headers: { 'content-type': 'application/json' },
    });
    const res = await appThatThrows(new HTTPException(418, { res: custom })).request('/boom');
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: { code: 'teapot', message: 'no' } });
  });

  it('falls back to http_<status> for an unmapped status rather than inventing one', async () => {
    // Honest: that is exactly the code the client would have derived itself, so
    // an unmapped status degrades to the old behaviour instead of to a code no
    // consumer has ever heard of.
    const res = await appThatThrows(
      new HTTPException(402, { message: 'Payment required' }),
    ).request('/boom');
    expect(res.status).toBe(402);
    const parsed = apiErrorSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.error.code).toBe('http_402');
  });

  it('is REGISTERED by createApp, not merely exported', async () => {
    // A handler that exists but is never installed protects nothing, and no
    // ordinary probe distinguishes the two: every reachable route either
    // succeeds or refuses deliberately, so the default handler only shows
    // itself when something genuinely breaks.  Hang a throwing route off the
    // REAL app so the handler under test is the one `createApp` installed.
    const app = createApp();
    app.get('/__throws-for-this-test', () => {
      throw new Error('boom');
    });
    const res = await app.request('/__throws-for-this-test');
    expect(res.status).toBe(500);
    expect(await res.clone().text()).not.toBe('Internal Server Error');
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('internal_error');
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("the NOT-FOUND half of Hono's default", () => {
  // The error handler had repaired one half of Hono's two-line default and left
  // the other: `app.notFound` was registered nowhere, so `c.text('404 Not Found',
  // 404)` shipped.  `normalizeError` safe-parses the body against
  // `apiErrorSchema`, fails, and falls back to `http_404` plus the bare status
  // text — verbatim the failure mode this module's header says it exists to remove.
  it('answers an UNMATCHED path in the API error contract, not plain text', async () => {
    const res = await createApp().request('/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const parsed = apiErrorSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.error.code).toBe('not_found');
  });

  it('answers a WRONG METHOD on an existing path the same way', async () => {
    // Hono routes by method, so this reaches the not-found handler too — and it is
    // the shape a client is most likely to hit by accident.  A SAFE method on a
    // POST-only path: a mutation method would be refused 403 by the CSRF
    // middleware before routing ever ran, which tests the wrong thing.
    const res = await createApp().request('/v1/telemetry');
    expect(res.status).toBe(404);
    const parsed = apiErrorSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
  });
});
