// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-user sliding-window rate limiting for attention ingestion (WS-E.1.3c,
// SPEC §25.5/§19.1). True sliding windows (timestamped entries, not fixed
// buckets) prevent burst-at-boundary abuse. Keys carry a NON-REVERSIBLE
// account ref — never the raw user id and never any network address (§19.1).
//
// Fail-closed degradation: when the primary (Redis) store errors, the limiter
// falls back to an in-memory store at 50% of the configured limits — an outage
// tightens the gate, never opens it. Counters are operational state only: they
// are never persisted to the attention store and never logged with item
// identity.
//
// Retry-After math (exact): after recording the attempt there are `count`
// in-window entries e_0 <= … <= e_{count-1}. A future attempt at time T is
// admitted iff #{e : e > T − window} <= L − 1, i.e. at least count − L + 1 of
// the oldest entries have aged out, which first holds at
//   T = e_{count-L} + window      (k-th oldest with k = count − L).
// Denied attempts are recorded too (conservative: hammering extends the wait).

export interface SlidingWindowStore {
  /** Record one hit at `nowMs` and return the in-window count (incl. it). */
  hit(key: string, nowMs: number, windowMs: number): Promise<number>;
  /** The k-th oldest (0-based) in-window entry's timestamp, or null. */
  nthOldest(key: string, nowMs: number, windowMs: number, k: number): Promise<number | null>;
  clear(): Promise<void>;
}

/** Single-process sliding-window store (also the fail-closed fallback). */
export class InMemorySlidingWindowStore implements SlidingWindowStore {
  readonly #entries = new Map<string, number[]>();

  async hit(key: string, nowMs: number, windowMs: number): Promise<number> {
    const cutoff = nowMs - windowMs;
    const kept = (this.#entries.get(key) ?? []).filter((t) => t > cutoff);
    kept.push(nowMs);
    this.#entries.set(key, kept);
    return kept.length;
  }

  async nthOldest(key: string, nowMs: number, windowMs: number, k: number): Promise<number | null> {
    const cutoff = nowMs - windowMs;
    const inWindow = (this.#entries.get(key) ?? []).filter((t) => t > cutoff).sort((a, b) => a - b);
    return inWindow[k] ?? null;
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }
}

export interface IngestRateLimits {
  perMinute: number;
  perHour: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the next attempt can be admitted (when denied). */
  retryAfterSec: number;
  /** True when the decision came from the fail-closed fallback path. */
  degraded: boolean;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Exact retry-after (ms) for a set of VIOLATED sliding windows: the latest
 * time at which enough of the oldest entries have aged out of every violated
 * window (≥ 1 s floor). Shared by this limiter and the WS-F submission
 * limiter so the k-th-oldest math lives in ONE tested place. For a window of
 * length W with `count` in-window entries and limit `L`, a future attempt is
 * admitted once the (count − L)-th oldest entry ages out, at
 *   e_{count−L} + W. (Denied attempts are recorded too, so hammering extends
 * the wait — conservative by construction.)
 */
export async function slidingWindowRetryAfterMs(
  store: SlidingWindowStore,
  now: number,
  violated: ReadonlyArray<{ key: string; windowMs: number; count: number; limit: number }>,
): Promise<number> {
  let retryAfterMs = 1_000;
  for (const window of violated) {
    const anchor = await store.nthOldest(
      window.key,
      now,
      window.windowMs,
      window.count - window.limit,
    );
    retryAfterMs = Math.max(retryAfterMs, (anchor ?? now) + window.windowMs - now);
  }
  return retryAfterMs;
}

export class IngestRateLimiter {
  readonly #primary: SlidingWindowStore;
  readonly #fallback: SlidingWindowStore;
  readonly #limits: IngestRateLimits;
  readonly #onDegraded: (error: unknown) => void;

  constructor(
    primary: SlidingWindowStore,
    limits: IngestRateLimits,
    options: { fallback?: SlidingWindowStore; onDegraded?: (error: unknown) => void } = {},
  ) {
    if (!(limits.perMinute >= 1) || !(limits.perHour >= 1)) {
      throw new Error('rate limits must be >= 1');
    }
    this.#primary = primary;
    this.#fallback = options.fallback ?? new InMemorySlidingWindowStore();
    this.#limits = limits;
    this.#onDegraded = options.onDegraded ?? (() => {});
  }

  /** Check + record one ingestion attempt for the (non-reversible) user key. */
  async hit(userKey: string, now: number = Date.now()): Promise<RateDecision> {
    try {
      return await this.#decide(this.#primary, this.#limits, userKey, now, false);
    } catch (error) {
      this.#onDegraded(error);
      // Fail closed: conservative 50% limits on the in-memory fallback.
      const conservative: IngestRateLimits = {
        perMinute: Math.max(1, Math.floor(this.#limits.perMinute / 2)),
        perHour: Math.max(1, Math.floor(this.#limits.perHour / 2)),
      };
      return await this.#decide(this.#fallback, conservative, userKey, now, true);
    }
  }

  async #decide(
    store: SlidingWindowStore,
    limits: IngestRateLimits,
    userKey: string,
    now: number,
    degraded: boolean,
  ): Promise<RateDecision> {
    const minuteCount = await store.hit(`${userKey}:m`, now, MINUTE_MS);
    const hourCount = await store.hit(`${userKey}:h`, now, HOUR_MS);
    const violated: Array<{ key: string; windowMs: number; count: number; limit: number }> = [];
    if (minuteCount > limits.perMinute) {
      violated.push({
        key: `${userKey}:m`,
        windowMs: MINUTE_MS,
        count: minuteCount,
        limit: limits.perMinute,
      });
    }
    if (hourCount > limits.perHour) {
      violated.push({
        key: `${userKey}:h`,
        windowMs: HOUR_MS,
        count: hourCount,
        limit: limits.perHour,
      });
    }
    if (violated.length === 0) {
      return { allowed: true, retryAfterSec: 0, degraded };
    }
    const retryAfterMs = await slidingWindowRetryAfterMs(store, now, violated);
    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1_000), degraded };
  }

  async clear(): Promise<void> {
    await this.#primary.clear();
    await this.#fallback.clear();
  }
}
