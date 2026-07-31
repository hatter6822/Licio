// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DoS bounds on the PUBLIC surfaces of `routes/stories.ts`.  `/v1/takedowns` is
// unauthenticated AND fully CSRF-exempt (WS-F.1.4f — a rights holder holds no
// account), which puts it in the same class as `/v1/telemetry` and
// `/api/security/csp-report`: the identity-free rate limit bounds request COUNT,
// and `bodyLimit` bounds BYTES on the stream.  The second bound is the one no
// schema can supply — `zValidator` buffers the whole body through `c.req.json()`
// before any field-length bound applies — so it is pinned here.
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { freshIngestionServices } from './ingestion-test-helpers.js';

beforeEach(() => {
  freshIngestionServices({ config: { minAccountAgeMinutes: 0 } });
});

const takedownBody = () => ({
  target_type: 'story' as const,
  target_id: '11111111-1111-4111-8111-111111111111',
  requester_contact: 'rights@example.com',
  legal_basis: 'copyright' as const,
  claim_detail: 'The story reproduces our copyrighted article in full.',
});

describe('POST /v1/takedowns body bounds (PUB-API-CORE-2)', () => {
  it('accepts a legitimate intake — the cap sits well above the schema maximum', async () => {
    const res = await createApp().request('http://localhost/v1/takedowns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(takedownBody()),
    });
    expect(res.status).toBe(202);
  });

  it('rejects an oversized body with 413 (declared Content-Length)', async () => {
    const res = await createApp().request('http://localhost/v1/takedowns', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '200000' },
      body: JSON.stringify(takedownBody()),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toStrictEqual({
      // The house `{ error: { code, message } }` envelope, not the flat shape
      // the telemetry endpoint uses — this router's header states the rule.
      error: { code: 'payload_too_large', message: 'Payload too large' },
    });
  });

  it('enforces the cap even WITHOUT a Content-Length (streamed/chunked body)', async () => {
    // A chunked body carries no Content-Length, so the cap must apply as the
    // stream is read.  Without it an unauthenticated caller buffers the entire
    // body into the Node heap before the schema ever inspects a field.
    const huge = 'x'.repeat(200_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    const res = await createApp().request('http://localhost/v1/takedowns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      // A streaming request body requires half-duplex per the Fetch standard.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(res.status).toBe(413);
  });
});
