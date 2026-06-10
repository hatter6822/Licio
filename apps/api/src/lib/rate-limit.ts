// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A GLOBAL fixed-window budget for unauthenticated endpoints (CSP reports,
// telemetry beacons, auth challenge/code minting, deletion-cancel).  This is
// deliberate privacy architecture, not a simplification (SPEC §19.1):
//
//   The application never reads, hashes, or keys ANY behavior on the client
//   network address — there is no per-IP state of any kind, so no network
//   identity ever enters the application boundary.  Abuse control is layered
//   instead as:
//     1. per-TARGET cooldowns (e.g. one email per mailbox per minute) keyed by
//        first-party resources we already hold,
//     2. per-ACCOUNT progressive lockouts for credential failures, and
//     3. this global per-endpoint budget — a pure, identity-free cost ceiling
//        that bounds what one process will spend on an endpoint per window.
//   Connection-level flood fairness (telling one flooding client apart from
//   everyone else) is the EDGE/gateway's job, where packet routing already
//   requires addresses; the application stays address-blind.
import type { MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
  /** Max requests served per window, process-wide (load shedding, not fairness). */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** Create a global fixed-window budget middleware (429 when exhausted). */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { limit, windowMs } = options;
  let count = 0;
  let resetAt = 0;

  return async (c, next) => {
    const now = Date.now();
    if (now >= resetAt) {
      count = 0;
      resetAt = now + windowMs;
    }
    if (count >= limit) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    count += 1;
    await next();
    return;
  };
}
