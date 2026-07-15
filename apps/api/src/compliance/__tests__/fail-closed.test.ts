// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1d — THE fail-closed release gate: the executable proof of the
// platform's most important financial-safety invariant ("no crypto in
// unknown/unsupported regions").  All eight scenarios from the plan, each an
// independent case with explicit assertions on EVERY feature being
// unavailable, plus the no-engine seam pin: with `defaultCompliancePort`,
// every answer stays `unknown`/`unavailable` — removing the engine can never
// fail open.  This suite is a required CI check (`pnpm test` blocks merge).
import { CRYPTO_FEATURE_CELLS, type JurisdictionFeaturePolicy } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../../events/stores.js';
import { defaultCompliancePort } from '../../knomosis/ports.js';
import {
  buildCompliancePort,
  type ComplianceServices,
  createInMemoryComplianceServices,
  evaluateAvailabilityForUser,
} from '../services.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const USER = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';

function makeServices(): ComplianceServices {
  return createInMemoryComplianceServices({
    configStore: new InMemoryPwattConfigStore(),
    now: () => NOW,
  });
}

/** A fully-permissive production policy document for a region. */
function permissivePolicy(region: string, policyId: string): JurisdictionFeaturePolicy {
  return {
    policy_id: policyId,
    country_or_region: region,
    feature_flags: {
      wallet_connection: 'enabled',
      testnet_transactions: 'enabled',
      production_payments: 'enabled',
      treasury_operations: 'enabled',
      governance: 'enabled',
    },
    asset_flags: { USDC: true },
    age_gate_policy: {
      wallet_connection: { required_band: 'adult' },
      testnet_transactions: { required_band: 'adult' },
      production_payments: { required_band: 'adult' },
      treasury_operations: { required_band: 'adult' },
      governance: { required_band: 'adult' },
    },
    kyc_policy: {},
    disclosure_refs: [],
    legal_approval_ref: 'LEGAL-2026-001',
    effective_at: '2026-01-01T00:00:00.000Z',
  };
}

async function insertPolicy(
  services: ComplianceServices,
  policy: JurisdictionFeaturePolicy,
): Promise<void> {
  await services.policies.insert({
    policyId: policy.policy_id,
    countryOrRegion: policy.country_or_region,
    effectiveAt: policy.effective_at,
    document: policy,
    createdAt: new Date(NOW).toISOString(),
  });
}

