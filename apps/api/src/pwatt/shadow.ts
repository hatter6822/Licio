// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shadow-mode enforcement at the RANKING BOUNDARY (WS-E.2.1e, SPEC §30.5).
// The guard does NOT trust the producer's flag alone: an invariant output is
// rejected as a ranking input when its shadow_mode flag is set OR when it is a
// PWAtt output at all (belt and braces — while §30.5 shadow staging holds, no
// PWAtt score may carry distribution power even if a flag were mislabeled).
// Lifting shadow mode is a CODE change (PWATT_V0_SHADOW_MODE in
// @licio/invariants), reviewed with WS-I and the §30.5 safety review — never a
// configuration flip.
import type { InvariantOutputRecord } from '../events/stores.js';

export class RankingBoundaryViolation extends Error {}

/** True when the output must not influence ranking or distribution. */
export function isShadowOutput(
  output: Pick<InvariantOutputRecord, 'invariantType' | 'shadowMode'>,
): boolean {
  return output.shadowMode === true || output.invariantType.startsWith('PWAtt');
}

/** Throwing guard for code paths that must never receive a shadow output. */
export function assertRankingInputAllowed(output: InvariantOutputRecord): void {
  if (isShadowOutput(output)) {
    throw new RankingBoundaryViolation(
      `shadow-mode invariant output (${output.invariantType} ${output.version}) ` +
        'rejected as a ranking input (SPEC §30.5)',
    );
  }
}

/**
 * Partition candidate invariant inputs at the ranking boundary: shadow rows
 * are rejected (reported, never silently used). The ranking pipeline consumes
 * `allowed` only.
 */
export function selectRankingInputs(outputs: readonly InvariantOutputRecord[]): {
  allowed: InvariantOutputRecord[];
  rejected: InvariantOutputRecord[];
} {
  const allowed: InvariantOutputRecord[] = [];
  const rejected: InvariantOutputRecord[] = [];
  for (const output of outputs) {
    (isShadowOutput(output) ? rejected : allowed).push(output);
  }
  return { allowed, rejected };
}
