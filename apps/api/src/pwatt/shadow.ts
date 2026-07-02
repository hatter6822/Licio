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
import { PWATT_V0_SHADOW_MODE } from '@licio/invariants';
import type { InvariantOutputRecord } from '../events/stores.js';

export class RankingBoundaryViolation extends Error {}

/** A usable (non-degraded) output: fallback rows with hard failure reason
 *  codes and zero-coverage rows are ABSENT for ranking (WS-H.1.2c). Every stage
 *  that reads a stored invariant output applies this identical rule. */
export function usable(row: InvariantOutputRecord | null): InvariantOutputRecord | null {
  if (row === null) return null;
  if (row.reasonCodes.includes('TIMEOUT') || row.reasonCodes.includes('COMPUTE_ERROR')) {
    return null;
  }
  if (row.reasonCodes.includes('INSUFFICIENT_COVERAGE')) return null;
  return row;
}

/**
 * The §30.5 bounded-input gate for a stored PWAtt row, applied IDENTICALLY at
 * EVERY stage that consumes a PWAtt row for a SERVED value (the feature join,
 * the retrieval-side eligibility read, AND the harassment-freeze component pin).
 * A row is serving ONLY when the code-level lift holds (`PWATT_V0_SHADOW_MODE
 * === false`), the row itself was written post-lift (`shadowMode === false`),
 * and it is not degraded (`usable`). Otherwise ABSENT — a §30.5 revert, a
 * pre-lift shadow row, or a degraded compute uniformly withholds PWAtt, so no
 * non-serving value can be laundered into a served component anywhere.
 */
export function pwattRowForRanking(
  row: InvariantOutputRecord | null,
): InvariantOutputRecord | null {
  if ((PWATT_V0_SHADOW_MODE as boolean) !== false) return null;
  const ok = usable(row);
  if (ok === null || ok.shadowMode !== false) return null;
  return ok;
}

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
