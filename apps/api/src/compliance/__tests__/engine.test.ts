// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1c — the pure engine: the coarse verdict truth table (blocked =
// affirmative prohibition; allowed = affirmative production eligibility;
// unknown = everything else — preserving the shipped testnet semantics), the
// per-cell availability precedence, determinism, and the asset map.
import { ALL_DISABLED_CELLS, type JurisdictionFeaturePolicy } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  type AvailabilityInput,
  coarseVerdict,
  evaluateAvailability,
  evaluateCell,
} from '../engine.js';

const POLICY: JurisdictionFeaturePolicy = {
  policy_id: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
  country_or_region: 'DE',
  feature_flags: {
    wallet_connection: 'enabled',
    testnet_transactions: 'testnet',
    production_payments: 'enabled',
    treasury_operations: 'enabled',
    governance: 'simulated',
  },
  asset_flags: { USDC: true, 'SIM-USDC': false },
  age_gate_policy: {
    wallet_connection: { required_band: 'adult' },
    testnet_transactions: { required_band: 'adult' },
    production_payments: { required_band: 'adult' },
    treasury_operations: { required_band: 'adult' },
    governance: { required_band: 'adult' },
  },
  kyc_policy: {},
  disclosure_refs: [],
  legal_approval_ref: 'LEGAL-1',
  effective_at: '2026-01-01T00:00:00.000Z',
};

const ELIGIBLE: AvailabilityInput = {
  ageBand: 'adult',
  complianceHold: false,
  region: 'DE',
  basis: 'verified_declaration',
  policy: { kind: 'active', policy: POLICY },
  cryptoEnabled: true,
  governanceEnabled: true,
  kycLevel: 'none',
};

describe('coarseVerdict — the port truth table', () => {
  it('allowed: adult + no hold + valid policy + enabled real-funds cells + verified basis + crypto on', () => {
    expect(coarseVerdict(ELIGIBLE)).toBe('allowed');
  });

  it.each([
    ['minor (teen_13_15)', { ageBand: 'teen_13_15' as const }, 'blocked'],
    ['minor (teen_16_17)', { ageBand: 'teen_16_17' as const }, 'blocked'],
    ['compliance hold', { complianceHold: true }, 'blocked'],
    ['unknown age', { ageBand: null }, 'unknown'],
    ['locale basis only', { basis: 'locale_subtag' as const }, 'unknown'],
    ['unknown basis', { basis: 'unknown' as const, region: null }, 'unknown'],
    // A resolution that FAILED (declaration-store outage) fails CLOSED — distinct
    // from an ordinary resolved-but-unknown region (thread wallet.ts:152).
    [
      'region unavailable (outage)',
      { unavailable: true, basis: 'unknown' as const, region: null },
      'blocked',
    ],
    ['crypto flag off', { cryptoEnabled: false }, 'unknown'],
    ['policy missing', { policy: { kind: 'missing' as const } }, 'unknown'],
    ['policy future-dated', { policy: { kind: 'future_dated' as const } }, 'unknown'],
    ['policy malformed', { policy: { kind: 'malformed' as const } }, 'unknown'],
    ['policy store down', { policy: { kind: 'store_unavailable' as const } }, 'unknown'],
  ])('%s → %s', (_label, patch, expected) => {
    expect(coarseVerdict({ ...ELIGIBLE, ...patch })).toBe(expected);
  });

  it('wallet_connection: an ordinary unknown ALLOWS (testnet posture) but a store OUTAGE BLOCKS (thread wallet.ts:152)', () => {
    // No region resolved (no verified declaration, no locale) — the ordinary
    // `unknown` the wallet gate passes, since linking moves no money.
    const noRegion = {
      ...ELIGIBLE,
      region: null,
      basis: 'unknown' as const,
      policy: { kind: 'missing' as const },
    };
    expect(coarseVerdict(noRegion, 'wallet_connection')).toBe('unknown');
    // The SAME shape but the declaration read FAILED: a verified-BLOCKED member
    // must not slip through while the store is down, so it fails closed.
    expect(coarseVerdict({ ...noRegion, unavailable: true }, 'wallet_connection')).toBe('blocked');
  });

  it('blocked only when EVERY cell is blocked; a testnet-only region is unknown', () => {
    const allBlocked: JurisdictionFeaturePolicy = {
      ...POLICY,
      feature_flags: {
        wallet_connection: 'blocked',
        testnet_transactions: 'blocked',
        production_payments: 'blocked',
        treasury_operations: 'blocked',
        governance: 'blocked',
      },
    };
    expect(coarseVerdict({ ...ELIGIBLE, policy: { kind: 'active', policy: allBlocked } })).toBe(
      'blocked',
    );
    const testnetOnly: JurisdictionFeaturePolicy = {
      ...POLICY,
      feature_flags: { ...ALL_DISABLED_CELLS, testnet_transactions: 'testnet' },
    };
    // The shipped semantics: not prohibited, not production-eligible —
    // testnet proceeds (`unknown` rejects only real funds).
    expect(coarseVerdict({ ...ELIGIBLE, policy: { kind: 'active', policy: testnetOnly } })).toBe(
      'unknown',
    );
  });

  it('a production cell short of enabled is never allowed', () => {
    for (const state of ['disabled', 'pending-legal', 'testnet', 'simulated'] as const) {
      const policy: JurisdictionFeaturePolicy = {
        ...POLICY,
        feature_flags: { ...POLICY.feature_flags, production_payments: state },
      };
      expect(coarseVerdict({ ...ELIGIBLE, policy: { kind: 'active', policy } })).toBe('unknown');
    }
  });
});

