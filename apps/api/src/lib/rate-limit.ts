// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A small per-IP fixed-window rate limiter for unauthenticated ingest endpoints
// (CSP reports, telemetry beacons). These are CSRF-exempt and can be POSTed
// cross-origin, so they need their own DoS bound. In-memory and best-effort —
// production fronts the BFF with an edge/gateway limiter; this is defence in
// depth. The entry map is capped and swept so it cannot grow unbounded.
import type { MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
  /** Max requests per IP per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max distinct IPs tracked before eviction kicks in (memory bound). */
  maxEntries?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Create a per-IP fixed-window rate-limit middleware (429 when exceeded). */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { limit, windowMs, maxEntries = 10_000 } = options;
  const buckets = new Map<string, Bucket>();

  const evictExpired = (now: number): void => {
    for (const [ip, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(ip);
    }
  };

  const timer = setInterval(() => evictExpired(Date.now()), windowMs);
  // Don't keep the event loop alive for the sweeper (tests/CLI).
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();

  return async (c, next) => {
    const ip = c.req.header('x-forwarded-for') ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(ip);

    if (bucket && now < bucket.resetAt) {
      if (bucket.count >= limit) {
        return c.json({ error: 'Rate limit exceeded' }, 429);
      }
      bucket.count += 1;
    } else {
      if (buckets.size >= maxEntries) {
        evictExpired(now);
        if (buckets.size >= maxEntries) {
          // Still full of live entries — shed load rather than grow unbounded.
          return c.json({ error: 'Rate limit exceeded' }, 429);
        }
      }
      buckets.set(ip, { count: 1, resetAt: now + windowMs });
    }

    await next();
  };
}
