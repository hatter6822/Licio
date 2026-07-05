// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createPrng, hashSeed } from '../prng.js';

describe('simulator PRNG', () => {
  it('is deterministic for a given seed', () => {
    const a = createPrng('seed-1');
    const b = createPrng('seed-1');
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different streams for different seeds', () => {
    const a = createPrng('seed-1');
    const b = createPrng('seed-2');
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('accepts a numeric seed identically to the folded string seed', () => {
    const numeric = createPrng(hashSeed('abc'));
    const str = createPrng('abc');
    expect(numeric.next()).toBeCloseTo(str.next(), 12);
  });

  it('emits floats in [0, 1)', () => {
    const prng = createPrng('range');
    for (let i = 0; i < 1000; i += 1) {
      const value = prng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('int(n) stays within [0, n)', () => {
    const prng = createPrng('int');
    for (let i = 0; i < 500; i += 1) {
      const value = prng.int(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
    expect(prng.int(0)).toBe(0);
    expect(prng.int(-3)).toBe(0);
  });

  it('pick returns a member and throws on empty', () => {
    const prng = createPrng('pick');
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 50; i += 1) expect(items).toContain(prng.pick(items));
    expect(() => prng.pick([])).toThrow();
  });

  it('chance clamps at the boundaries', () => {
    const prng = createPrng('chance');
    expect(prng.chance(0)).toBe(false);
    expect(prng.chance(1)).toBe(true);
    let hits = 0;
    for (let i = 0; i < 2000; i += 1) if (prng.chance(0.5)) hits += 1;
    // Roughly half; a wide band avoids flakiness on a deterministic stream.
    expect(hits).toBeGreaterThan(800);
    expect(hits).toBeLessThan(1200);
  });

  it('poisson approximates its mean and never goes negative', () => {
    const prng = createPrng('poisson');
    let total = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      const value = prng.poisson(2);
      expect(value).toBeGreaterThanOrEqual(0);
      total += value;
    }
    expect(total / n).toBeGreaterThan(1.6);
    expect(total / n).toBeLessThan(2.4);
    expect(prng.poisson(0)).toBe(0);
    expect(prng.poisson(-5)).toBe(0);
  });

  it('weighted honours weights and falls back to uniform when all-zero', () => {
    const prng = createPrng('weighted');
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 3000; i += 1) {
      const value = prng.weighted([
        { value: 'a' as const, weight: 3 },
        { value: 'b' as const, weight: 1 },
      ]);
      counts[value] += 1;
    }
    expect(counts.a).toBeGreaterThan(counts.b);
    // All-zero weights: still returns a member, never throws.
    const zero = prng.weighted([
      { value: 'x', weight: 0 },
      { value: 'y', weight: 0 },
    ]);
    expect(['x', 'y']).toContain(zero);
    expect(() => prng.weighted([])).toThrow();
  });
});
