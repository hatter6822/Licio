// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Replay protection (WS-E.1.3b, SPEC §25.5 "forged attention events"). Two
// layers:
//   1. the FAST layer here — a single-use nonce set with a TTL covering the
//      acceptance window (keys are user-scoped, so cross-user collisions are
//      impossible and the set never becomes an attention-history store);
//   2. the DURABLE backstop — the event store's event_id uniqueness, which
//      rejects a replayed event even after the nonce TTL lapses.
// Nonce keys carry a non-reversible account ref, never the raw user id.

/** Nonce TTL: events older than the acceptance window are rejected anyway. */
export const NONCE_TTL_MS = 10 * 60_000;

export interface ReplayNonceStore {
  /**
   * Record `key` if unseen. True ⇒ first use (proceed); false ⇒ replay.
   * Entries expire after `ttlMs`.
   */
  putIfAbsent(key: string, ttlMs: number, now?: number): Promise<boolean>;
  clear(): Promise<void>;
}

/** Single-process adapter (tests / dev). Prunes opportunistically. */
export class InMemoryReplayNonceStore implements ReplayNonceStore {
  readonly #entries = new Map<string, number>();
  #operations = 0;

  async putIfAbsent(key: string, ttlMs: number, now: number = Date.now()): Promise<boolean> {
    this.#operations += 1;
    if (this.#operations % 1_000 === 0) this.#prune(now);
    const expiry = this.#entries.get(key);
    if (expiry !== undefined && expiry > now) return false;
    this.#entries.set(key, now + ttlMs);
    return true;
  }

  #prune(now: number): void {
    for (const [key, expiry] of this.#entries) {
      if (expiry <= now) this.#entries.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }
}
