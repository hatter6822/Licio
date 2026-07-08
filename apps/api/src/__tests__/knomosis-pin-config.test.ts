// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.1.1a/1.1a-1 pin loader + WS-L runtime config: the pin file validates,
// sentinel commit/hash values are LOCAL-only (fail-closed for testnet/prod),
// the allowlist is exact-match + case-insensitive, and the runtime config is
// fail-closed (defaults kept on invalid stored values; crypto never flips ON
// on a read error).

import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import {
  DEFAULT_KNOMOSIS_CONFIG,
  loadKnomosisConfig,
  storeKnomosisConfigValue,
  validateKnomosisConfigValue,
} from '../knomosis/config.js';
import {
  isContractAllowed,
  KNOMOSIS_PIN,
  parsePinConfig,
  pinnedDeployment,
} from '../knomosis/pin.js';

describe('WS-L.1.1a pin loader', () => {
  it('the shipped pin file validates and carries the local deployment', () => {
    expect(KNOMOSIS_PIN.deployments.length).toBeGreaterThan(0);
    const local = KNOMOSIS_PIN.deployments[0];
    expect(local?.environment).toBe('local');
    // The dev deployment is scoped to the Knomosis L2 (8357), settling to its
    // Sepolia L1 (11155111) — NOT a local-anvil or mainnet chain.
    expect(local?.chain_id).toBe(8357);
    expect(local?.l1_chain_id).toBe(11155111);
    // Every registered action type has a reversibility statement (WS-L.2.6a).
    for (const actionType of [
      'proposal_sign',
      'treasury_deposit',
      'grant_payout',
      'charter_update',
      'bounty_contribution',
      'steward_rotation',
    ]) {
      expect(local?.reversibility[actionType as keyof typeof local.reversibility]).toBeDefined();
    }
  });

  it('accepts sentinel commit/hashes ONLY for environment=local (fail closed)', () => {
    const base = KNOMOSIS_PIN.deployments[0];
    if (!base) throw new Error('no local deployment');
    // Same sentinel values but environment=testnet must be rejected.
    expect(() =>
      parsePinConfig({
        ...KNOMOSIS_PIN,
        deployments: [{ ...base, environment: 'testnet' }],
      }),
    ).toThrow();
  });

  it('requires the verifying contract + bridge to be on the allowlist', () => {
    const base = KNOMOSIS_PIN.deployments[0];
    if (!base) throw new Error('no local deployment');
    expect(() =>
      parsePinConfig({
        ...KNOMOSIS_PIN,
        deployments: [
          { ...base, contract_allowlist: ['0x0000000000000000000000000000000000000099'] },
        ],
      }),
    ).toThrow();
  });

  it('rejects two NON-RETIRED deployments for the same (environment, chain_id) (G2)', () => {
    const base = KNOMOSIS_PIN.deployments[0];
    if (!base) throw new Error('no local deployment');
    // Two active rows for the same env/chain (distinct ids) → collides with the DB
    // active-only partial unique index; the pin validator must reject it.
    expect(() =>
      parsePinConfig({
        ...KNOMOSIS_PIN,
        deployments: [base, { ...base, deployment_id: crypto.randomUUID() }],
      }),
    ).toThrow();
    // A RETIRED duplicate alongside the active one is allowed (the index excludes
    // retired), so a rotated-away deployment can stay pinned for audit.
    expect(() =>
      parsePinConfig({
        ...KNOMOSIS_PIN,
        deployments: [base, { ...base, deployment_id: crypto.randomUUID(), status: 'retired' }],
      }),
    ).not.toThrow();
  });

  it('allowlist lookups are exact-match and case-insensitive', () => {
    const local = KNOMOSIS_PIN.deployments[0];
    if (!local) throw new Error('no local deployment');
    const allowed = local.contract_allowlist[0] as string;
    expect(isContractAllowed(local.deployment_id, allowed)).toBe(true);
    expect(isContractAllowed(local.deployment_id, allowed.toUpperCase())).toBe(true);
    expect(
      isContractAllowed(local.deployment_id, '0x0000000000000000000000000000000000009999'),
    ).toBe(false);
    // Unknown deployment fails closed.
    expect(isContractAllowed('unknown-id', allowed)).toBe(false);
  });

  it('pinnedDeployment returns undefined for an unknown id (fail closed)', () => {
    expect(pinnedDeployment('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });
});

describe('WS-L runtime config (fail-closed)', () => {
  it('defaults have the crypto/governance flags OFF', () => {
    expect(DEFAULT_KNOMOSIS_CONFIG.cryptoEnabled).toBe(false);
    expect(DEFAULT_KNOMOSIS_CONFIG.governanceEnabled).toBe(false);
  });

  it('a valid stored value overrides the default; an invalid one is ignored', async () => {
    const store = new InMemoryPwattConfigStore();
    await storeKnomosisConfigValue(store, 'cryptoEnabled', true);
    await storeKnomosisConfigValue(store, 'maxWalletsPerUser', 'not-a-number');
    const rejected: string[] = [];
    const config = await loadKnomosisConfig(store, (key) => rejected.push(key));
    expect(config.cryptoEnabled).toBe(true);
    expect(config.maxWalletsPerUser).toBe(DEFAULT_KNOMOSIS_CONFIG.maxWalletsPerUser);
    expect(rejected).toContain('maxWalletsPerUser');
  });

  it('a config-store read failure keeps crypto OFF (never flips ON)', async () => {
    const failing = {
      get: async () => {
        throw new Error('store outage');
      },
      set: async () => {},
      clear: async () => {},
    };
    const config = await loadKnomosisConfig(failing);
    expect(config.cryptoEnabled).toBe(false);
    expect(config.governanceEnabled).toBe(false);
  });

  it('validateKnomosisConfigValue rejects unknown keys and bad values', () => {
    expect(validateKnomosisConfigValue('cryptoEnabled', true)).toBeNull();
    expect(validateKnomosisConfigValue('cryptoEnabled', 'yes')).not.toBeNull();
    expect(validateKnomosisConfigValue('unknown_key', 1)).not.toBeNull();
    expect(validateKnomosisConfigValue('highValueThresholdMinorUnits', '100')).toBeNull();
    expect(validateKnomosisConfigValue('highValueThresholdMinorUnits', '-5')).not.toBeNull();
  });
});
