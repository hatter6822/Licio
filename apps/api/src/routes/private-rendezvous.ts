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

import { Hono } from 'hono';
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

function tooLarge(contentLength: string | undefined): boolean {
  if (contentLength === undefined) return false;
  const n = Number(contentLength);
  return Number.isFinite(n) && n > MAX_BODY_BYTES;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createPrivateRendezvousRoutes() {
  const app = new Hono();

  // §15.3 announce — store a presence record (TTL clamped server-side).
  app.post('/announce', rateLimit({ limit: 120, windowMs: 60_000 }), async (c) => {
    if (tooLarge(c.req.header('content-length')))
      return c.json({ error: 'oversized_request' }, 413);
    const parsed = announceRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const { stored } = await getRendezvousService().announce(parsed.data);
    return c.json({ stored }, stored ? 202 : 200);
  });

  // §15.3 poll — read presence records for a room blind id.  ALWAYS 200 + a
  // (possibly empty) bounded list: no existence oracle (§15.3.1).
  app.post('/poll', rateLimit({ limit: 240, windowMs: 60_000 }), async (c) => {
    if (tooLarge(c.req.header('content-length')))
      return c.json({ error: 'oversized_request' }, 413);
    const parsed = pollRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await getRendezvousService().poll(parsed.data.room_blind_id), 200);
  });

  // §15.4 signal — queue an opaque E2E-encrypted signaling blob for a recipient.
  app.post('/signal', rateLimit({ limit: 240, windowMs: 60_000 }), async (c) => {
    if (tooLarge(c.req.header('content-length')))
      return c.json({ error: 'oversized_request' }, 413);
    const parsed = signalRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const { stored } = await getRendezvousService().signal(parsed.data);
    return c.json({ stored }, stored ? 202 : 200);
  });

  // §15.4 signal drain — return + DELETE the caller's queued signals (a state-
  // changing POST, like the LCAP signal drain).
  app.post('/signal/poll', rateLimit({ limit: 480, windowMs: 60_000 }), async (c) => {
    if (tooLarge(c.req.header('content-length')))
      return c.json({ error: 'oversized_request' }, 413);
    const parsed = signalPollRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await getRendezvousService().drainSignals(parsed.data.peer_blind_id), 200);
  });

  return app;
}
