// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SCOI — context states and ranking actions (WS-H.4.1b/WS-H.4.2e,
// SPEC §10.4/§10.6).
//
// Context states describe the DEGREE OF CONTEXT COLLAPSE — never content
// quality. "Weaponized" additionally requires a safety-classifier signal:
// disagreement alone can never produce it (WS-H.4.1b acceptance). Ranking
// actions are pure descriptions; while SCOI is in shadow they are computed
// and logged but never applied (WS-H.1.2e), and "high SCOI" always means
// "travel with context", never suppression of the content as false.

export const SCOI_CONTEXT_STATES = [
  'coherent',
  'ambiguous',
  'split',
  'obstructed',
  'weaponized',
] as const;
export type ScoiContextState = (typeof SCOI_CONTEXT_STATES)[number];

export interface ScoiStateThresholds {
  /** SCOI at or above ⇒ at least ambiguous. */
  ambiguous: number;
  split: number;
  obstructed: number;
}

export const DEFAULT_SCOI_STATE_THRESHOLDS: ScoiStateThresholds = {
  ambiguous: 0.15,
  split: 0.4,
  obstructed: 0.7,
};

export function validateScoiStateThresholds(t: ScoiStateThresholds): string | null {
  if (![t.ambiguous, t.split, t.obstructed].every((v) => Number.isFinite(v) && v > 0 && v < 1)) {
    return 'SCOI state thresholds must lie strictly inside (0, 1)';
  }
  if (!(t.ambiguous < t.split && t.split < t.obstructed)) {
    return 'SCOI state thresholds must satisfy ambiguous < split < obstructed';
  }
  return null;
}

/**
 * Deterministic state assignment. `safetySignal` is the trust-and-safety
 * weaponization indicator (inflammatory-use classifier or steward report)
 * — required, together with at-least-split disagreement, for `weaponized`.
 */
export function contextStateForScore(
  scoi: number,
  safetySignal: boolean,
  thresholds: ScoiStateThresholds = DEFAULT_SCOI_STATE_THRESHOLDS,
): ScoiContextState {
  if (safetySignal && scoi >= thresholds.split) return 'weaponized';
  if (scoi >= thresholds.obstructed) return 'obstructed';
  if (scoi >= thresholds.split) return 'split';
  if (scoi >= thresholds.ambiguous) return 'ambiguous';
  return 'coherent';
}

/** SPEC §10.6 ranking levels. */
export const SCOI_RANKING_LEVELS = ['low', 'medium', 'high', 'very_high'] as const;
export type ScoiRankingLevel = (typeof SCOI_RANKING_LEVELS)[number];

export function rankingLevelForState(state: ScoiContextState): ScoiRankingLevel {
  switch (state) {
    case 'coherent':
      return 'low';
    case 'ambiguous':
      return 'medium';
    case 'split':
      return 'high';
    case 'obstructed':
    case 'weaponized':
      return 'very_high';
    default: {
      const exhaustive: never = state;
      throw new Error(`unknown context state ${String(exhaustive)}`);
    }
  }
}

/** SPEC §10.6 ranking actions, as pure descriptions (promotion-gated). */
export interface ScoiRankingAction {
  requireContextCard: boolean;
  reduceCrossCommunityAmplification: boolean;
  prioritizeBridgeRouting: boolean;
}

export function rankingActionForLevel(level: ScoiRankingLevel): ScoiRankingAction {
  switch (level) {
    case 'low':
      return {
        requireContextCard: false,
        reduceCrossCommunityAmplification: false,
        prioritizeBridgeRouting: false,
      };
    case 'medium':
      return {
        requireContextCard: true,
        reduceCrossCommunityAmplification: false,
        prioritizeBridgeRouting: false,
      };
    case 'high':
      return {
        requireContextCard: true,
        reduceCrossCommunityAmplification: true,
        prioritizeBridgeRouting: false,
      };
    case 'very_high':
      return {
        requireContextCard: true,
        reduceCrossCommunityAmplification: true,
        prioritizeBridgeRouting: true,
      };
    default: {
      const exhaustive: never = level;
      throw new Error(`unknown ranking level ${String(exhaustive)}`);
    }
  }
}

/** Steward-report recommendation per state (WS-H.4.1c). */
export function stewardRecommendationForState(state: ScoiContextState): string {
  switch (state) {
    case 'coherent':
      return 'No action needed — interpretations agree across lenses.';
    case 'ambiguous':
      return 'Add a context-card prompt: some readers are missing background.';
    case 'split':
      return 'Show the lens map before commenting and invite a bridge comment.';
    case 'obstructed':
      return 'Slow cross-community spread and request bridge/synthesis contributions.';
    case 'weaponized':
      return 'Escalate for review: ambiguity is being used to inflame conflict.';
    default: {
      const exhaustive: never = state;
      throw new Error(`unknown context state ${String(exhaustive)}`);
    }
  }
}
