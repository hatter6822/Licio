// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Anti-signal detectors (WS-E.2.2a/c, SPEC §5.3/§8/§25.5).
//
// COORDINATED BURST: a window whose event volume exceeds the item's own
// conditioned base rate (the trailing-window mean — an active community has a
// HIGH base rate, so activity alone never triggers; SPEC §8 fairness) by a
// tunable multiplier, with a minimum-distinct-actors guard against single-user
// false positives and a minimum-volume floor against tiny-sample noise.
// Confidence = 1 − threshold/volume ∈ [0, 1): 0 at the threshold, → 1 as the
// burst grows — monotone in volume, scale-free across base rates.
//
// HARASSMENT CASCADE: a hostile pile-on — several distinct actors, a
// contribution mix dominated by low-information replies, and volume
// above the conditioned base rate. Conservative: isolated criticism (small N,
// or mixed constructive contributions) never triggers.
import type { EventContributionType } from '@licio/shared';

// Account-age / progressive-trust weighting (WS-O.4.5). A bounded, monotone
// trust weight per account-age bucket — NEVER zero, so legitimate new users
// still participate. A burst dominated by low-trust (disposable, fresh)
// accounts has its effective volume threshold scaled DOWN by the average trust
// factor, so it is flagged at lower volume (raising the economic cost of a
// throwaway-account brigade) while an aged community is unaffected. Account age
// is a coarse, non-financial signal already used by MFCI's user_group dimension;
// anonymity is never penalized (the privacy-bucket actor is treated as trusted).
export interface TrustWeights {
  /** < 7 days. */ new: number;
  /** < 90 days. */ recent: number;
  /** < 365 days. */ active: number;
  /** ≥ 365 days (the unweighted baseline). */ established: number;
}

export const DEFAULT_TRUST_WEIGHTS: TrustWeights = {
  new: 0.5,
  recent: 0.7,
  active: 0.9,
  established: 1,
};

/** Bounded, monotone account-age trust weight (never zero). Pure and total. */
export function accountTrustWeight(
  ageDays: number,
  weights: TrustWeights = DEFAULT_TRUST_WEIGHTS,
): number {
  if (!Number.isFinite(ageDays) || ageDays < 7) return weights.new;
  if (ageDays < 90) return weights.recent;
  if (ageDays < 365) return weights.active;
  return weights.established;
}

export interface BurstDetectorConfig {
  /** Minimum events in the window before any detection (noise floor). */
  minVolume: number;
  /** Minimum distinct actors (the single-user false-positive guard). */
  minDistinctActors: number;
  /** Volume must exceed multiplier × conditioned base rate. */
  burstMultiplier: number;
  /** Base-rate floor when an item has no history yet. */
  baseRateFloor: number;
}

export const DEFAULT_BURST_CONFIG: BurstDetectorConfig = {
  minVolume: 10,
  minDistinctActors: 5,
  burstMultiplier: 4,
  baseRateFloor: 3,
};

export interface BurstDetection {
  detected: boolean;
  confidence: number;
  /** The conditioned expected volume the window was measured against. */
  expectedVolume: number;
}

/**
 * Coordinated-burst detection conditioned on the item's own base rate
 * (trailing windows' event counts). Pure and total.
 */
export function detectCoordinatedBurst(
  input: {
    eventCount: number;
    distinctActors: number;
    trailingEventCounts: readonly number[];
    /** Average account-age trust factor of the window's actors (WS-O.4.5);
     *  ∈ (0, 1], defaults to 1 (no effect). A low factor (a fresh-account
     *  brigade) scales the threshold DOWN so it is flagged at lower volume. */
    trustFactor?: number;
  },
  config: BurstDetectorConfig = DEFAULT_BURST_CONFIG,
): BurstDetection {
  const trailing = input.trailingEventCounts.filter((n) => Number.isFinite(n) && n >= 0);
  const mean =
    trailing.length === 0 ? 0 : trailing.reduce((sum, n) => sum + n, 0) / trailing.length;
  const expectedVolume = Math.max(config.baseRateFloor, mean);
  const trustFactor = clampTrustFactor(input.trustFactor);
  const threshold = config.burstMultiplier * expectedVolume * trustFactor;
  const detected =
    input.eventCount >= config.minVolume &&
    input.distinctActors >= config.minDistinctActors &&
    input.eventCount > threshold;
  const confidence = detected ? Math.min(1, Math.max(0, 1 - threshold / input.eventCount)) : 0;
  return { detected, confidence, expectedVolume };
}

export interface CascadeDetectorConfig {
  /** Minimum distinct actors before a pile-on is considered. */
  minDistinctActors: number;
  /** Minimum contributions in the window (isolated criticism guard). */
  minContributions: number;
  /** Hostile share (low-info replies) of all contributions. */
  hostileShareThreshold: number;
  /** Volume must exceed multiplier × conditioned base rate. */
  volumeMultiplier: number;
  /** Base-rate floor when an item has no history yet. */
  baseRateFloor: number;
}

export const DEFAULT_CASCADE_CONFIG: CascadeDetectorConfig = {
  minDistinctActors: 5,
  minContributions: 8,
  hostileShareThreshold: 0.6,
  volumeMultiplier: 2,
  baseRateFloor: 3,
};

export interface CascadeDetection {
  detected: boolean;
  confidence: number;
  hostileShare: number;
}

/** Clamp the optional trust factor to (0, 1]; absent/invalid → 1 (no effect). */
function clampTrustFactor(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0.1, value));
}

/** Harassment-cascade detection (WS-E.2.2c). Pure and total. */
export function detectHarassmentCascade(
  input: {
    eventCount: number;
    distinctActors: number;
    contributionCounts: Partial<Record<EventContributionType, number>>;
    trailingEventCounts: readonly number[];
    /** Average account-age trust factor (WS-O.4.5); ∈ (0, 1], defaults to 1. */
    trustFactor?: number;
  },
  config: CascadeDetectorConfig = DEFAULT_CASCADE_CONFIG,
): CascadeDetection {
  let total = 0;
  let hostile = 0;
  for (const [type, count] of Object.entries(input.contributionCounts) as Array<
    [EventContributionType, number | undefined]
  >) {
    const n = count ?? 0;
    total += n;
    if (type === 'low_info_reply') hostile += n;
  }
  const hostileShare = total === 0 ? 0 : hostile / total;
  const trailing = input.trailingEventCounts.filter((n) => Number.isFinite(n) && n >= 0);
  const mean =
    trailing.length === 0 ? 0 : trailing.reduce((sum, n) => sum + n, 0) / trailing.length;
  const expected = Math.max(config.baseRateFloor, mean);
  const detected =
    input.distinctActors >= config.minDistinctActors &&
    total >= config.minContributions &&
    hostileShare >= config.hostileShareThreshold &&
    input.eventCount > config.volumeMultiplier * expected * clampTrustFactor(input.trustFactor);
  // Confidence grows with how far the hostile share clears the threshold. A
  // threshold of 1.0 is a schema-legal config (`z.number().min(0).max(1)`),
  // which makes the `1 - threshold` span zero; detection then implies
  // hostileShare === 1 (fully saturated), so the confidence is the maximum.
  // Guarding the degenerate span keeps a 0/0 NaN out of the downstream
  // `integrity.signal.detected` schema (whose `confidence` rejects NaN).
  const span = 1 - config.hostileShareThreshold;
  const confidence = detected
    ? span <= 0
      ? 1
      : Math.min(1, Math.max(0, (hostileShare - config.hostileShareThreshold) / span + 0.5))
    : 0;
  return { detected, confidence, hostileShare };
}