describe('evaluateCell — precedence and levels', () => {
  it('flag-off dominates with no jurisdiction reason (no decision was reached)', () => {
    const entry = evaluateCell({ ...ELIGIBLE, cryptoEnabled: false }, 'wallet_connection');
    expect(entry).toEqual({ state: 'enabled', available: false, disableReason: null });
  });

  it('reason precedence: age → hold → unknown region → policy absence → cell state → basis', () => {
    expect(
      evaluateCell({ ...ELIGIBLE, ageBand: 'teen_16_17', complianceHold: true }, 'governance')
        .disableReason,
    ).toBe('age_restricted');
    expect(evaluateCell({ ...ELIGIBLE, complianceHold: true }, 'governance').disableReason).toBe(
      'compliance_hold',
    );
    expect(
      evaluateCell({ ...ELIGIBLE, region: null, basis: 'unknown' }, 'governance').disableReason,
    ).toBe('unknown_region');
    expect(
      evaluateCell({ ...ELIGIBLE, policy: { kind: 'future_dated' } }, 'governance').disableReason,
    ).toBe('policy_not_yet_effective');
  });

  it('an enabled real-funds cell demands the verified basis; testnet cells accept locale', () => {
    const locale = { ...ELIGIBLE, basis: 'locale_subtag' as const };
    expect(evaluateCell(locale, 'production_payments')).toEqual({
      state: 'enabled',
      available: false,
      disableReason: 'verification_required',
    });
    expect(evaluateCell(locale, 'testnet_transactions')).toEqual({
      state: 'testnet',
      available: true,
      disableReason: null,
    });
    expect(evaluateCell(locale, 'wallet_connection')).toEqual({
      state: 'enabled',
      available: true,
      disableReason: null,
    });
  });

  it('governance needs BOTH flags', () => {
    expect(evaluateCell({ ...ELIGIBLE, governanceEnabled: false }, 'governance').available).toBe(
      false,
    );
  });
});

describe('evaluateAvailability — the full object', () => {
  it('is deterministic and carries the asset map only when crypto is on', () => {
    const first = evaluateAvailability(ELIGIBLE);
    const second = evaluateAvailability(ELIGIBLE);
    expect(second).toEqual(first);
    expect(first.assets).toEqual({ USDC: true, 'SIM-USDC': false });
    expect(first.policyId).toBe(POLICY.policy_id);
    const off = evaluateAvailability({ ...ELIGIBLE, cryptoEnabled: false });
    expect(off.assets).toEqual({});
  });
});

