// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.3c — MinHash/LSH math. Verifies the estimator against the exact
// Jaccard oracle (deterministic seeded corpus), the documented LSH detection
// curve, banding behavior at and below the 0.7 threshold, determinism of the
// pinned hash family, and shingling normalization.
import { describe, expect, it } from 'vitest';
import {
  estimateJaccard,
  exactJaccard,
  fnv1a32,
  lshBandHashes,
  lshCandidateProbability,
  MINHASH_FAMILY_VERSION,
  MINHASH_LSH_BANDS,
  MINHASH_LSH_ROWS,
  MINHASH_NUM_HASHES,
  MINHASH_SHINGLE_K,
  minhashSignature,
  normalizeForShingling,
  shingleHashes,
} from '../text/minhash.js';
import { int, mulberry32, type Rng } from './prop.js';

/** Random word of 3–8 lowercase letters. */
function word(rng: Rng): string {
  const length = int(rng, 3, 8);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(97 + int(rng, 0, 25));
  }
  return out;
}

/** Random article-like text of `n` words. */
function text(rng: Rng, n: number): string {
  return Array.from({ length: n }, () => word(rng)).join(' ');
}

/** A pair sharing roughly `sharedFraction` of its text. */
function overlappingPair(rng: Rng, sharedFraction: number): [string, string] {
  const sharedWords = int(rng, 40, 80);
  const shared = text(rng, sharedWords);
  const uniqueWords = Math.max(
    1,
    Math.round((sharedWords * (1 - sharedFraction)) / Math.max(sharedFraction, 0.05)),
  );
  return [`${shared} ${text(rng, uniqueWords)}`, `${text(rng, uniqueWords)} ${shared}`];
}

