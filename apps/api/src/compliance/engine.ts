// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1c — the feature availability engine AND the production
// `CompliancePort.jurisdiction` implementation.  Deterministic given its
// inputs (auditable, replayable), and a strictly NARROWING conjunction on
// top of the global fail-closed `cryptoEnabled`/`governanceEnabled` flags —
// it can further disable, never enable.
//
// The port verdict preserves the shipped fail-closed consumer semantics
// exactly (preflight 7b, submit re-check, intent preflight, the
// `jurisdiction_supported` readiness item, kill switches):
//
//   `blocked`  — affirmative prohibition: a confirmed minor (§19.4), a
//                user-level compliance hold (open high/critical case), a
//                region whose EVERY crypto cell is `blocked` (the matrix
//                "explicitly prohibited" value), or — when the caller names
//                the cell it is about to exercise — a region that prohibits
//                THAT cell.  Rejects everywhere.
//   `allowed`  — affirmative production eligibility: adult ∧ no hold ∧ a
//                valid policy whose relevant cells are `enabled` (which
//                validatePolicy ties to recorded legal approval) ∧ the
//                VERIFIED declaration basis ∧ the global crypto flag on.
//                This is what capped/mature production readiness requires.
//   `unknown`  — everything else (fail-closed: real funds reject, testnet
//                proceeds — the shipped behavior for regions with no policy,
//                disabled/testnet cells, or an insufficient basis).
//
// CELL SCOPE (WS-N.1.1c).  A jurisdiction policy is per-cell, so the two
// readings differ and the caller picks:
//   • with a `featureCell` — the verdict speaks for THAT cell.  A region that
//     enables payments but disables `governance` answers `blocked` for a
//     `proposal_sign`, which the region-wide reading could never express: it
//     would have said `allowed` off the payments cells and let a prohibited
//     governance signature through.  Every real signed action names its cell.
//   • without one — the region-wide reading (production eligibility off the
//     two real-funds cells).  Claims no cell, so it grants no cell.
//
// ASSET SCOPE.  `asset_flags` gates the asset SEPARATELY from the cell: a
// region may permit payments and still bar one asset, so every fund-moving
// caller names the asset it would move and a barred one is `blocked` no matter
// how open its cell is.  An asset the region never approved reaches no
// decision (`unknown`).
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
  type KycVerificationLevel,
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
  /** The user's established KYC level.  `'none'` until a KYC partner is
   *  integrated (the tracked WS-N.1.1f residual), which is exactly why the
   *  engine must READ it: a policy cell that demands `kyc_partner` was
   *  otherwise satisfied by nothing at all. */
  kycLevel: KycVerificationLevel;
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

/**
 * Whether this cell demands a KYC level the user has not established.
 *
 * A policy can require partner verification two ways — `kyc_policy[cell]` and
 * the age gate's `assurance` — and BOTH were dead letters: nothing read them,
 * so counsel could write "production_payments requires kyc_partner" and real
 * funds would flow to an unverified user.  A requirement we cannot yet
 * establish (no partner is integrated) closes the cell rather than passing it.
 *
 * A `trigger_threshold_minor_units` narrows WHEN the requirement bites, but
 * the cell verdict carries no amount — and a threshold cannot make an
 * unmeetable requirement meetable, so the cell is closed either way until the
 * partner seam exists.
 */
/**
 * The asset's own verdict, or null when it has nothing to say (no asset was
 * named).  `asset_flags` is a prohibition list in its own right — a region can
 * allow payments while barring one asset — but it ranks BELOW an explicit cell
 * prohibition: a blocked cell is blocked whatever the asset.
 */
function assetGate(
  policy: JurisdictionFeaturePolicy,
  asset: string | null,
): JurisdictionVerdict | null {
  if (asset === null) return null;
  const allowed = policy.asset_flags[asset];
  if (allowed === false) return 'blocked'; // explicitly barred here
  // An asset the region never approved reaches no decision (`unknown` — real
  // funds reject, testnet proceeds), exactly like an unaddressed cell.
  if (allowed !== true) return 'unknown';
  return null;
}