describe('coarseVerdict — the cell-scoped reading (WS-N.1.1c)', () => {
  it('answers for the REQUESTED cell, not the region in aggregate', () => {
    // The fixture region enables both real-funds cells but only SIMULATES
    // governance, so the region-wide reading is `allowed` while a governance
    // signature reaches no real-funds decision. Before the cell was passed,
    // that `allowed` was what a proposal_sign rode in on.
    expect(coarseVerdict(ELIGIBLE)).toBe('allowed');
    expect(coarseVerdict(ELIGIBLE, 'production_payments')).toBe('allowed');
    expect(coarseVerdict(ELIGIBLE, 'treasury_operations')).toBe('allowed');
    expect(coarseVerdict(ELIGIBLE, 'governance')).toBe('unknown');
  });

  it.each([
    ['blocked', 'blocked'],
    ['disabled', 'blocked'],
    ['pending-legal', 'blocked'],
    ['simulated', 'unknown'],
    ['testnet', 'unknown'],
    ['enabled', 'allowed'],
  ] as const)('a %s governance cell → %s', (state, expected) => {
    const input: AvailabilityInput = {
      ...ELIGIBLE,
      policy: {
        kind: 'active',
        policy: { ...POLICY, feature_flags: { ...POLICY.feature_flags, governance: state } },
      },
    };
    expect(coarseVerdict(input, 'governance')).toBe(expected);
  });

  it('a region that PROHIBITS one cell blocks it even while payments stay allowed', () => {
    const input: AvailabilityInput = {
      ...ELIGIBLE,
      policy: {
        kind: 'active',
        policy: { ...POLICY, feature_flags: { ...POLICY.feature_flags, governance: 'disabled' } },
      },
    };
    expect(coarseVerdict(input, 'production_payments')).toBe('allowed');
    expect(coarseVerdict(input, 'governance')).toBe('blocked');
    // …and the region-wide reading still says `allowed` — which is exactly why
    // the caller must name its cell.
    expect(coarseVerdict(input)).toBe('allowed');
  });

  it('the cell-scoped reading keeps every fail-closed guard', () => {
    // A missing policy reaches NO decision (the shipped testnet behavior) —
    // never a silent block or pass.
    expect(coarseVerdict({ ...ELIGIBLE, policy: { kind: 'missing' } }, 'governance')).toBe(
      'unknown',
    );
    expect(
      coarseVerdict({ ...ELIGIBLE, policy: { kind: 'malformed' } }, 'production_payments'),
    ).toBe('unknown');
    // An enabled cell still requires the verified basis, the adult band, the
    // recorded legal approval, and the global flags.
    expect(coarseVerdict({ ...ELIGIBLE, basis: 'locale_subtag' }, 'production_payments')).toBe(
      'unknown',
    );
    expect(coarseVerdict({ ...ELIGIBLE, cryptoEnabled: false }, 'production_payments')).toBe(
      'unknown',
    );
    expect(
      coarseVerdict(
        {
          ...ELIGIBLE,
          policy: { kind: 'active', policy: { ...POLICY, legal_approval_ref: null } },
        },
        'production_payments',
      ),
    ).toBe('unknown');
    // The governance cell additionally honors the global governance flag.
    const enabledGovernance: AvailabilityInput = {
      ...ELIGIBLE,
      policy: {
        kind: 'active',
        policy: { ...POLICY, feature_flags: { ...POLICY.feature_flags, governance: 'enabled' } },
      },
    };
    expect(coarseVerdict(enabledGovernance, 'governance')).toBe('allowed');
    expect(coarseVerdict({ ...enabledGovernance, governanceEnabled: false }, 'governance')).toBe(
      'unknown',
    );
    // Minor + hold outrank any cell.
    expect(coarseVerdict({ ...ELIGIBLE, ageBand: 'teen_16_17' }, 'production_payments')).toBe(
      'blocked',
    );
    expect(coarseVerdict({ ...ELIGIBLE, complianceHold: true }, 'governance')).toBe('blocked');
  });
});

