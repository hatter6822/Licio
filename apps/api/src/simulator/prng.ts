// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic PRNG for the DEV traffic simulator (never used in production
// logic): a hand-rolled mulberry32 stream plus the small sampling helpers the
// persona engine needs. Seeded runs are fully reproducible — the same seed and
// the same call sequence produce the same traffic plan — which is what makes
// the simulator's behaviour testable and a tester's session replayable.
// Deliberately dependency-free (SPEC §6.12.12 dependency budget).

/** A deterministic stream of floats in [0, 1). */
export interface Prng {
  /** Next float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive) — 0 when maxExclusive <= 0. */
  int(maxExclusive: number): number;
  /** Uniform pick from a non-empty array; throws on an empty one. */
  pick<T>(items: readonly T[]): T;
  /** True with probability p (clamped to [0, 1]). */
  chance(p: number): boolean;
  /** Poisson-distributed count with the given mean (Knuth; mean capped at 30). */
  poisson(mean: number): number;
  /** Weighted pick: weights must be non-negative; falls back to uniform when
   *  every weight is zero. */
  weighted<T>(items: ReadonlyArray<{ value: T; weight: number }>): T;
}

/** Fold an arbitrary string seed into a 32-bit integer (FNV-1a). */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Create the deterministic stream (mulberry32 over a 32-bit state). */
export function createPrng(seed: number | string): Prng {
  let state = (typeof seed === 'string' ? hashSeed(seed) : seed) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number): number =>
    maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive);
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('prng.pick: empty array');
      const value = items[int(items.length)];
      if (value === undefined && !items.includes(value as T)) {
        throw new Error('prng.pick: index out of range');
      }
      return value as T;
    },
    chance(p: number): boolean {
      if (p <= 0) return false;
      if (p >= 1) return true;
      return next() < p;
    },
    poisson(mean: number): number {
      const bounded = Math.min(Math.max(mean, 0), 30);
      if (bounded === 0) return 0;
      const limit = Math.exp(-bounded);
      let k = 0;
      let p = 1;
      do {
        k += 1;
        p *= next();
      } while (p > limit);
      return k - 1;
    },
    weighted<T>(items: ReadonlyArray<{ value: T; weight: number }>): T {
      if (items.length === 0) throw new Error('prng.weighted: empty array');
      let total = 0;
      for (const item of items) total += Math.max(item.weight, 0);
      if (total <= 0) {
        const fallback = items[int(items.length)];
        if (fallback === undefined) throw new Error('prng.weighted: index out of range');
        return fallback.value;
      }
      let roll = next() * total;
      for (const item of items) {
        roll -= Math.max(item.weight, 0);
        if (roll < 0) return item.value;
      }
      const last = items[items.length - 1];
      if (last === undefined) throw new Error('prng.weighted: unreachable');
      return last.value;
    },
  };
}
