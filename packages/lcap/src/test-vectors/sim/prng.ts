// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A seeded, deterministic PRNG for the network simulator (OFFLINE_SPEC §32.3,
// WS-R.18.3a).  mulberry32 — a tiny, well-distributed 32-bit generator — so a
// `(seed, scenario)` pair reproduces the identical event trace byte-for-byte.  The
// simulator NEVER uses `Math.random`; every stochastic choice (loss, duplication,
// delay, partition, contact order) draws from one of these so failures reproduce.

export interface Prng {
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [0, n). */
  int(n: number): number;
  /** True with probability `p` (clamped to [0, 1]). */
  bool(p: number): boolean;
  /** Pick an element (undefined for an empty array). */
  pick<T>(items: readonly T[]): T | undefined;
}

/** Construct a deterministic PRNG seeded by `seed` (mulberry32). */
export function makePrng(seed: number): Prng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => (n <= 0 ? 0 : Math.floor(next() * n)),
    bool: (p) => next() < Math.max(0, Math.min(1, p)),
    pick: (items) => (items.length === 0 ? undefined : items[Math.floor(next() * items.length)]),
  };
}
