// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal deterministic property-test harness. A seeded PRNG (mulberry32)
// keeps every property run reproducible in CI — a failure always reprints the
// case index and seed, and re-running reproduces it exactly. No external
// dependency, no flaky randomness.

export type Rng = () => number;

/** mulberry32: a small, well-distributed 32-bit PRNG. */
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

export function int(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function float(rng: Rng, min: number, max: number): number {
  return rng() * (max - min) + min;
}

export function pick<T>(rng: Rng, values: readonly T[]): T {
  const index = int(rng, 0, values.length - 1);
  const value = values[index];
  if (value === undefined) throw new Error('pick from empty array');
  return value;
}

export function bool(rng: Rng): boolean {
  return rng() < 0.5;
}

/**
 * Run `predicate` over `n` generated cases; throws with the seed and case
 * index on the first violation.
 */
export function forAll<T>(
  seed: number,
  n: number,
  generate: (rng: Rng) => T,
  predicate: (value: T) => boolean | string,
): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < n; i += 1) {
    const value = generate(rng);
    const result = predicate(value);
    if (result !== true) {
      const message = typeof result === 'string' ? result : 'property violated';
      throw new Error(
        `${message} (seed=${seed}, case=${i}, value=${JSON.stringify(value, null, 1)})`,
      );
    }
  }
}
