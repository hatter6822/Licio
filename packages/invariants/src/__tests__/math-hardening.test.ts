// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression tests for numerical-robustness fixes surfaced by the math audit:
//   • SCOI H¹ rank tolerance is RELATIVE to the largest eigenvalue (scale
//     invariant), so a small-magnitude coboundary is not mis-ranked into a
//     FALSE structural obstruction.
//   • The braid-entropy bound is computed with per-step renormalization, so a
//     realistic-length word yields the bound instead of overflowing (the exact
//     Burau product's entries grow ≈ ρ^L and pass 2⁵³ within a few dozen
//     crossings).
//   • Rank-snapshot topic uniqueness is enforced on EVERY snapshot, not just
//     the first.
//   • The CID release gate FAILS CLOSED on a non-finite defect.
import { describe, expect, it } from 'vitest';
import {
  braidEntropyEstimate,
  braidWordFromSnapshots,
  cidReleaseGate,
  classifySessionHealth,
  h1Diagnostic,
  pathSignature,
  type SessionActionKind,
  type SheafStructure,
  sessionPathPoints,
  signedArea,
} from '../index.js';

function twoLensOverlap(scale: number): SheafStructure {
  return {
    lenses: [
      { lensId: 'l1', interpretation: [1] },
      { lensId: 'l2', interpretation: [1] },
    ],
    overlaps: [{ lensA: 'l1', lensB: 'l2', rhoA: [[scale]], rhoB: [[scale]] }],
  };
}

describe('SCOI H¹ rank tolerance — scale invariant', () => {
  it('a small-scale exact coboundary reports no obstruction (rank is relative)', () => {
    // rhoA = rhoB = [[1e-5]] ⇒ Δ₁'s eigenvalue ≈ 1e-10. An ABSOLUTE 1e-9 floor
    // would count it as null → rankD0 0 → dimH1 1 → a FALSE obstruction. The
    // relative tolerance (1e-9 · λmax) ranks it correctly.
    const small = h1Diagnostic(twoLensOverlap(1e-5));
    expect(small.rankD0).toBe(1);
    expect(small.dimH1).toBe(0);
    expect(small.structuralObstruction).toBe(false);
    // Identical topology at unit scale — the diagnostic must agree exactly.
    const unit = h1Diagnostic(twoLensOverlap(1));
    expect(small).toEqual(unit);
  });
});

describe('braid entropy — renormalized, overflow-free', () => {
  it('a long word yields a finite bound (no exact-product overflow)', () => {
    // 100 repetitions of σ₁σ₂⁻¹ (a positive-entropy pseudo-Anosov word). The
    // exact Burau image would exceed 2⁵³ and throw; the bound must be finite
    // and equal L× the single figure-eight value log((3+√5)/2) = 0.96242…
    const word = [];
    for (let i = 0; i < 100; i += 1) {
      word.push({ position: 0, sign: 1 as const, atMs: i });
      word.push({ position: 1, sign: -1 as const, atMs: i });
    }
    const entropy = braidEntropyEstimate(3, word);
    expect(Number.isFinite(entropy)).toBe(true);
    expect(entropy).toBeCloseTo(100 * Math.log((3 + Math.sqrt(5)) / 2), 3);
  });

  it('the short figure-eight word matches the closed-form spectral radius', () => {
    const short = [
      { position: 0, sign: 1 as const, atMs: 0 },
      { position: 1, sign: -1 as const, atMs: 1 },
    ];
    expect(braidEntropyEstimate(3, short)).toBeCloseTo(Math.log((3 + Math.sqrt(5)) / 2), 9);
  });
});

describe('braid snapshot validation — uniqueness on every snapshot', () => {
  it('rejects a repeated topic in a LATER snapshot', () => {
    expect(() =>
      braidWordFromSnapshots([
        { topicIdsByRank: ['A', 'B'], atMs: 0 },
        { topicIdsByRank: ['A', 'A'], atMs: 1 },
      ]),
    ).toThrow();
  });
});

describe('CID release gate — fails closed on a non-finite defect', () => {
  it('blocks when the CID is NaN or Infinity', () => {
    expect(cidReleaseGate(Number.NaN, 0.1).blocked).toBe(true);
    expect(cidReleaseGate(Number.POSITIVE_INFINITY, 0.1).blocked).toBe(true);
    // A finite CID below threshold still passes.
    expect(cidReleaseGate(0.05, 0.1).blocked).toBe(false);
  });
});

describe('PHI path-signature Lévy area — documented semantics', () => {
  const areaOf = (kinds: readonly SessionActionKind[]): number => {
    const events = kinds.map((kind, i) => ({
      kind,
      topicOrdinal: 0,
      atMs: i * 60_000,
      engagement: 0.5,
    }));
    return signedArea(pathSignature(sessionPathPoints(events)), 1, 2);
  };

  it('the (action, time) area is the SIGNED circulation about the start→end chord', () => {
    // Action-depth arcing ABOVE its chord circulates +; arcing BELOW circulates
    // − (the corrected module-header example — the prior example was false).
    expect(areaOf(['read', 'open_source', 'read'])).toBeGreaterThan(0);
    expect(areaOf(['open_source', 'read', 'open_source'])).toBeLessThan(0);
  });

  it('the area SIGN does not separate the health classes (so it is not a threshold)', () => {
    // A constructive session and a bursty one BOTH circulate positively — the
    // reason `classifySessionHealth` records `actionTimeArea` as a calibration
    // feature instead of thresholding on it. This pins WHY it is not wired.
    const constructive = areaOf(['read', 'open_source', 'question']);
    const bursty = areaOf(['scroll', 'reply', 'scroll']);
    expect(constructive).toBeGreaterThan(0);
    expect(bursty).toBeGreaterThan(0);
  });

  it('classifySessionHealth still records the area as an interpretable feature', () => {
    const result = classifySessionHealth([
      { kind: 'read', topicOrdinal: 0, atMs: 0, engagement: 0.5 },
      { kind: 'open_source', topicOrdinal: 0, atMs: 120_000, engagement: 0.8 },
      { kind: 'question', topicOrdinal: 0, atMs: 300_000, engagement: 0.9 },
    ]);
    expect(result.classification).toBe('constructive');
    expect(Number.isFinite(result.features.actionTimeArea)).toBe(true);
  });
});
