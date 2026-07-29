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
import type { ApiError } from '@licio/shared';
import type { MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
  /** Max requests served per window, process-wide (load shedding, not fairness). */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
}

/** Create a global fixed-window budget middleware (429 when exhausted). */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { limit, windowMs, now: clock = () => Date.now() } = options;
  let count = 0;
  let resetAt = 0;

  return async (c, next) => {
    const now = clock();
    if (now >= resetAt) {
      count = 0;
      resetAt = now + windowMs;
    }
    if (count >= limit) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
      // The `apiErrorSchema` shape, and the SAME `rate_limited` code the
      // in-handler limiters return (e.g. auth.ts's per-target cooldowns): the
      // client switches on `error.code`, so a bare string here would leave the
      // sign-in page rendering a raw "Too Many Requests" instead of its
      // localised copy — two shapes for one class of failure on one route.
      return c.json(
        {
          error: { code: 'rate_limited', message: 'Too many attempts. Try again later.' },
        } satisfies ApiError,
        429,
      );
    }
    count += 1;
    await next();
    return;
  };
}

/** Max distinct accounts tracked in one window before the map is reset.
 *  A bound, not a target: the map is per-endpoint and per-window, and a limiter
 *  that can grow without one is itself the memory-exhaustion vector it exists
 *  to prevent. */
const MAX_TRACKED_ACCOUNTS = 10_000;

export interface PerAccountRateLimitOptions extends RateLimitOptions {
  /** Read the authenticated account id; return null to skip (unauthenticated
   *  routes have no account to bill and belong on the global limiter). */
  accountId: (c: Parameters<MiddlewareHandler>[0]) => string | null;
}

/**
 * A per-ACCOUNT fixed-window budget (SPEC §19.1's first sanctioned form).
 *
 * The global limiter above is a load-shedding CEILING, not fairness: it counts
 * every caller into one bucket, so a single authenticated account can spend the
 * whole allowance — with invalid bodies too, since the limiter runs before
 * validation — and every other user receives 429 for the rest of the window.
 * For an authenticated abuse budget that is the wrong shape: it lets one
 * reporter disable a feature platform-wide.
 *
 * Keyed on the ACCOUNT, never the network address: the account id is a
 * first-party resource we already hold, so this stays inside the address-blind
 * architecture the module header describes.  Pair it with a generous global
 * ceiling when load shedding is also wanted — the two answer different
 * questions.
 */
export function perAccountRateLimit(options: PerAccountRateLimitOptions): MiddlewareHandler {
  const { limit, windowMs, accountId, now: clock = () => Date.now() } = options;
  let counts = new Map<string, number>();
  let resetAt = 0;

  return async (c, next) => {
    const now = clock();
    if (now >= resetAt) {
      counts = new Map();
      resetAt = now + windowMs;
    }
    const account = accountId(c);
    // No account ⇒ nothing to bill fairly.  Passing through is correct rather
    // than lenient: such a route is either unauthenticated (the global limiter
    // is its budget) or the auth middleware has already refused it.
    if (account === null) {
      await next();
      return;
    }
    // Shed the whole window rather than grow without bound.  Losing a window's
    // counts is a smaller failure than an unbounded map, and the global ceiling
    // still applies underneath.
    if (counts.size >= MAX_TRACKED_ACCOUNTS && !counts.has(account)) {
      counts = new Map();
      resetAt = now + windowMs;
    }
    const spent = counts.get(account) ?? 0;
    if (spent >= limit) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
      return c.json(
        {
          error: { code: 'rate_limited', message: 'Too many attempts. Try again later.' },
        } satisfies ApiError,
        429,
      );
    }
    counts.set(account, spent + 1);
    await next();
    return;
  };
}
