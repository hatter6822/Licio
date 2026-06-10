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
// contribution mix dominated by low-information replies + flags, and volume
// above the conditioned base rate. Conservative: isolated criticism (small N,
// or mixed constructive contributions) never triggers.
import type { EventContributionType } from '@licio/shared';

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
  input: { eventCount: number; distinctActors: number; trailingEventCounts: readonly number[] },
  config: BurstDetectorConfig = DEFAULT_BURST_CONFIG,
): BurstDetection {
  const trailing = input.trailingEventCounts.filter((n) => Number.isFinite(n) && n >= 0);
  const mean =
    trailing.length === 0 ? 0 : trailing.reduce((sum, n) => sum + n, 0) / trailing.length;
  const expectedVolume = Math.max(config.baseRateFloor, mean);
  const threshold = config.burstMultiplier * expectedVolume;
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
  /** Hostile share (low-info replies + flags) of all contributions. */
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

/** Harassment-cascade detection (WS-E.2.2c). Pure and total. */
export function detectHarassmentCascade(
  input: {
    eventCount: number;
    distinctActors: number;
    contributionCounts: Partial<Record<EventContributionType, number>>;
    trailingEventCounts: readonly number[];
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
    if (type === 'low_info_reply' || type === 'flag') hostile += n;
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
    input.eventCount > config.volumeMultiplier * expected;
  // Confidence grows with how far the hostile share clears the threshold.
  const confidence = detected
    ? Math.min(
        1,
        (hostileShare - config.hostileShareThreshold) / (1 - config.hostileShareThreshold) + 0.5,
      )
    : 0;
  return { detected, confidence, hostileShare };
}