/** Grant the user a fully-eligible posture; scenarios then break ONE leg. */
async function fullyEligible(services: ComplianceServices, region = 'DE'): Promise<void> {
  services.knomosisFlags = () => ({ cryptoEnabled: true, governanceEnabled: true });
  services.ageBand = async () => 'adult';
  await services.declarations.upsert({
    userId: USER,
    declaredRegion: region,
    status: 'verified',
    verificationLevel: 'reviewer_verified',
    evidenceRef: null,
    verifiedAt: new Date(NOW).toISOString(),
    verifiedBy: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  await insertPolicy(services, permissivePolicy(region, '11111111-1111-4111-8111-111111111111'));
}

async function expectAllDisabled(services: ComplianceServices): Promise<void> {
  const availability = await evaluateAvailabilityForUser(services, USER);
  for (const cell of CRYPTO_FEATURE_CELLS) {
    expect(availability.features[cell].available, `${cell} must be unavailable`).toBe(false);
  }
  const verdict = await buildCompliancePort(services).jurisdiction({ userId: USER, region: null });
  expect(verdict).not.toBe('allowed');
}

describe('WS-N.1.1d — the eight fail-closed scenarios', () => {
  it('baseline sanity: the fully-eligible posture IS allowed (the suite is not vacuous)', async () => {
    const services = makeServices();
    await fullyEligible(services);
    const availability = await evaluateAvailabilityForUser(services, USER);
    for (const cell of CRYPTO_FEATURE_CELLS) {
      expect(availability.features[cell].available, `${cell} available`).toBe(true);
    }
    const verdict = await buildCompliancePort(services).jurisdiction({
      userId: USER,
      region: 'DE',
    });
    expect(verdict).toBe('allowed');
  });

  it('(1) an unknown region disables every crypto feature', async () => {
    const services = makeServices();
    await fullyEligible(services);
    // Break ONLY the region: no declaration, no locale.
    await services.declarations.delete(USER);
    services.localeRegion = async () => null;
    const availability = await evaluateAvailabilityForUser(services, USER);
    for (const cell of CRYPTO_FEATURE_CELLS) {
      expect(availability.features[cell].available).toBe(false);
      expect(availability.features[cell].disableReason).toBe('unknown_region');
    }
  });

  it('(2) no resolution basis (no declaration, no locale subtag) resolves to unknown', async () => {
    const services = makeServices();
    await fullyEligible(services);
    await services.declarations.delete(USER);
    services.localeRegion = async () => null;
    const availability = await evaluateAvailabilityForUser(services, USER);
    expect(availability.region).toBeNull();
    expect(availability.basis).toBe('unknown');
    await expectAllDisabled(services);
  });

  it('(3) a region with no policy disables every crypto feature', async () => {
    const services = makeServices();
    await fullyEligible(services);
    // Re-declare into a region with NO policy row.
    await services.declarations.upsert({
      userId: USER,
      declaredRegion: 'FR',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: null,
      verifiedAt: new Date(NOW).toISOString(),
      verifiedBy: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    const availability = await evaluateAvailabilityForUser(services, USER);
    for (const cell of CRYPTO_FEATURE_CELLS) {
      expect(availability.features[cell].available).toBe(false);
      expect(availability.features[cell].disableReason).toBe('policy_missing');
    }
    await expectAllDisabled(services);
  });

  it('(4) a future-dated policy is not used (policy_not_yet_effective)', async () => {
    const services = makeServices();
    await fullyEligible(services, 'NL');
    // Replace the NL policy with one effective TOMORROW only.
    const servicesFresh = makeServices();
    await servicesFresh.declarations.upsert({
      userId: USER,
      declaredRegion: 'NL',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: null,
      verifiedAt: new Date(NOW).toISOString(),
      verifiedBy: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    servicesFresh.knomosisFlags = () => ({ cryptoEnabled: true, governanceEnabled: true });
    servicesFresh.ageBand = async () => 'adult';
    await insertPolicy(servicesFresh, {
      ...permissivePolicy('NL', '22222222-2222-4222-8222-222222222222'),
      effective_at: new Date(NOW + 86_400_000).toISOString(),
    });
    const availability = await evaluateAvailabilityForUser(servicesFresh, USER);
    for (const cell of CRYPTO_FEATURE_CELLS) {
      expect(availability.features[cell].available).toBe(false);
      expect(availability.features[cell].disableReason).toBe('policy_not_yet_effective');
    }
    await expectAllDisabled(servicesFresh);
  });

  it('(5) an unreachable policy store disables every crypto feature', async () => {
    const services = makeServices();
    await fullyEligible(services);
    services.policies.activeForRegion = async () => {
      throw new Error('connection refused');
    };
    services.policyCache.invalidate(null);
    await expectAllDisabled(services);
  });

  it('(6) a malformed stored policy is treated as ABSENT, never partially honored', async () => {
    const services = makeServices();
    await fullyEligible(services, 'ES');
    // A raw store write bypassing validation (the adversarial case): the
    // LATEST row is malformed — the engine must treat the REGION as
    // policy-missing, not fall back to an older permissive version.
    const servicesFresh = makeServices();
    servicesFresh.knomosisFlags = () => ({ cryptoEnabled: true, governanceEnabled: true });
    servicesFresh.ageBand = async () => 'adult';
    await servicesFresh.declarations.upsert({
      userId: USER,
      declaredRegion: 'ES',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: null,
      verifiedAt: new Date(NOW).toISOString(),
      verifiedBy: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    await servicesFresh.policies.insert({
      policyId: '33333333-3333-4333-8333-333333333333',
      countryOrRegion: 'ES',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      document: { feature_flags: { wallet_override: 'enabled' }, garbage: true },
      createdAt: new Date(NOW).toISOString(),
    });
    const availability = await evaluateAvailabilityForUser(servicesFresh, USER);
    for (const cell of CRYPTO_FEATURE_CELLS) {
      expect(availability.features[cell].available).toBe(false);
      expect(availability.features[cell].disableReason).toBe('policy_missing');
    }
    await expectAllDisabled(servicesFresh);
  });

  it('(7) a minor in a fully-supported permissive region still gets all-disabled', async () => {
    const services = makeServices();
    await fullyEligible(services);
    services.ageBand = async () => 'teen_16_17';
    const availability = await evaluateAvailabilityForUser(services, USER);
    for (const cell of CRYPTO_FEATURE_CELLS) {
      expect(availability.features[cell].available).toBe(false);
      expect(availability.features[cell].disableReason).toBe('age_restricted');
    }
    const verdict = await buildCompliancePort(services).jurisdiction({
      userId: USER,
      region: 'DE',
    });
    expect(verdict).toBe('blocked'); // §19.4: minors are affirmatively excluded
  });

  it('(8) an UNVERIFIED declaration is never a basis: real funds stay verification_required', async () => {
    const services = makeServices();
    await fullyEligible(services);
    const existing = await services.declarations.get(USER);
    if (existing === null) throw new Error('declaration missing');
    await services.declarations.upsert({
      ...existing,
      status: 'pending',
      verificationLevel: 'unverified',
      verifiedAt: null,
    });
    services.localeRegion = async () => 'DE'; // the weaker rung still resolves DE
    const availability = await evaluateAvailabilityForUser(services, USER);
    expect(availability.basis).toBe('locale_subtag');
    expect(availability.features.production_payments.available).toBe(false);
    expect(availability.features.production_payments.disableReason).toBe('verification_required');
    expect(availability.features.treasury_operations.available).toBe(false);
    expect(availability.features.treasury_operations.disableReason).toBe('verification_required');
    const verdict = await buildCompliancePort(services).jurisdiction({
      userId: USER,
      region: 'DE',
    });
    expect(verdict).toBe('unknown'); // not affirmatively allowed
  });
});

describe('the no-engine seam pin (removing WS-N can never fail open)', () => {
  it('defaultCompliancePort answers unknown/unavailable on every method', async () => {
    expect(
      await defaultCompliancePort.screenAddress({ addressLower: '0xabc', deploymentId: 'd' }),
    ).toBe('unavailable');
    expect(
      await defaultCompliancePort.fraudRisk({
        userId: USER,
        actionType: 'x',
        amountMinorUnits: '1',
      }),
    ).toBe('unavailable');
    expect(await defaultCompliancePort.jurisdiction({ userId: USER, region: 'DE' })).toBe(
      'unknown',
    );
    expect(await defaultCompliancePort.walletRisk({ walletAccountId: 'w', userId: USER })).toBe(
      'unavailable',
    );
  });

  it('the global flags dominate: a permissive policy cannot enable with cryptoEnabled=false', async () => {
    const services = makeServices();
    await fullyEligible(services);
    services.knomosisFlags = () => ({ cryptoEnabled: false, governanceEnabled: false });
    const availability = await evaluateAvailabilityForUser(services, USER);
    for (const cell of CRYPTO_FEATURE_CELLS) {
      expect(availability.features[cell].available).toBe(false);
    }
    const verdict = await buildCompliancePort(services).jurisdiction({
      userId: USER,
      region: 'DE',
    });
    expect(verdict).toBe('unknown');
  });

  it('an unreadable case store HOLDS (compliance_hold), never passes', async () => {
    const services = makeServices();
    await fullyEligible(services);
    services.cases.countOpenHighRisk = async () => {
      throw new Error('store down');
    };
    const availability = await evaluateAvailabilityForUser(services, USER);
    for (const cell of CRYPTO_FEATURE_CELLS) {
      expect(availability.features[cell].available).toBe(false);
      expect(availability.features[cell].disableReason).toBe('compliance_hold');
    }
  });
});
