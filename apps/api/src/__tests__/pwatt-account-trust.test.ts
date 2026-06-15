// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-O.4.5 — account-age / progressive-trust weighting. A coordinated burst
// dominated by fresh, disposable accounts is flagged at LOWER volume (raising
// the economic cost of a throwaway-account brigade) via a bounded, monotone
// trust factor that scales the detection threshold; an aged community of equal
// volume is unaffected, and the weight is NEVER zero so legitimate new users
// still participate. The signal is non-financial (neutrality-safe) and never
// penalizes anonymity (the privacy-bucket actor is treated as established).

import { describe, expect, it } from 'vitest';
import {
  accountTrustWeight,
  DEFAULT_TRUST_WEIGHTS,
  detectCoordinatedBurst,
  detectHarassmentCascade,
} from '../pwatt/anti-signals.js';

describe('accountTrustWeight — bounded, monotone, never zero', () => {
  it('is monotone non-decreasing across age buckets and tops out at 1', () => {
    const w0 = accountTrustWeight(1); // new
    const w1 = accountTrustWeight(30); // recent
    const w2 = accountTrustWeight(180); // active
    const w3 = accountTrustWeight(800); // established
    expect(w0).toBeLessThan(w1);
    expect(w1).toBeLessThan(w2);
    expect(w2).toBeLessThan(w3);
    expect(w3).toBe(1);
  });

  it('never returns zero (legitimate new users still participate)', () => {
    for (const age of [0, 0.5, 3, 6.9]) expect(accountTrustWeight(age)).toBeGreaterThan(0);
    // A non-finite age fails safe to the lowest (new) bucket, still > 0.
    expect(accountTrustWeight(Number.NaN)).toBe(DEFAULT_TRUST_WEIGHTS.new);
  });
});

describe('detectCoordinatedBurst — trust-weighted threshold', () => {
  // Empty trailing ⇒ expectedVolume = baseRateFloor (3); full threshold = 4×3 = 12.
  const input = { eventCount: 11, distinctActors: 6, trailingEventCounts: [] as number[] };

  it('does NOT flag an AGED community at a volume a fresh brigade IS flagged at', () => {
    // Established (trustFactor 1): threshold 12, volume 11 → not a burst.
    expect(detectCoordinatedBurst({ ...input, trustFactor: 1 }).detected).toBe(false);
    // A fresh-account brigade (trustFactor 0.5): threshold 6, volume 11 → flagged.
    const fresh = detectCoordinatedBurst({ ...input, trustFactor: 0.5 });
    expect(fresh.detected).toBe(true);
    expect(fresh.confidence).toBeGreaterThan(0);
  });

  it('is backward-compatible: an absent trust factor behaves as 1.0', () => {
    expect(detectCoordinatedBurst(input).detected).toBe(
      detectCoordinatedBurst({ ...input, trustFactor: 1 }).detected,
    );
  });

  it('clamps an out-of-range trust factor (never zeroes the threshold)', () => {
    // trustFactor 0 would zero the threshold; it is clamped to ≥ 0.1.
    const clamped = detectCoordinatedBurst({ ...input, trustFactor: 0 });
    const floored = detectCoordinatedBurst({ ...input, trustFactor: 0.1 });
    expect(clamped.detected).toBe(floored.detected);
  });
});

describe('detectHarassmentCascade — trust-weighted threshold', () => {
  const base = {
    eventCount: 5,
    distinctActors: 6,
    contributionCounts: { low_info_reply: 8 },
    trailingEventCounts: [] as number[],
  };
  it('flags a fresh-account pile-on at a volume an aged one is not', () => {
    // Established: threshold 2×3×1 = 6, volume 5 → not detected.
    expect(detectHarassmentCascade({ ...base, trustFactor: 1 }).detected).toBe(false);
    // Fresh: threshold 2×3×0.5 = 3, volume 5 → detected (hostile share 1.0).
    expect(detectHarassmentCascade({ ...base, trustFactor: 0.5 }).detected).toBe(true);
  });
});