describe('coarseVerdict — the asset gate (WS-N.1.1a asset_flags)', () => {
  it('a BARRED asset is blocked however open its cell is', () => {
    // The fixture region has production_payments ENABLED and bars SIM-USDC.
    expect(coarseVerdict(ELIGIBLE, 'production_payments')).toBe('allowed');
    expect(coarseVerdict(ELIGIBLE, 'production_payments', 'USDC')).toBe('allowed');
    // Before the asset was passed, this barred asset rode the cell's approval.
    expect(coarseVerdict(ELIGIBLE, 'production_payments', 'SIM-USDC')).toBe('blocked');
  });

  it('an asset the region never approved reaches no decision', () => {
    // Real funds reject `unknown`; testnet proceeds — the same posture as an
    // unaddressed cell, never a silent pass.
    expect(coarseVerdict(ELIGIBLE, 'production_payments', 'DAI')).toBe('unknown');
    const noAssets: AvailabilityInput = {
      ...ELIGIBLE,
      policy: { kind: 'active', policy: { ...POLICY, asset_flags: {} } },
    };
    expect(coarseVerdict(noAssets, 'production_payments', 'USDC')).toBe('unknown');
    // …while the cell-only question still answers for the cell.
    expect(coarseVerdict(noAssets, 'production_payments')).toBe('allowed');
  });

  it('the asset gate never overrides a prohibition or a minor', () => {
    expect(
      coarseVerdict({ ...ELIGIBLE, ageBand: 'teen_16_17' }, 'production_payments', 'USDC'),
    ).toBe('blocked');
    expect(
      coarseVerdict({ ...ELIGIBLE, complianceHold: true }, 'production_payments', 'USDC'),
    ).toBe('blocked');
    // A missing policy has no asset flags to consult: no decision.
    expect(coarseVerdict({ ...ELIGIBLE, policy: { kind: 'missing' } }, undefined, 'USDC')).toBe(
      'unknown',
    );
  });
});

describe('the KYC gate (WS-N.1.1a kyc_policy / age-gate assurance)', () => {
  /** A region that demands partner verification for its payments cell. */
  const kycRequired = (over: Partial<JurisdictionFeaturePolicy> = {}): AvailabilityInput => ({
    ...ELIGIBLE,
    policy: {
      kind: 'active',
      policy: {
        ...POLICY,
        kyc_policy: { production_payments: { verification_level: 'kyc_partner' } },
        ...over,
      },
    },
  });

  it('closes a cell whose policy demands KYC the user has not established', () => {
    const input = kycRequired();
    // Before this the requirement was a dead letter: nothing read kyc_policy,
    // so counsel could write "payments require kyc_partner" and real funds
    // would flow to an unverified user.
    expect(evaluateCell(input, 'production_payments')).toMatchObject({
      available: false,
      disableReason: 'verification_required',
    });
    expect(coarseVerdict(input, 'production_payments')).toBe('unknown');
    expect(coarseVerdict(input)).toBe('unknown'); // the region-wide reading too
    // A cell the policy does NOT gate is unaffected.
    expect(evaluateCell(input, 'treasury_operations').available).toBe(true);
  });

  it('opens the cell once the level is established', () => {
    const verified: AvailabilityInput = { ...kycRequired(), kycLevel: 'kyc_partner' };
    expect(evaluateCell(verified, 'production_payments').available).toBe(true);
    expect(coarseVerdict(verified, 'production_payments')).toBe('allowed');
  });

  it('honors the age gate’s assurance as a KYC requirement too', () => {
    const input: AvailabilityInput = {
      ...ELIGIBLE,
      policy: {
        kind: 'active',
        policy: {
          ...POLICY,
          age_gate_policy: {
            ...POLICY.age_gate_policy,
            governance: { required_band: 'adult', assurance: 'kyc_partner' },
          },
          feature_flags: { ...POLICY.feature_flags, governance: 'enabled' },
        },
      },
    };
    expect(evaluateCell(input, 'governance')).toMatchObject({
      available: false,
      disableReason: 'verification_required',
    });
    expect(coarseVerdict(input, 'governance')).toBe('unknown');
  });

  it('gates a testnet/simulated cell too — the policy asked, regardless of level', () => {
    const input = kycRequired({
      feature_flags: { ...POLICY.feature_flags, production_payments: 'testnet' },
    });
    expect(evaluateCell(input, 'production_payments')).toMatchObject({
      available: false,
      disableReason: 'verification_required',
    });
  });

  it('a policy with no kyc_policy entries gates nothing (the shipped default)', () => {
    expect(evaluateCell(ELIGIBLE, 'production_payments').available).toBe(true);
    expect(coarseVerdict(ELIGIBLE, 'production_payments')).toBe('allowed');
  });
});
