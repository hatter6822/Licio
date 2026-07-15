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
    ['crypto flag off', { cryptoEnabled: false }, 'unknown'],
    ['policy missing', { policy: { kind: 'missing' as const } }, 'unknown'],
    ['policy future-dated', { policy: { kind: 'future_dated' as const } }, 'unknown'],
    ['policy malformed', { policy: { kind: 'malformed' as const } }, 'unknown'],
    ['policy store down', { policy: { kind: 'store_unavailable' as const } }, 'unknown'],
  ])('%s → %s', (_label, patch, expected) => {
    expect(coarseVerdict({ ...ELIGIBLE, ...patch })).toBe(expected);
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