describe('shingling (WS-F.1.3c)', () => {
  it('normalizes case and whitespace before shingling', () => {
    expect(normalizeForShingling('  Hello\n\tWORLD  ')).toBe('hello world');
    expect(shingleHashes('Hello  World')).toEqual(shingleHashes('hello world'));
  });

  it('produces |text| − k + 1 shingles before dedup, deduplicated as a set', () => {
    const sample = 'abcdefgh'; // 8 chars → 4 shingles of k=5, all distinct
    expect(shingleHashes(sample).size).toBe(sample.length - MINHASH_SHINGLE_K + 1);
    // Repetitive text dedups: 'aaaaaaaa' has ONE distinct 5-shingle.
    expect(shingleHashes('aaaaaaaa').size).toBe(1);
  });

  it('handles short and empty texts totally', () => {
    expect(shingleHashes('').size).toBe(0);
    expect(shingleHashes('abc').size).toBe(1);
  });

  it('fnv1a32 is deterministic and 32-bit', () => {
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
    expect(fnv1a32('hello')).not.toBe(fnv1a32('hellp'));
    expect(fnv1a32('x')).toBeGreaterThanOrEqual(0);
    expect(fnv1a32('x')).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('MinHash signature + estimator', () => {
  it('pins the persisted parameters (family version contract)', () => {
    expect(MINHASH_FAMILY_VERSION).toBe(1);
    expect(MINHASH_NUM_HASHES).toBe(128);
    expect(MINHASH_SHINGLE_K).toBe(5);
    expect(MINHASH_LSH_BANDS * MINHASH_LSH_ROWS).toBe(MINHASH_NUM_HASHES);
  });

  it('is deterministic: identical text → identical signature (stable family)', () => {
    const a = minhashSignature('The vote passed by a narrow margin on Tuesday evening.');
    const b = minhashSignature('The vote passed by a narrow margin on Tuesday evening.');
    expect([...a]).toEqual([...b]);
    expect(a.length).toBe(MINHASH_NUM_HASHES);
  });

  it('estimates 1 for identical texts and ~0 for unrelated texts', () => {
    const rng = mulberry32(7);
    const a = text(rng, 80);
    const b = text(rng, 80);
    expect(estimateJaccard(minhashSignature(a), minhashSignature(a))).toBe(1);
    expect(estimateJaccard(minhashSignature(a), minhashSignature(b))).toBeLessThanOrEqual(0.1);
  });

  it('approximates the exact Jaccard within 4.5σ on every pair and 0.06 on average', {
    timeout: 30_000,
  }, () => {
    // σ = √(J(1−J)/128) ≤ 0.0442. Seeded corpus ⇒ fully reproducible. 48
    // pairs keep the per-pair 4.5σ bound meaningful while staying fast under
    // V8 coverage instrumentation (the BigInt hash family is the hot path).
    const rng = mulberry32(2026);
    const fractions = [0.1, 0.3, 0.5, 0.7, 0.85, 0.95];
    let totalError = 0;
    let pairs = 0;
    for (let round = 0; round < 8; round += 1) {
      for (const fraction of fractions) {
        const [a, b] = overlappingPair(rng, fraction);
        const exact = exactJaccard(a, b);
        const estimated = estimateJaccard(minhashSignature(a), minhashSignature(b));
        const sigma = Math.sqrt((exact * (1 - exact)) / MINHASH_NUM_HASHES);
        const bound = Math.max(4.5 * sigma, 0.02);
        expect(
          Math.abs(estimated - exact),
          `J=${exact.toFixed(3)} est=${estimated.toFixed(3)} fraction=${fraction}`,
        ).toBeLessThanOrEqual(bound);
        totalError += Math.abs(estimated - exact);
        pairs += 1;
      }
    }
    expect(totalError / pairs).toBeLessThanOrEqual(0.06);
  });

  it('empty-text sentinel never matches real content', () => {
    const empty = minhashSignature('');
    const real = minhashSignature('a perfectly ordinary sentence about local infrastructure');
    expect(estimateJaccard(empty, real)).toBeLessThanOrEqual(0.01);
  });
});

describe('LSH banding (WS-F.1.3c sub-linear retrieval)', () => {
  it('documents the exact detection curve for (b=32, r=4)', () => {
    // P(candidate | s) = 1 − (1 − s⁴)³². The exact 50% crossover is
    // s* = (1 − 2^(−1/32))^(1/4) ≈ 0.3826; the conventional steep-point
    // approximation (1/32)^(1/4) ≈ 0.4204 sits at P ≈ 0.636. Both are well
    // below 0.7 by design: the 0.7 DECISION threshold is applied on the
    // signature estimate after retrieval, where recall at 0.7 ≈ 0.999847.
    expect(lshCandidateProbability(0.7)).toBeGreaterThanOrEqual(0.9998);
    const exactCrossover = (1 - 2 ** (-1 / 32)) ** (1 / 4);
    expect(exactCrossover).toBeCloseTo(0.3826, 3);
    expect(lshCandidateProbability(exactCrossover)).toBeCloseTo(0.5, 9);
    expect(lshCandidateProbability(0.42)).toBeCloseTo(0.636, 2);
    expect(lshCandidateProbability(0.2)).toBeLessThanOrEqual(0.06);
    expect(lshCandidateProbability(0)).toBe(0);
    expect(lshCandidateProbability(1)).toBe(1);
  });

  it('texts with ≥70% shingle overlap share at least one band (recall)', () => {
    const rng = mulberry32(99);
    for (let round = 0; round < 30; round += 1) {
      const [a, b] = overlappingPair(rng, 0.9);
      if (exactJaccard(a, b) < 0.7) continue; // construction occasionally undershoots
      const bandsA = lshBandHashes(minhashSignature(a));
      const bandsB = lshBandHashes(minhashSignature(b));
      let shared = 0;
      for (let i = 0; i < bandsA.length; i += 1) {
        if (bandsA[i] === bandsB[i]) shared += 1;
      }
      expect(shared, `round ${round}: J=${exactJaccard(a, b).toFixed(3)}`).toBeGreaterThan(0);
    }
  });

  it('unrelated texts rarely share a band (precision of retrieval)', () => {
    const rng = mulberry32(123);
    let collisions = 0;
    const rounds = 50;
    for (let round = 0; round < rounds; round += 1) {
      const bandsA = lshBandHashes(minhashSignature(text(rng, 60)));
      const bandsB = lshBandHashes(minhashSignature(text(rng, 60)));
      for (let i = 0; i < bandsA.length; i += 1) {
        if (bandsA[i] === bandsB[i]) collisions += 1;
      }
    }
    // Expected ≈ rounds × b × s⁴ with s ≈ 0 — effectively zero.
    expect(collisions).toBeLessThanOrEqual(1);
  });

  it('band hashes differ for identical rows in different band positions', () => {
    // A constant signature has identical rows in every band; the band-index
    // prefix must still keep the 32 bucket keys from being trivially equal
    // ACROSS positions for different content.
    const constant = new Uint32Array(MINHASH_NUM_HASHES).fill(7);
    const bands = lshBandHashes(constant);
    expect(new Set([...bands]).size).toBe(MINHASH_LSH_BANDS);
  });
});
