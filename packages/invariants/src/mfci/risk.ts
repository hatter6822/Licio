// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MFCI — risk states and their (promotion-gated) effects
// (WS-H.3.4a/WS-H.3.4a-2, SPEC §8.5).
//
// Risk states derive from MFCI score thresholds; the default thresholds are
// the −log p̂ values of p̂ = 0.05 / 0.005 / 0.0005. Upward transitions follow
// the score immediately; DOWNWARD transitions require either a fiber test
// that cleared the case or an analyst override — a freeze never silently
// melts (WS-H.3.4a acceptance).
//
// Effects are pure DESCRIPTIONS here. While MFCI is in shadow they are
// computed and logged but never applied (the WS-H.1.2e promotion gate and
// the ranking boundary both enforce that); each effect is individually
// switchable at the application layer.

export const MFCI_RISK_STATES = ['normal', 'elevated', 'high', 'severe'] as const;
export type MfciRiskState = (typeof MFCI_RISK_STATES)[number];

export interface MfciRiskThresholds {
  /** MFCI (= −log p̂) at or above which the state is at least `elevated`. */
  elevated: number;
  high: number;
  severe: number;
}

export const DEFAULT_MFCI_RISK_THRESHOLDS: MfciRiskThresholds = {
  elevated: -Math.log(0.05), // ≈ 3.00
  high: -Math.log(0.005), // ≈ 5.30
  severe: -Math.log(0.0005), // ≈ 7.60
};

export function validateMfciRiskThresholds(t: MfciRiskThresholds): string | null {
  if (![t.elevated, t.high, t.severe].every((v) => Number.isFinite(v) && v > 0)) {
    return 'risk thresholds must be positive finite numbers';
  }
  if (!(t.elevated < t.high && t.high < t.severe)) {
    return 'risk thresholds must satisfy elevated < high < severe';
  }
  return null;
}

/** State implied by a score alone (no hysteresis). */
export function riskStateForScore(
  score: number,
  thresholds: MfciRiskThresholds = DEFAULT_MFCI_RISK_THRESHOLDS,
): MfciRiskState {
  if (score >= thresholds.severe) return 'severe';
  if (score >= thresholds.high) return 'high';
  if (score >= thresholds.elevated) return 'elevated';
  return 'normal';
}

const RISK_ORDER: Record<MfciRiskState, number> = {
  normal: 0,
  elevated: 1,
  high: 2,
  severe: 3,
};

export interface RiskTransitionEvidence {
  /** The exact fiber test cleared the observed pattern. */
  fiberTestCleared?: boolean | undefined;
  /** A named analyst resolved the case downward. */
  analystOverride?: boolean | undefined;
}

export interface RiskTransition {
  from: MfciRiskState;
  to: MfciRiskState;
  changed: boolean;
  /** Why a downward move was allowed (or why it was held). */
  reason: 'score' | 'fiber_cleared' | 'analyst_override' | 'held_pending_review';
}

/**
 * Apply a new score to the current state. Upward moves follow the score;
 * downward moves are held at the current state until cleared or overridden.
 */
export function nextRiskState(
  current: MfciRiskState,
  score: number,
  thresholds: MfciRiskThresholds = DEFAULT_MFCI_RISK_THRESHOLDS,
  evidence: RiskTransitionEvidence = {},
): RiskTransition {
  const implied = riskStateForScore(score, thresholds);
  if (RISK_ORDER[implied] >= RISK_ORDER[current]) {
    return { from: current, to: implied, changed: implied !== current, reason: 'score' };
  }
  if (evidence.fiberTestCleared) {
    return { from: current, to: implied, changed: implied !== current, reason: 'fiber_cleared' };
  }
  if (evidence.analystOverride) {
    return {
      from: current,
      to: implied,
      changed: implied !== current,
      reason: 'analyst_override',
    };
  }
  return { from: current, to: current, changed: false, reason: 'held_pending_review' };
}

/** SPEC §8.5 ranking effects, as pure descriptions (WS-H.3.4a-2). */
export interface MfciRankingEffect {
  /** Multiplier < 1 dampens distribution; 1 = no effect. */
  distributionDampening: number;
  freezeTrendAcceleration: boolean;
  limitCrossCommunitySpread: boolean;
}

/** SPEC §8.5 moderator effects, as pure descriptions. */
export interface MfciModeratorEffect {
  passiveMonitoring: boolean;
  reviewQueue: boolean;
  immediateIntegrityReview: boolean;
}

export interface MfciEffectConfig {
  /** Dampening multiplier applied at `elevated` (default 0.5). */
  elevatedDampening: number;
}

export const DEFAULT_MFCI_EFFECT_CONFIG: MfciEffectConfig = { elevatedDampening: 0.5 };

export function rankingEffectForState(
  state: MfciRiskState,
  config: MfciEffectConfig = DEFAULT_MFCI_EFFECT_CONFIG,
): MfciRankingEffect {
  switch (state) {
    case 'normal':
      return {
        distributionDampening: 1,
        freezeTrendAcceleration: false,
        limitCrossCommunitySpread: false,
      };
    case 'elevated':
      return {
        distributionDampening: config.elevatedDampening,
        freezeTrendAcceleration: false,
        limitCrossCommunitySpread: false,
      };
    case 'high':
      return {
        distributionDampening: config.elevatedDampening,
        freezeTrendAcceleration: true,
        limitCrossCommunitySpread: false,
      };
    case 'severe':
      return {
        distributionDampening: config.elevatedDampening,
        freezeTrendAcceleration: true,
        limitCrossCommunitySpread: true,
      };
    default: {
      const exhaustive: never = state;
      throw new Error(`unknown risk state ${String(exhaustive)}`);
    }
  }
}

export function moderatorEffectForState(state: MfciRiskState): MfciModeratorEffect {
  return {
    passiveMonitoring: RISK_ORDER[state] >= RISK_ORDER.elevated,
    reviewQueue: RISK_ORDER[state] >= RISK_ORDER.high,
    immediateIntegrityReview: state === 'severe',
  };
}
