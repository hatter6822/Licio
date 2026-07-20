// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A short-lived, TTL'd key→value store for single-use authentication secrets:
// WebAuthn challenges (WS-D.1.2a), SIWE nonces (WS-D.1.4c), and email one-time
// codes (WS-D.1.4a/b).  In production this is Redis; in tests/CI it is the
// in-memory implementation below (the established TokenStore pattern).
//
// `take` is the single-use primitive: it atomically reads AND deletes, so a
// challenge/nonce/code can be consumed exactly once even under concurrency.

export interface EphemeralStore {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Atomically read and delete — single-use consumption. */
  take(key: string): Promise<string | null>;
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