function kycUnmet(
  policy: JurisdictionFeaturePolicy,
  cell: CryptoFeatureCell,
  level: KycVerificationLevel,
): boolean {
  const required =
    policy.kyc_policy[cell]?.verification_level === 'kyc_partner' ||
    policy.age_gate_policy[cell].assurance === 'kyc_partner';
  return required && level !== 'kyc_partner';
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
      if (kycUnmet(policy, cell, input.kycLevel)) return disabled('verification_required');
      return { state, available: true, disableReason: null };
    case 'simulated':
    case 'testnet':
      if (kycUnmet(policy, cell, input.kycLevel)) return disabled('verification_required');
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

/**
 * The `CompliancePort.jurisdiction` verdict (pure; see the header).  `cell`
 * scopes it to the policy cell the caller is about to exercise; `null` keeps
 * the region-wide reading.  `asset` names the asset a fund-moving action would
 * move (`null` = none), which the policy gates INDEPENDENTLY of the cell.
 */
export function coarseVerdict(
  input: AvailabilityInput,
  cell: CryptoFeatureCell | null = null,
  asset: string | null = null,
): JurisdictionVerdict {
  if (input.ageBand !== null && isMinorBand(input.ageBand)) return 'blocked';
  if (input.complianceHold) return 'blocked';
  const policy = policyOf(input.policy);
  if (policy !== null && CRYPTO_FEATURE_CELLS.every((c) => policy.feature_flags[c] === 'blocked')) {
    return 'blocked';
  }
  if (cell !== null) {
    // Cell-scoped: the region has spoken about THIS cell, so honor it.  A
    // missing/invalid policy stays `unknown` (no decision was reached — the
    // shipped testnet behavior), never a silent block or pass.
    if (policy === null) return 'unknown';
    const state = policy.feature_flags[cell];
    // A PROHIBITED cell outranks everything below, including anything the
    // asset check would say: the region has explicitly refused this feature,
    // and answering `unknown` (because the asset happens to be unlisted)
    // would downgrade a hard prohibition into a verdict testnet callers pass.
    if (state === 'blocked' || state === 'disabled' || state === 'pending-legal') {
      return 'blocked';
    }
    const assetVerdict = assetGate(policy, asset);
    if (assetVerdict !== null) return assetVerdict;
    // `enabled` is the only production-eligible state, and (like the
    // region-wide reading) it still requires the verified basis + the adult
    // band + the global flag; `simulated`/`testnet` reach no real-funds
    // decision, so they stay `unknown` and real funds keep rejecting.
    if (
      state === 'enabled' &&
      input.cryptoEnabled &&
      input.ageBand === 'adult' &&
      policy.legal_approval_ref !== null &&
      input.basis === 'verified_declaration' &&
      !kycUnmet(policy, cell, input.kycLevel) &&
      (cell !== 'governance' || input.governanceEnabled)
    ) {
      return 'allowed';
    }
    return 'unknown';
  }
  // The region-wide reading gates the asset too (no cell was named, so no
  // cell prohibition can outrank it).
  if (policy !== null) {
    const assetVerdict = assetGate(policy, asset);
    if (assetVerdict !== null) return assetVerdict;
  }
  if (
    input.cryptoEnabled &&
    input.ageBand === 'adult' &&
    !input.complianceHold &&
    policy !== null &&
    policy.legal_approval_ref !== null &&
    policy.feature_flags.production_payments === 'enabled' &&
    policy.feature_flags.treasury_operations === 'enabled' &&
    input.basis === 'verified_declaration' &&
    !kycUnmet(policy, 'production_payments', input.kycLevel) &&
    !kycUnmet(policy, 'treasury_operations', input.kycLevel)
  ) {
    return 'allowed';
  }
  return 'unknown';
}
