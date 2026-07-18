// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1a-2 — the policy sub-shape suite: strict rejection of missing cells,
// wrong types, unknown/injected keys, booleans-where-cell-states, and raw
// minimum ages; the §19.4 band-only age gate; and the `validatePolicy`
// aggregate (field paths + the enable-requires-legal-approval invariant +
// the shared-asset-registry check).
import { describe, expect, it } from 'vitest';
import {
  ALL_DISABLED_CELLS,
  ageGatePolicySchema,
  CRYPTO_FEATURE_CELLS,
  DEFAULT_AGE_GATE_POLICY,
  FEATURE_DISABLE_REASONS,
  featureCellStatesSchema,
  type JurisdictionFeaturePolicy,
  jurisdictionFeaturePolicySchema,
  kycPolicySchema,
  policyChangeRequiresCounsel,
  REGION_RESOLUTION_BASES,
  regionCodeSchema,
  validatePolicy,
} from '../schemas/jurisdiction.js';

const VALID_POLICY = {
  policy_id: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
  country_or_region: 'US-CA',
  feature_flags: { ...ALL_DISABLED_CELLS, testnet_transactions: 'testnet' },
  asset_flags: { USDC: true },
  age_gate_policy: DEFAULT_AGE_GATE_POLICY,
  kyc_policy: {
    production_payments: {
      verification_level: 'kyc_partner',
      trigger_threshold_minor_units: '1000000000',
      trigger_asset: 'USDC',
    },
  },
  disclosure_refs: [{ id: 'risk-general', version: 1, locales: ['en'] }],
  legal_approval_ref: 'LEGAL-2026-014',
  effective_at: '2026-07-01T00:00:00.000Z',
};

describe('region codes (WS-N.1.1a)', () => {
  it('accepts ISO alpha-2, sub-national, and grouping keys', () => {
    for (const code of ['US', 'US-CA', 'EU', 'GB', 'XX']) {
      expect(regionCodeSchema.safeParse(code).success).toBe(true);
    }
  });
  it('rejects lowercase, one-char, and edge-hyphen codes', () => {
    for (const code of ['us', 'U', '-US', 'US-', 'u s', '']) {
      expect(regionCodeSchema.safeParse(code).success).toBe(false);
    }
  });
});

describe('feature cell states (WS-N.1.1a-2 sub-shape 1)', () => {
  it('accepts exactly the five ratified cells with closed-vocabulary values', () => {
    expect(featureCellStatesSchema.safeParse(ALL_DISABLED_CELLS).success).toBe(true);
  });
  it('rejects a missing cell', () => {
    const { governance: _drop, ...partial } = ALL_DISABLED_CELLS;
    expect(featureCellStatesSchema.safeParse(partial).success).toBe(false);
  });
  it('rejects an unknown/injected key (configuration-injection vector)', () => {
    expect(
      featureCellStatesSchema.safeParse({ ...ALL_DISABLED_CELLS, wallet_override: 'enabled' })
        .success,
    ).toBe(false);
  });
  it('rejects booleans — the vocabulary is six-valued, never boolean', () => {
    expect(
      featureCellStatesSchema.safeParse({ ...ALL_DISABLED_CELLS, wallet_connection: true }).success,
    ).toBe(false);
  });
  it('rejects values outside the closed vocabulary', () => {
    expect(
      featureCellStatesSchema.safeParse({ ...ALL_DISABLED_CELLS, governance: 'maybe' }).success,
    ).toBe(false);
  });
});

