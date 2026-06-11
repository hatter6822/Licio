// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MFCI — cheap real-time statistics with precomputed null calibrations
// (WS-H.3.1a/WS-H.3.1b, SPEC §8.2 latency note).
//
// These drive the sub-minute freeze path (MFCI-3): no MCMC, no table — just
// conservative scalar statistics over the recent action list, judged against
// versioned null calibrations built from historical baselines and
// CONDITIONED ON VOLUME (the per-volume-bucket quantiles are how base rates
// enter, so an active community's raw volume can never by itself look
// anomalous). The exact fiber test later confirms or clears (WS-H.3.3d).
//
// Score semantics. Both statistics map to a nonnegative anomaly score:
// 0 at or below the calibrated median, 1.0 at the calibrated q99, linear in
// between and beyond (so "score ≥ 1" reads "beyond the 99th percentile of
// the conditioned null"). Confidence scales with how much baseline data
// backed the calibration bucket; stale calibrations flag
// NULL_CALIBRATION_STALE and shrink confidence rather than guessing.

export interface ObservedAction {
  /** Pseudonymous actor reference — never an IP or raw identifier. */
  actorRef: string;
  targetId: string;
  atMs: number;
}

export interface CalibrationBucket {
  /** Bucket applies to observations with volume ≥ minVolume. */
  minVolume: number;
  q50: number;
  q90: number;
  q99: number;
  /** Baseline observations that produced this bucket. */
  sampleCount: number;
}

export interface NullCalibration {
  statistic: 'target_concentration' | 'synchrony';
  version: string;
  computedAtMs: number;
  buckets: CalibrationBucket[];
}

export interface CheapScoreResult {
  /** ≥ 0; 1.0 = at the conditioned q99 of the null. */
  score: number;
  rawValue: number;
  volume: number;
  bucketMinVolume: number | null;
  confidence: number;
  reasonCodes: string[];
  /** Latency accounting is the caller's concern; this is pure compute. */
}

export interface CheapStatisticOptions {
  nowMs: number;
  /** Calibration older than this is stale (default 48 h). */
  maxCalibrationAgeMs?: number;
  /** Minimum actions for a meaningful score (default 5). */
  minActions?: number;
  /** Synchrony cluster width (default 2 000 ms). */
  synchronyDeltaMs?: number;
}

function pickBucket(calibration: NullCalibration, volume: number): CalibrationBucket | null {
  let best: CalibrationBucket | null = null;
  for (const bucket of calibration.buckets) {
    if (volume >= bucket.minVolume && (best === null || bucket.minVolume > best.minVolume)) {
      best = bucket;
    }
  }
  return best;
}

function scoreAgainst(rawValue: number, bucket: CalibrationBucket): number {
  const spread = bucket.q99 - bucket.q50;
  if (spread <= 1e-12) {
    // Degenerate null (constant baseline): anything above it is maximal.
    return rawValue > bucket.q50 ? 1 : 0;
  }
  return Math.max(0, (rawValue - bucket.q50) / spread);
}

function confidenceFor(
  bucket: CalibrationBucket | null,
  stale: boolean,
  enoughActions: boolean,
): number {
  if (!bucket || !enoughActions) return 0;
  // Saturating in the baseline behind the bucket: 1 − 1/(1+n/100).
  let confidence = 1 - 1 / (1 + bucket.sampleCount / 100);
  if (stale) confidence *= 0.5;
  return Math.min(1, Math.max(0, confidence));
}

/**
 * Target-concentration (WS-H.3.1a): the busiest target's share of all
 * actions in the window, scored against the volume-conditioned null.
 */
