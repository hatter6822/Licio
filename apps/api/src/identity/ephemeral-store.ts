// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A short-lived, TTL'd key→value store for single-use authentication secrets:
// WebAuthn challenges (WS-D.1.2a), SIWE nonces (WS-D.1.4c), and email one-time
// codes (WS-D.1.4a/b).  In production this is Redis; in tests/CI it is the
// in-memory implementation below (the established TokenStore pattern).
//
// Every DECISION this store backs is made by one of its atomic primitives, not
// by a `get` the caller then acts on: in production the store is Redis, so a
// read and a write are two round trips with nothing between them, and every
// concurrent request observes the same pre-state and writes the same post-state.
// A bound enforced that way does not bound anything — it pins its own counter.
// So: `take` consumes exactly once, `setIfExists` cannot resurrect a consumed
// record, `setIfAbsent` claims a slot exactly once, and `increment` counts.
// `get` is for reading a record you are about to validate, never for a limit.

export interface EphemeralStore {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Atomically read and delete — single-use consumption. */
  take(key: string): Promise<string | null>;
  /** Set ONLY if the key is currently present (Redis `SET … XX`); returns whether
   *  it wrote.  Used so an update to a single-use record cannot RESURRECT one a
   *  concurrent `take` already consumed — the write no-ops when the key is gone. */
  setIfExists(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Set ONLY if the key is currently ABSENT (Redis `SET … NX`); returns whether
   *  it wrote.  The exact inverse of `setIfExists`, and the primitive for a
   *  claim-once cooldown: exactly one of N concurrent callers gets `true`. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /**
   * Atomically increment an integer counter and return the NEW value.
   *
   * The expiry is armed only when the counter is CREATED, so the window runs
   * from the first increment — a fixed window.  Refreshing it on every call
   * (which a plain `set` does) lets a caller hold its own window open
   * indefinitely, so the block outlives the burst that caused it and the
   * legitimate owner of the key stays locked out long after.
   */
  increment(key: string, ttlMs: number): Promise<number>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

interface Entry {
  value: string;
  expiresAt: number;
}

export class InMemoryEphemeralStore implements EphemeralStore {
  readonly #map = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.#map.set(key, { value, expiresAt: this.#now() + ttlMs });
  }

  async setIfExists(key: string, value: string, ttlMs: number): Promise<boolean> {
    // Read + conditional write with no intervening await: if the key was already
    // consumed (taken/deleted/expired) this no-ops, so it can never resurrect it.
    const entry = this.#map.get(key);
    if (!entry || entry.expiresAt <= this.#now()) {
      this.#map.delete(key);
      return false;
    }
    this.#map.set(key, { value, expiresAt: this.#now() + ttlMs });
    return true;
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    // Read + conditional write with no intervening await: exactly one of N
    // concurrent callers observes the key absent and writes it.
    const entry = this.#map.get(key);
    if (entry && entry.expiresAt > this.#now()) return false;
    this.#map.set(key, { value, expiresAt: this.#now() + ttlMs });
    return true;
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    // Read + write with no intervening await, so two concurrent increments
    // cannot both observe the same count (mirrors Redis INCR).
    const now = this.#now();
    const entry = this.#map.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.#map.set(key, { value: '1', expiresAt: now + ttlMs });
      return 1;
    }
    // Total on a non-numeric value (Redis INCR would error): restart the count
    // rather than propagate NaN into a comparison that would then admit
    // everything.
    const previous = Number(entry.value);
    const next = Number.isInteger(previous) && previous >= 0 ? previous + 1 : 1;
    // `expiresAt` is CARRIED, not recomputed — the fixed window documented on
    // the interface.
    this.#map.set(key, { value: String(next), expiresAt: entry.expiresAt });
    return next;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.#map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) {
      this.#map.delete(key);
      return null;
    }
    return entry.value;
  }

  async take(key: string): Promise<string | null> {
    // Read AND delete with no intervening await so two concurrent takes can
    // never both observe the entry — a single-use secret is consumed once
    // (mirrors Redis GETDEL).  Preserves get()'s expiry semantics.
    const entry = this.#map.get(key);
    this.#map.delete(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) return null;
    return entry.value;
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }

  async clear(): Promise<void> {
    this.#map.clear();
  }
}