describe('age gates are BAND-based (WS-N.1.1a-2 sub-shape 3, §19.4)', () => {
  it('the default requires the adult band for every crypto cell', () => {
    expect(Object.keys(DEFAULT_AGE_GATE_POLICY).sort()).toEqual([...CRYPTO_FEATURE_CELLS].sort());
    for (const cell of CRYPTO_FEATURE_CELLS) {
      expect(DEFAULT_AGE_GATE_POLICY[cell].required_band).toBe('adult');
    }
    expect(ageGatePolicySchema.safeParse(DEFAULT_AGE_GATE_POLICY).success).toBe(true);
  });
  it('a raw minimum-age integer is NOT expressible (no DOB exists to evaluate)', () => {
    expect(
      ageGatePolicySchema.safeParse({
        ...DEFAULT_AGE_GATE_POLICY,
        wallet_connection: { required_band: 'adult', min_age: 21 },
      }).success,
    ).toBe(false);
    expect(
      ageGatePolicySchema.safeParse({
        ...DEFAULT_AGE_GATE_POLICY,
        wallet_connection: 21,
      }).success,
    ).toBe(false);
  });
  it('only the adult band is expressible for a crypto cell', () => {
    expect(
      ageGatePolicySchema.safeParse({
        ...DEFAULT_AGE_GATE_POLICY,
        governance: { required_band: 'teen_16_17' },
      }).success,
    ).toBe(false);
  });
  it('the kyc_partner age-assurance marker is accepted', () => {
    expect(
      ageGatePolicySchema.safeParse({
        ...DEFAULT_AGE_GATE_POLICY,
        production_payments: { required_band: 'adult', assurance: 'kyc_partner' },
      }).success,
    ).toBe(true);
  });
});

describe('kyc policy (WS-N.1.1a-2 sub-shape 4)', () => {
  it('thresholds are exact minor-unit integer strings, never floats', () => {
    expect(
      kycPolicySchema.safeParse({
        production_payments: { verification_level: 'none', trigger_threshold_minor_units: '1.5' },
      }).success,
    ).toBe(false);
    expect(
      kycPolicySchema.safeParse({
        production_payments: {
          verification_level: 'kyc_partner',
          trigger_threshold_minor_units: '150000000',
        },
      }).success,
    ).toBe(true);
  });
  it('rejects unknown cells and unknown keys', () => {
    expect(kycPolicySchema.safeParse({ staking: { verification_level: 'none' } }).success).toBe(
      false,
    );
  });
});

