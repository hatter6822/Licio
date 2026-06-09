// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectCryptoEnabled,
  selectGovernanceEnabled,
  selectRegionEnabled,
  useFeatureFlagStore,
} from './feature-flags.js';

beforeEach(() => {
  useFeatureFlagStore.getState().reset();
});

describe('feature-flag store fail-closed defaults', () => {
  it('defaults crypto and governance to false before any hydration', () => {
    const state = useFeatureFlagStore.getState();
    expect(state.flags.cryptoEnabled).toBe(false);
    expect(state.flags.governanceEnabled).toBe(false);
    expect(state.hydrated).toBe(false);
  });
});

describe('feature-flag store hydration', () => {
  it('enables flags from a valid server response', () => {
    const ok = useFeatureFlagStore.getState().hydrate({
      cryptoEnabled: true,
      governanceEnabled: false,
      regionFlags: { 'wallet-eu': true },
    });
    expect(ok).toBe(true);
    expect(selectCryptoEnabled(useFeatureFlagStore.getState())).toBe(true);
    expect(selectRegionEnabled(useFeatureFlagStore.getState(), 'wallet-eu')).toBe(true);
    expect(useFeatureFlagStore.getState().hydrated).toBe(true);
  });

  it('fails closed on a partial/garbled response and reports failure', () => {
    // First enable, then attempt a garbled hydrate.
    useFeatureFlagStore.getState().hydrate({
      cryptoEnabled: true,
      governanceEnabled: true,
      regionFlags: {},
    });
    const ok = useFeatureFlagStore.getState().hydrate({ cryptoEnabled: 'yes' });
    expect(ok).toBe(false);
    expect(selectCryptoEnabled(useFeatureFlagStore.getState())).toBe(false);
    expect(selectGovernanceEnabled(useFeatureFlagStore.getState())).toBe(false);
    expect(useFeatureFlagStore.getState().hydrated).toBe(true);
  });

  it('treats a missing regionFlags field as invalid (fail closed)', () => {
    const ok = useFeatureFlagStore.getState().hydrate({
      cryptoEnabled: true,
      governanceEnabled: true,
    });
    expect(ok).toBe(false);
    expect(selectCryptoEnabled(useFeatureFlagStore.getState())).toBe(false);
  });
});

describe('feature-flag store jurisdiction disables', () => {
  beforeEach(() => {
    useFeatureFlagStore.getState().hydrate({
      cryptoEnabled: true,
      governanceEnabled: true,
      regionFlags: { 'gov-x': true },
    });
  });

  it('disables crypto on a jurisdiction signal', () => {
    useFeatureFlagStore.getState().disableCrypto();
    expect(selectCryptoEnabled(useFeatureFlagStore.getState())).toBe(false);
  });

  it('disables governance on a jurisdiction signal', () => {
    useFeatureFlagStore.getState().disableGovernance();
    expect(selectGovernanceEnabled(useFeatureFlagStore.getState())).toBe(false);
  });

  it('disables a single region flag, leaving others intact', () => {
    useFeatureFlagStore.getState().disableRegion('gov-x');
    expect(selectRegionEnabled(useFeatureFlagStore.getState(), 'gov-x')).toBe(false);
    // Crypto stays as hydrated; only the named region flipped.
    expect(selectCryptoEnabled(useFeatureFlagStore.getState())).toBe(true);
  });
});

describe('selectRegionEnabled', () => {
  it('treats an absent region key as disabled', () => {
    expect(selectRegionEnabled(useFeatureFlagStore.getState(), 'never-set')).toBe(false);
  });
});
