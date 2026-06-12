// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shadow-mode enforcement at the FALLBACK ranking boundary (WS-E.2.1e, SPEC
// §30.5). Post-lift role: `rankFrontPageV0` is the WS-I SAFE FALLBACK's
// ordering (freshness-only), and this guard is what makes the fallback
// provably score-blind — it rejects an invariant output when its shadow_mode
// flag is set OR when it is a PWAtt output AT ALL (belt and braces: the
// fallback must ignore every PWAtt value even post-lift, so engaging the
// kill switch instantly restores the pre-lift posture). The WS-I ranked
// pipeline is the SINGLE sanctioned PWAtt consumer, behind its own gates:
// the §30.5 code-level lift (PWATT_V0_SHADOW_MODE in @licio/invariants), the
// row-level `shadow_mode: false` check in ranking/features.ts, the WS-H
// promotion gate for every penalty/constraint, and the WS-I.3 neutrality
// suite. Reverting the lift remains a CODE change, never a config flip.
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