describe('validatePolicy (WS-N.1.1a-2)', () => {
  it('accepts a fully-valid policy', () => {
    expect(validatePolicy(VALID_POLICY)).toEqual({
      ok: true,
      policy: jurisdictionFeaturePolicySchema.parse(VALID_POLICY),
    });
  });
  it('aggregates shape errors with field paths', () => {
    const result = validatePolicy({
      ...VALID_POLICY,
      feature_flags: { ...ALL_DISABLED_CELLS, governance: 'perhaps' },
      country_or_region: 'us',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.problems.map((p) => p.path);
      expect(paths).toContain('feature_flags.governance');
      expect(paths).toContain('country_or_region');
    }
  });
  it('rejects an enabled cell without recorded legal approval (ratified invariant)', () => {
    const result = validatePolicy({
      ...VALID_POLICY,
      feature_flags: { ...ALL_DISABLED_CELLS, production_payments: 'enabled' },
      legal_approval_ref: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.path).toBe('feature_flags.production_payments');
    }
  });
  it('rejects asset flags outside the shared asset registry', () => {
    const result = validatePolicy({ ...VALID_POLICY, asset_flags: { DOGE: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]?.path).toBe('asset_flags.DOGE');
  });
});

describe('engine vocabulary', () => {
  it('resolution bases are ordered strongest-first and closed', () => {
    expect(REGION_RESOLUTION_BASES).toEqual(['verified_declaration', 'locale_subtag', 'unknown']);
  });
  it('disable reasons carry the seven WS-N.1.1c values', () => {
    expect(FEATURE_DISABLE_REASONS).toHaveLength(7);
    expect(FEATURE_DISABLE_REASONS).toContain('verification_required');
  });
});

describe('policyChangeRequiresCounsel (WS-N.1.1e write-gate delta; codex: compare policy deltas before requiring counsel)', () => {
  // A counsel-approved region with production payments live and a testnet cell.
  const ENABLED_PRIOR = jurisdictionFeaturePolicySchema.parse({
    ...VALID_POLICY,
    feature_flags: {
      ...ALL_DISABLED_CELLS,
      production_payments: 'enabled',
      testnet_transactions: 'testnet',
    },
  });
  const NEXT_ID = '7a9619ff-8b86-4d01-b42d-00cf4fc964aa';
  /** A replacement document derived from ENABLED_PRIOR (new policy row). */
  function replacement(overrides: Partial<JurisdictionFeaturePolicy> = {}) {
    return jurisdictionFeaturePolicySchema.parse({
      ...VALID_POLICY,
      feature_flags: ENABLED_PRIOR.feature_flags,
      policy_id: NEXT_ID,
      effective_at: '2026-08-01T00:00:00.000Z',
      ...overrides,
    });
  }

  it('no counsel for a write with no enabled cell — with or without a prior', () => {
    const narrowOnly = jurisdictionFeaturePolicySchema.parse(VALID_POLICY);
    expect(policyChangeRequiresCounsel(null, narrowOnly).required).toBe(false);
    expect(policyChangeRequiresCounsel(ENABLED_PRIOR, narrowOnly).required).toBe(false);
  });

  it('with NO active prior (missing/future-dated/nonconforming ⇒ null), every enabled cell is an expansion', () => {
    const delta = policyChangeRequiresCounsel(null, ENABLED_PRIOR);
    expect(delta.required).toBe(true);
    expect(delta.newlyEnabledCells).toEqual(['production_payments']);
  });

  it('carrying an approved enabled cell FORWARD while narrowing another is NOT an enablement (the codex scenario)', () => {
    const narrowing = replacement({
      feature_flags: {
        ...ENABLED_PRIOR.feature_flags,
        testnet_transactions: 'disabled', // the narrowed cell
      },
    });
    const delta = policyChangeRequiresCounsel(ENABLED_PRIOR, narrowing);
    expect(delta.required).toBe(false);
    expect(delta.newlyEnabledCells).toEqual([]);
    expect(delta.changedGoverningFields).toEqual([]);
  });

  it('a non-enabled → enabled transition requires counsel even when other cells were already enabled', () => {
    const expanding = replacement({
      feature_flags: {
        ...ENABLED_PRIOR.feature_flags,
        treasury_operations: 'enabled',
      },
    });
    const delta = policyChangeRequiresCounsel(ENABLED_PRIOR, expanding);
    expect(delta.required).toBe(true);
    expect(delta.newlyEnabledCells).toEqual(['treasury_operations']);
  });

  it('while a cell REMAINS enabled, its legal terms stay counsel-controlled (no sideways widening)', () => {
    // Each governed field changed in isolation trips the gate.
    const widenAssets = replacement({ asset_flags: { USDC: true, ETH: true } });
    expect(policyChangeRequiresCounsel(ENABLED_PRIOR, widenAssets)).toMatchObject({
      required: true,
      changedGoverningFields: ['asset_flags'],
    });
    const dropKyc = replacement({ kyc_policy: {} });
    expect(policyChangeRequiresCounsel(ENABLED_PRIOR, dropKyc)).toMatchObject({
      required: true,
      changedGoverningFields: ['kyc_policy'],
    });
    const dropDisclosures = replacement({ disclosure_refs: [] });
    expect(policyChangeRequiresCounsel(ENABLED_PRIOR, dropDisclosures)).toMatchObject({
      required: true,
      changedGoverningFields: ['disclosure_refs'],
    });
    const swapApproval = replacement({ legal_approval_ref: 'LEGAL-2026-999' });
    expect(policyChangeRequiresCounsel(ENABLED_PRIOR, swapApproval)).toMatchObject({
      required: true,
      changedGoverningFields: ['legal_approval_ref'],
    });
  });

  it('narrowing EVERY enabled cell away releases the governed fields (nothing enabled remains to govern)', () => {
    const fullNarrow = replacement({
      feature_flags: { ...ALL_DISABLED_CELLS },
      kyc_policy: {}, // changed AND no cell remains enabled
      legal_approval_ref: null,
    });
    expect(policyChangeRequiresCounsel(ENABLED_PRIOR, fullNarrow).required).toBe(false);
  });

  it('the comparison is key-order-insensitive for record shapes', () => {
    // Same asset flags, reversed literal insertion order.
    const prior = jurisdictionFeaturePolicySchema.parse({
      ...VALID_POLICY,
      feature_flags: { ...ALL_DISABLED_CELLS, production_payments: 'enabled' },
      asset_flags: { USDC: true, ETH: true },
    });
    const next = jurisdictionFeaturePolicySchema.parse({
      ...VALID_POLICY,
      policy_id: NEXT_ID,
      effective_at: '2026-08-01T00:00:00.000Z',
      feature_flags: { ...ALL_DISABLED_CELLS, production_payments: 'enabled' },
      asset_flags: { ETH: true, USDC: true },
    });
    expect(policyChangeRequiresCounsel(prior, next).required).toBe(false);
  });
});
