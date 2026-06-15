// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The distributional threshold-hugging meta-signal (WS-O.4.5): an attacker who
// reads the open-source threshold and tunes activity to sit just under the cliff
// produces a detectable spike of mass below the threshold. These prove the
// primitive flags that spike, ignores a diffuse population, is scale/translation
// invariant, and fails CLOSED (no false positives) when it cannot tell.

import { describe, expect, it } from 'vitest';
import {
  boundaryCrossingsByEntity,
  detectThresholdHugging,
  type RankSnapshot,
  type ThresholdHuggingConfig,
} from '../braid/index.js';

const CFG: ThresholdHuggingConfig = { band: 0.05, minPopulation: 10, excessThreshold: 2.5 };

/** A diffuse population spread uniformly over [0, threshold). */
function diffuse(n: number, threshold: number): number[] {
  return Array.from({ length: n }, (_, i) => (i / n) * threshold);
}

describe('detectThresholdHugging — flags mass just under the cliff', () => {
  it('does NOT flag a diffuse population (excess ≈ 1)', () => {
    const result = detectThresholdHugging(diffuse(40, 1), 1, CFG);
    expect(result.detected).toBe(false);
    expect(result.excess).toBeLessThan(2);
  });

  it('flags a diffuse background with a spike hugging the threshold', () => {
    // 30 spread over [0, 1) plus 12 massed in [0.95, 1) — the attack signature.
    const values = [...diffuse(30, 1), ...Array.from({ length: 12 }, () => 0.97)];
    const result = detectThresholdHugging(values, 1, CFG);
    expect(result.detected).toBe(true);
    expect(result.bandCount).toBeGreaterThanOrEqual(12);
    expect(result.excess).toBeGreaterThan(CFG.excessThreshold);
  });

  it('is suppressed below the minimum population (fail-closed)', () => {
    const tiny = [0.97, 0.98, 0.99]; // all hug, but too few to judge
    expect(detectThresholdHugging(tiny, 1, CFG).detected).toBe(false);
  });

  it('fails CLOSED when the whole population sits in the band (no reference for "diffuse")', () => {
    // Total-control: every value hugs, so there is no diffuse reference. The
    // meta-signal declines to flag (MFCI/coordination catches this case).
    const allHug = Array.from({ length: 30 }, () => 0.98);
    expect(detectThresholdHugging(allHug, 1, CFG).detected).toBe(false);
  });

  it('requires a real spike, not a single sub-threshold value', () => {
    const values = [...diffuse(30, 1), 0.99]; // one straggler near the cliff
    expect(detectThresholdHugging(values, 1, CFG).detected).toBe(false);
  });

  it('flags topics massed just under an INTEGER gaming threshold (the Braid-local use)', () => {
    // Many topics oscillating exactly 3 times to dodge a gaming flag of 4, over a
    // diffuse 1..6 background — the Braid-local crossing-count distribution.
    const counts = [1, 1, 2, 2, 5, 6, ...Array.from({ length: 12 }, () => 3)];
    const result = detectThresholdHugging(counts, 4, {
      band: 1,
      minPopulation: 8,
      excessThreshold: 2,
    });
    expect(result.detected).toBe(true);
    // A diffuse spread of crossing counts is NOT flagged.
    const diffuseCounts = [1, 1, 2, 2, 3, 3, 4, 5, 5, 6];
    expect(
      detectThresholdHugging(diffuseCounts, 4, { band: 1, minPopulation: 8, excessThreshold: 2 })
        .detected,
    ).toBe(false);
  });
});

describe('detectThresholdHugging — invariances', () => {
  const attack = [...diffuse(30, 1), ...Array.from({ length: 12 }, () => 0.97)];

  it('is invariant under scaling (values, threshold, band) by the same factor', () => {
    const base = detectThresholdHugging(attack, 1, CFG);
    const k = 7.3;
    const scaled = detectThresholdHugging(
      attack.map((v) => v * k),
      1 * k,
      { ...CFG, band: CFG.band * k },
    );
    expect(scaled.detected).toBe(base.detected);
    expect(scaled.bandCount).toBe(base.bandCount);
    expect(scaled.excess).toBeCloseTo(base.excess, 9);
  });

  it('is invariant under translating values and threshold by the same offset', () => {
    const base = detectThresholdHugging(attack, 1, CFG);
    const c = -3.5;
    const shifted = detectThresholdHugging(
      attack.map((v) => v + c),
      1 + c,
      CFG,
    );
    expect(shifted.detected).toBe(base.detected);
    expect(shifted.bandCount).toBe(base.bandCount);
    expect(shifted.excess).toBeCloseTo(base.excess, 9);
  });

  it('is deterministic (same input → same output)', () => {
    const first = detectThresholdHugging(attack, 1, CFG);
    for (let i = 0; i < 20; i += 1) {
      expect(detectThresholdHugging(attack, 1, CFG)).toEqual(first);
    }
  });
});

describe('boundaryCrossingsByEntity — shared temporal-crossing helper', () => {
  it('counts each entity flip across the rank boundary', () => {
    // a stays visible (rank 0); b and c swap around rank boundary 2 each step.
    const snapshots: RankSnapshot[] = Array.from({ length: 6 }, (_, i) => ({
      atMs: i,
      topicIdsByRank: i % 2 === 0 ? ['a', 'x', 'b', 'c'] : ['a', 'x', 'c', 'b'],
    }));
    const crossings = boundaryCrossingsByEntity(snapshots, 3);
    // b and c each cross the rank-3 boundary on every alternation.
    expect(crossings.get('b') ?? 0).toBeGreaterThan(0);
    expect(crossings.get('c') ?? 0).toBeGreaterThan(0);
    // a never moves and never crosses.
    expect(crossings.has('a')).toBe(false);
  });

  it('returns an empty map for fewer than two snapshots', () => {
    expect(boundaryCrossingsByEntity([], 2).size).toBe(0);
    expect(boundaryCrossingsByEntity([{ atMs: 0, topicIdsByRank: ['a', 'b'] }], 1).size).toBe(0);
  });
});
