// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.6 — the server-blind rendezvous endpoints (PRIVATE_SPEC §15.3, §15.4,
// §21.5, §27.2): `POST /v1/private-rendezvous/{announce,poll,signal,signal/poll}`.
// Every body is OPAQUE (blind ids + ciphertext + a short TTL) — the server can
// not map a record to a room/account/member/CID (§15.3.1).  Each endpoint:
//   • validates only the bounded WIRE SHAPE (never the content),
//   • is global-rate-limited (no client IP is ever read, §19.1),
//   • is CSRF-exempt (it carries no session — there is nothing for CSRF to ride;
//     abuse is bounded by the rate limit + TTL + size caps), and
//   • `poll` ALWAYS returns a bounded list (never 404) — the §15.3.1 no-existence-
//     oracle property.

import { type Context, Hono } from 'hono';
import { rateLimit } from '../lib/rate-limit.js';
import { getRendezvousService } from '../private-rendezvous/service.js';
import {
  announceRequestSchema,
  pollRequestSchema,
  signalPollRequestSchema,
  signalRequestSchema,
} from '../private-rendezvous/stores.js';

/** Reject a body larger than this before parsing (defense in depth with the
 *  per-field zod caps). */
const MAX_BODY_BYTES = 96 * 1024;

/** Sentinel for an over-cap body (distinguished from a malformed/empty `undefined`). */
const TOO_LARGE = Symbol('too_large');

/**
 * Read + JSON-parse the request body under a hard byte cap, enforced WHETHER OR
 * NOT `Content-Length` is present.  A declared length over the cap is rejected up
 * front; an undeclared (chunked) body is read from the stream and aborted the
 * moment it crosses the cap — so the advertised bound holds even when the client
 * omits `Content-Length`, instead of buffering+parsing the whole body first.
 */
async function readJsonBounded(c: Context, maxBytes: number): Promise<unknown | typeof TOO_LARGE> {
  const declared = c.req.header('content-length');
  if (declared !== undefined) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return TOO_LARGE;
  }
  const body = c.req.raw.body;
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  if (total === 0) return undefined;
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return undefined;
  }
}

export function createPrivateRendezvousRoutes() {
  const app = new Hono();

  // §15.3 announce — store a presence record (over-long/expired TTL rejected).
  app.post('/announce', rateLimit({ limit: 120, windowMs: 60_000 }), async (c) => {
    const body = await readJsonBounded(c, MAX_BODY_BYTES);
    if (body === TOO_LARGE) return c.json({ error: 'oversized_request' }, 413);
    const parsed = announceRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    // The server runs the §27 Tier-1 sample-poll only (the per-announcer cap is enforced
    // peer-side, PRIV-API-RENDEZVOUS-1); an announce is stored unless its TTL is out of bounds.
    const { stored, reason } = await getRendezvousService().announce(parsed.data);
    return c.json({ stored, ...(reason ? { reason } : {}) }, stored ? 202 : 200);
  });

  // §15.3 poll — read presence records for a room blind id.  ALWAYS 200 + a
  // (possibly empty) bounded list: no existence oracle (§15.3.1).
  app.post('/poll', rateLimit({ limit: 240, windowMs: 60_000 }), async (c) => {
    const body = await readJsonBounded(c, MAX_BODY_BYTES);
    if (body === TOO_LARGE) return c.json({ error: 'oversized_request' }, 413);
    const parsed = pollRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await getRendezvousService().poll(parsed.data.room_blind_id), 200);
  });

  // §15.4 signal — queue an opaque E2E-encrypted signaling blob for a recipient.
  app.post('/signal', rateLimit({ limit: 240, windowMs: 60_000 }), async (c) => {
    const body = await readJsonBounded(c, MAX_BODY_BYTES);
    if (body === TOO_LARGE) return c.json({ error: 'oversized_request' }, 413);
    const parsed = signalRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const { stored } = await getRendezvousService().signal(parsed.data);
    return c.json({ stored }, stored ? 202 : 200);
  });

  // §15.4 signal drain — return + DELETE the caller's queued signals (a state-
  // changing POST, like the LCAP signal drain).
  app.post('/signal/poll', rateLimit({ limit: 480, windowMs: 60_000 }), async (c) => {
    const body = await readJsonBounded(c, MAX_BODY_BYTES);
    if (body === TOO_LARGE) return c.json({ error: 'oversized_request' }, 413);
    const parsed = signalPollRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await getRendezvousService().drainSignals(parsed.data.peer_blind_id), 200);
  });

  return app;
}