export function targetConcentrationScore(
  actions: readonly ObservedAction[],
  calibration: NullCalibration,
  options: CheapStatisticOptions,
): CheapScoreResult {
  const reasonCodes: string[] = [];
  const volume = actions.length;
  const minActions = options.minActions ?? 5;
  const maxAge = options.maxCalibrationAgeMs ?? 48 * 3_600_000;
  const stale = options.nowMs - calibration.computedAtMs > maxAge;
  if (stale) reasonCodes.push('NULL_CALIBRATION_STALE');

  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action.targetId, (counts.get(action.targetId) ?? 0) + 1);
  }
  let max = 0;
  for (const count of counts.values()) max = Math.max(max, count);
  const rawValue = volume === 0 ? 0 : max / volume;

  const bucket = pickBucket(calibration, volume);
  const enough = volume >= minActions;
  if (!enough) reasonCodes.push('INSUFFICIENT_COVERAGE');
  return {
    score: bucket && enough ? scoreAgainst(rawValue, bucket) : 0,
    rawValue,
    volume,
    bucketMinVolume: bucket?.minVolume ?? null,
    confidence: confidenceFor(bucket, stale, enough),
    reasonCodes,
  };
}

/**
 * Synchrony (WS-H.3.1b): the fraction of actions arriving within
 * `synchronyDeltaMs` of a DIFFERENT actor's action — cross-actor temporal
 * clustering, so one fast user can never trip it. Scored against the
 * volume-conditioned null (base-rate conditioning).
 */
export function synchronyScore(
  actions: readonly ObservedAction[],
  calibration: NullCalibration,
  options: CheapStatisticOptions,
): CheapScoreResult {
  const reasonCodes: string[] = [];
  const volume = actions.length;
  const minActions = options.minActions ?? 5;
  const delta = options.synchronyDeltaMs ?? 2_000;
  const maxAge = options.maxCalibrationAgeMs ?? 48 * 3_600_000;
  const stale = options.nowMs - calibration.computedAtMs > maxAge;
  if (stale) reasonCodes.push('NULL_CALIBRATION_STALE');

  const sorted = [...actions].sort((a, b) => a.atMs - b.atMs);
  let clustered = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const action = sorted[i];
    if (!action) continue;
    let near = false;
    for (let j = i - 1; j >= 0; j -= 1) {
      const other = sorted[j];
      if (!other) continue;
      if (action.atMs - other.atMs > delta) break;
      if (other.actorRef !== action.actorRef) {
        near = true;
        break;
      }
    }
    if (!near) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const other = sorted[j];
        if (!other) continue;
        if (other.atMs - action.atMs > delta) break;
        if (other.actorRef !== action.actorRef) {
          near = true;
          break;
        }
      }
    }
    if (near) clustered += 1;
  }
  const rawValue = volume === 0 ? 0 : clustered / volume;

  const bucket = pickBucket(calibration, volume);
  const enough = volume >= minActions;
  if (!enough) reasonCodes.push('INSUFFICIENT_COVERAGE');
  return {
    score: bucket && enough ? scoreAgainst(rawValue, bucket) : 0,
    rawValue,
    volume,
    bucketMinVolume: bucket?.minVolume ?? null,
    confidence: confidenceFor(bucket, stale, enough),
    reasonCodes,
  };
}

/**
 * Build a null calibration from historical baseline raw values, grouped
 * into volume buckets (WS-H.3.1a: "precomputed null calibrations established
 * from historical baseline data"). Pure over the supplied samples.
 */
export function buildNullCalibration(
  statistic: NullCalibration['statistic'],
  version: string,
  computedAtMs: number,
  samples: ReadonlyArray<{ volume: number; rawValue: number }>,
  volumeBucketEdges: readonly number[] = [0, 10, 50, 200, 1000],
): NullCalibration {
  const quantile = (sorted: number[], q: number): number => {
    if (sorted.length === 0) return 0;
    const pos = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[pos] ?? 0;
  };
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < volumeBucketEdges.length; i += 1) {
    const min = volumeBucketEdges[i] ?? 0;
    const max = volumeBucketEdges[i + 1] ?? Number.POSITIVE_INFINITY;
    const values = samples
      .filter((s) => s.volume >= min && s.volume < max)
      .map((s) => s.rawValue)
      .sort((a, b) => a - b);
    if (values.length === 0) continue;
    buckets.push({
      minVolume: min,
      q50: quantile(values, 0.5),
      q90: quantile(values, 0.9),
      q99: quantile(values, 0.99),
      sampleCount: values.length,
    });
  }
  return { statistic, version, computedAtMs, buckets };
}
