// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GWEI — Gromov–Wasserstein Experience Isometry (WS-H.5, SPEC §9).

export * from './gw.js';
export * from './metrics.js';
export * from './space.js';

export const GWEI_VERSION = '1.0.0';

/**
 * Release-gate decision (WS-H.5.2c, SPEC §9.5): a launch is blocked when
 * any protected cohort's experience distance to its baseline exceeds the
 * cohort's threshold, unless a documented sign-off overrides. Pure; the
 * experiment harness (WS-P) supplies the measured distances.
 */
export interface CohortGateInput {
  cohortKey: string;
  /** GW distance between the cohort's old- and new-algorithm experiences. */
  distance: number;
  /** Per-cohort threshold (stricter for minors/language minorities). */
  threshold: number;
  protectedCohort: boolean;
}

export interface ReleaseGateDecision {
  blocked: boolean;
  violations: Array<{ cohortKey: string; distance: number; threshold: number }>;
  overridden: boolean;
  overrideOwner: string | null;
}

export function evaluateReleaseGate(
  cohorts: readonly CohortGateInput[],
  override?: { owner: string; justification: string } | undefined,
): ReleaseGateDecision {
  const violations = cohorts
    .filter((c) => c.protectedCohort && c.distance > c.threshold)
    .map((c) => ({ cohortKey: c.cohortKey, distance: c.distance, threshold: c.threshold }));
  const overridden = violations.length > 0 && override !== undefined;
  return {
    blocked: violations.length > 0 && !overridden,
    violations,
    overridden,
    overrideOwner: overridden ? (override?.owner ?? null) : null,
  };
}
