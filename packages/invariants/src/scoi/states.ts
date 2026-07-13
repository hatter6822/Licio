// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SCOI — context states (WS-H.4.1b, SPEC §10.4).
//
// Context states describe the DEGREE OF CONTEXT COLLAPSE — never content
// quality. "Weaponized" additionally requires a safety-classifier signal:
// disagreement alone can never produce it (WS-H.4.1b acceptance). A high
// SCOI always means "travel with context", never suppression of the content
// as false.

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

// The former §10.6 ranking-level/action descriptors and the per-state steward
// recommendation strings were removed together with the SCOI ranking
// constraint ladder and the WS-H.4.3d moderator context-action surface: they
// were pure descriptions with no production consumer. The context states
// themselves (above) remain the SCOI service's stored output vocabulary.
