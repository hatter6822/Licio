// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1c — the feature availability engine AND the production
// `CompliancePort.jurisdiction` implementation.  Deterministic given its
// inputs (auditable, replayable), and a strictly NARROWING conjunction on
// top of the global fail-closed `cryptoEnabled`/`governanceEnabled` flags —
// it can further disable, never enable.
//
// The coarse port verdict preserves the shipped fail-closed consumer
// semantics exactly (preflight 7b, submit re-check, intent preflight, the
// `jurisdiction_supported` readiness item, kill switches):
//
//   `blocked`  — affirmative prohibition: a confirmed minor (§19.4), a
//                user-level compliance hold (open high/critical case), or a
//                region whose EVERY crypto cell is `blocked` (the matrix
//                "explicitly prohibited" value).  Rejects everywhere.
//   `allowed`  — affirmative production eligibility: adult ∧ no hold ∧ a
//                valid policy with BOTH real-funds cells (`production_
//                payments`, `treasury_operations`) `enabled` (which
//                validatePolicy ties to recorded legal approval) ∧ the
//                VERIFIED declaration basis ∧ the global crypto flag on.
//                This is what capped/mature production readiness requires.
//   `unknown`  — everything else (fail-closed: real funds reject, testnet
//                proceeds — the shipped behavior for regions with no policy,
//                disabled/testnet cells, or an insufficient basis).
//
// The verified-basis requirement for the real-funds cells is DELIBERATELY
// hard-coded, not configurable: with no geolocated baseline (§19.1), the
// WS-N.1.1f verification IS the anti-circumvention control, and a config
// key that could waive it would be a fail-open lever (WS-N.1.1b).
import {
  type AgeBand,
  CRYPTO_FEATURE_CELLS,
  type CryptoFeatureCell,
  type FeatureDisableReason,
  isMinorBand,
  type JurisdictionCellState,
  type JurisdictionFeaturePolicy,
  type RegionResolutionBasis,
} from '@licio/shared';
import type { JurisdictionVerdict } from '../knomosis/ports.js';
import type { ActivePolicyOutcome } from './policy.js';

/** The pure evaluation input — assembled by the service layer. */
export interface AvailabilityInput {
  ageBand: AgeBand | null;
  /** An open high/critical-risk case targets the user (WS-N.2.1a). */
  complianceHold: boolean;
  region: string | null;
  basis: RegionResolutionBasis;
  policy: ActivePolicyOutcome;
  cryptoEnabled: boolean;
  governanceEnabled: boolean;
}

export interface FeatureAvailabilityEntry {
  state: JurisdictionCellState | null;
  available: boolean;
  disableReason: FeatureDisableReason | null;
}

export interface FeatureAvailability {
  region: string | null;
  basis: RegionResolutionBasis;
  policyId: string | null;
  cryptoEnabled: boolean;
  governanceEnabled: boolean;
  features: Record<CryptoFeatureCell, FeatureAvailabilityEntry>;
  assets: Record<string, boolean>;
}

/** The real-funds cells whose `enabled` state requires the verified basis. */
const REAL_FUNDS_CELLS: ReadonlySet<CryptoFeatureCell> = new Set([
  'production_payments',
  'treasury_operations',
]);

function policyOf(outcome: ActivePolicyOutcome): JurisdictionFeaturePolicy | null {
  return outcome.kind === 'active' ? outcome.policy : null;
}

function policyMissingReason(outcome: ActivePolicyOutcome): FeatureDisableReason {
  return outcome.kind === 'future_dated' ? 'policy_not_yet_effective' : 'policy_missing';
}

/** Per-cell availability (pure; deterministic).  Reason precedence: age →
 *  hold → unknown region → policy absence → cell state → basis. */
export function evaluateCell(
  input: AvailabilityInput,
  cell: CryptoFeatureCell,
): FeatureAvailabilityEntry {
  const policy = policyOf(input.policy);
  const state = policy === null ? null : policy.feature_flags[cell];
  const disabled = (reason: FeatureDisableReason | null): FeatureAvailabilityEntry => ({
    state,
    available: false,
    disableReason: reason,
  });
  // The global flags dominate (narrowing conjunction): no jurisdiction reason
  // is reported because no jurisdiction decision was reached.
  if (!input.cryptoEnabled) return disabled(null);
  if (cell === 'governance' && !input.governanceEnabled) return disabled(null);
  // §19.4 band gate: every crypto cell requires the confirmed adult band
  // (unknown age fails closed to the same reason).
  if (input.ageBand !== 'adult') return disabled('age_restricted');
  if (input.complianceHold) return disabled('compliance_hold');
  if (input.region === null) return disabled('unknown_region');
  if (policy === null) return disabled(policyMissingReason(input.policy));
  switch (state) {
    case 'blocked':
    case 'disabled':
    case 'pending-legal':
      return disabled('region_unsupported');
    case 'enabled':
      if (REAL_FUNDS_CELLS.has(cell) && input.basis !== 'verified_declaration') {
        return disabled('verification_required');
      }
      return { state, available: true, disableReason: null };
    case 'simulated':
    case 'testnet':
      // Available at the cell's own declared level (the mode machine keeps a
      // `testnet` cell out of production — WS-M readiness requires `allowed`).
      return { state, available: true, disableReason: null };
    default:
      return disabled('policy_missing');
  }
}

/** The full availability object (WS-N.1.1c; served to the client + regionFlags). */
export function evaluateAvailability(input: AvailabilityInput): FeatureAvailability {
  const policy = policyOf(input.policy);
  const features = Object.fromEntries(
    CRYPTO_FEATURE_CELLS.map((cell) => [cell, evaluateCell(input, cell)]),
  ) as Record<CryptoFeatureCell, FeatureAvailabilityEntry>;
  const assets: Record<string, boolean> = {};
  if (policy !== null && input.cryptoEnabled) {
    for (const [asset, enabled] of Object.entries(policy.asset_flags)) {
      assets[asset] = enabled === true;
    }
  }
  return {
    region: input.region,
    basis: input.basis,
    policyId: policy?.policy_id ?? null,
    cryptoEnabled: input.cryptoEnabled,
    governanceEnabled: input.governanceEnabled,
    features,
    assets,
  };
}

/** The coarse `CompliancePort.jurisdiction` verdict (pure; see the header). */
export function coarseVerdict(input: AvailabilityInput): JurisdictionVerdict {
  if (input.ageBand !== null && isMinorBand(input.ageBand)) return 'blocked';
  if (input.complianceHold) return 'blocked';
  const policy = policyOf(input.policy);
  if (
    policy !== null &&
    CRYPTO_FEATURE_CELLS.every((cell) => policy.feature_flags[cell] === 'blocked')
  ) {
    return 'blocked';
  }
  if (
    input.cryptoEnabled &&
    input.ageBand === 'adult' &&
    !input.complianceHold &&
    policy !== null &&
    policy.legal_approval_ref !== null &&
    policy.feature_flags.production_payments === 'enabled' &&
    policy.feature_flags.treasury_operations === 'enabled' &&
    input.basis === 'verified_declaration'
  ) {
    return 'allowed';
  }
  return 'unknown';
}
