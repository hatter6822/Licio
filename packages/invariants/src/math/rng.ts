// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic seeded randomness for invariant computations (WS-H).
//
// Every stochastic invariant procedure (the MFCI Metropolis–Hastings fiber
// sampler, GWEI seed-stability runs, PHI gauge-invariance verification)
// derives its randomness from an explicit 32-bit seed so that a computation
// is a pure function of (inputs, seed): re-runs reproduce byte-identical
// outputs, CI failures replay exactly, and per-(target, window) seeds make
// scheduled production runs idempotent (the WS-E determinism discipline).
//
// mulberry32 is a small, well-distributed 32-bit PRNG — the same generator
// the repository's deterministic property-test harness uses. It is NOT a
// cryptographic source and must never be used for tokens, nonces, or keys
// (those live in `node:crypto` / WebCrypto on the server side).

export type Rng = () => number;

/** mulberry32: returns uniform floats in [0, 1) from a 32-bit seed. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a 32-bit hash of a string — derives a deterministic seed from a
 * domain string such as `MFCI:<targetId>:<windowStart>/<windowEnd>:<version>`
 * so detection side effects are deterministic per (target, window).
 */
export function seedFromString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Uniform integer in [min, max] (inclusive). */
export function randomInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Uniform element of a non-empty array. */
export function randomPick<T>(rng: Rng, values: readonly T[]): T {
  const value = values[randomInt(rng, 0, values.length - 1)];
  if (value === undefined) throw new Error('randomPick from empty array');
  return value;
}
