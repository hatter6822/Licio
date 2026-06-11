// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI — sensitive-topic and minor threshold strictness (WS-H.6.2d,
// SPEC §11.5; PHI-3).
//
// Stricter means LOWER: the effective intervention threshold is the base
// threshold multiplied by factors ≤ 1 for sensitive topics and for minors.
// The sensitivity labels come from WS-F ingestion (the same lexicon labels
// stories already carry); minor status comes from the WS-D age gate. The
// factors are runtime-tunable but validated fail-closed: a factor > 1
// (which would LOOSEN protection) is rejected at write time.

export interface PhiThresholdConfig {
  /** Base PHI score at which wellbeing intervention triggers. */
  baseThreshold: number;
  /** Multiplier (≤ 1) for sensitive topics. */
  sensitiveTopicFactor: number;
  /** Multiplier (≤ 1) for minor users. */
  minorFactor: number;
  /** Narrow-loop repeat threshold (visits); base value. */
  baseRepeatThreshold: number;
  /** Repeat-threshold reduction (subtracted, floor 2) for sensitive/minor. */
  repeatReduction: number;
}

export const DEFAULT_PHI_THRESHOLD_CONFIG: PhiThresholdConfig = {
  baseThreshold: 1.5,
  sensitiveTopicFactor: 0.5,
  minorFactor: 0.6,
  baseRepeatThreshold: 3,
  repeatReduction: 1,
};

export function validatePhiThresholdConfig(config: PhiThresholdConfig): string | null {
  if (!(config.baseThreshold > 0 && Number.isFinite(config.baseThreshold))) {
    return 'baseThreshold must be a positive finite number';
  }
  for (const [name, factor] of [
    ['sensitiveTopicFactor', config.sensitiveTopicFactor],
    ['minorFactor', config.minorFactor],
  ] as const) {
    if (!(factor > 0 && factor <= 1)) {
      return `${name} must lie in (0, 1] — factors above 1 would weaken protection`;
    }
  }
  if (!Number.isInteger(config.baseRepeatThreshold) || config.baseRepeatThreshold < 2) {
    return 'baseRepeatThreshold must be an integer >= 2';
  }
  if (!Number.isInteger(config.repeatReduction) || config.repeatReduction < 0) {
    return 'repeatReduction must be a nonnegative integer';
  }
  return null;
}

export interface PhiThresholdContext {
  sensitiveTopic: boolean;
  isMinor: boolean;
}

/** The effective PHI intervention threshold for a context (lower = stricter). */
export function effectivePhiThreshold(
  context: PhiThresholdContext,
  config: PhiThresholdConfig = DEFAULT_PHI_THRESHOLD_CONFIG,
): number {
  let threshold = config.baseThreshold;
  if (context.sensitiveTopic) threshold *= config.sensitiveTopicFactor;
  if (context.isMinor) threshold *= config.minorFactor;
  return threshold;
}

/** The effective narrow-loop repeat threshold (never below 2). */
export function effectiveRepeatThreshold(
  context: PhiThresholdContext,
  config: PhiThresholdConfig = DEFAULT_PHI_THRESHOLD_CONFIG,
): number {
  let threshold = config.baseRepeatThreshold;
  if (context.sensitiveTopic) threshold -= config.repeatReduction;
  if (context.isMinor) threshold -= config.repeatReduction;
  return Math.max(2, threshold);
}
