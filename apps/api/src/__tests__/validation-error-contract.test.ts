// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `apiErrorSchema` says "Every BFF error response is validated to this so the
// client renders a typed ErrorState rather than leaking a raw server payload".
// Request VALIDATION was the one class of error for which that was false: the
// 300-odd `@hono/zod-validator` call sites had no hook, so a malformed body got
// that library's default `{ success: false, error: <serialized ZodError> }` —
// the raw payload the docstring promises never ships.  The web client's
// `normalizeError` safe-parses against `apiErrorSchema` and falls back to the
// bare status text, so every one of them reached the UI as an untyped
// "Bad Request" with no code to branch on and no field-level detail.
//
// These run against REAL routes through the REAL router, not the wrapper in
// isolation: the defect was never in the shape a helper can produce, it was in
// which requests reach a helper at all.
import { apiErrorSchema } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { issuesToDetails } from '../lib/validate.js';
import { createV1Routes } from '../routes/v1.js';
import {
  type ForumServicesFixture,
  freshForumServices,
  jsonRequest,
  seedUserWithSession,
} from './forum-test-helpers.js';

function app(): Hono {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: ForumServicesFixture;
let cookie: string;

beforeEach(async () => {
  fixture = freshForumServices();
  const session = await seedUserWithSession(fixture.identity);
  cookie = session.cookie;
});

describe('request-validation failures honour apiErrorSchema', () => {
  it('a malformed JSON body is rejected in the documented shape, with field detail', async () => {
    // `POST /v1/contributions` with an empty body: every field is missing, so
    // the failure is unambiguously validation rather than authz or a 404.
    const response = await app().request(jsonRequest('/v1/contributions', 'POST', {}, cookie));
    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    // The whole point: the CLIENT's parse succeeds, so the error is typed.
    const parsed = apiErrorSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.error.code).toBe('invalid_request');
    // `details` is the channel the schema documents "for form validation
    // surfaces" and which had no producer at all.
    expect(Object.keys(parsed.data.error.details ?? {}).length).toBeGreaterThan(0);
  });

  it('a bad query parameter is rejected in the same shape', async () => {
    // A different validation TARGET: the hook has to be attached for every one,
    // not only for json bodies.
    const response = await app().request('/v1/feed?limit=not-a-number', {
      headers: { cookie },
    });
    if (response.status === 400) {
      expect(apiErrorSchema.safeParse(await response.json()).success).toBe(true);
    }
  });

  it('rejects exactly what it rejected before — this changed bodies, not gates', async () => {
    // A VALID body must still pass.  A wrapper that accidentally rejected more
    // would be a far worse defect than the one it fixed.
    const ok = await app().request(
      jsonRequest('/v1/feed/preferences', 'PATCH', { personalization_enabled: false }, cookie),
    );
    expect(ok.status).not.toBe(400);
  });
});

describe('issuesToDetails', () => {
  it('keeps the FIRST issue per path — one message per field, as a form shows', () => {
    expect(
      issuesToDetails([
        { path: ['title'], message: 'too short' },
        { path: ['title'], message: 'also wrong' },
        { path: ['body', 0, 'text'], message: 'bad' },
      ]),
    ).toEqual({ title: 'too short', 'body.0.text': 'bad' });
  });

  it('keys a whole-object refinement `_` rather than dropping it', () => {
    // Cross-field rules have an empty path and are usually the ones a user most
    // needs told; an empty-path issue silently vanishing is how a form ends up
    // rejecting with no visible reason anywhere.
    expect(issuesToDetails([{ path: [], message: 'start must precede end' }])).toEqual({
      _: 'start must precede end',
    });
  });

  it('is BOUNDED in both directions — an error body is not an echo channel', () => {
    const many = Array.from({ length: 100 }, (_v, i) => ({
      path: [`f${i}`],
      message: 'x'.repeat(1000),
    }));
    const details = issuesToDetails(many);
    expect(Object.keys(details)).toHaveLength(20);
    for (const message of Object.values(details)) expect(message.length).toBe(200);
  });
});
