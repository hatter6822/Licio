// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Feature-flag store (WS-C.1.3c, SPEC §0.5 constraint 10 / M1 gate "Wallet
// disabled"). Crypto and governance default to OFF and FAIL CLOSED: any error,
// offline state, or partial/garbled server response leaves every optional flag
// off. Flags are NEVER persisted — a server-side disable (e.g. a jurisdiction
// turning crypto off) must take effect immediately and cannot be overridden by
// a stale cache. Flags only ever move toward "off" outside of explicit,
// validated server hydration.
import { FAIL_CLOSED_FLAGS, type FeatureFlags, featureFlagsResponseSchema } from '@licio/shared';
import { create } from 'zustand';

export interface FeatureFlagState {
  flags: FeatureFlags;
  /** Whether a hydration attempt (success or failure) has completed this session. */
  hydrated: boolean;
  /**
   * Hydrate from a server response. Validates first; on ANY validation failure
   * the flags are reset to the fail-closed defaults (never partially trusted)
   * and `false` is returned. Returns `true` only on a fully valid response.
   */
  hydrate: (raw: unknown) => boolean;
  /** A `jurisdiction.feature.disabled` (§21.3) signal flips crypto off. */
  disableCrypto: () => void;
  /** Flip governance off (jurisdiction disable). */
  disableGovernance: () => void;
  /** Flip a single region flag off. */
  disableRegion: (key: string) => void;
  /** Restore the fail-closed defaults (e.g. on logout). */
  reset: () => void;
}

export const useFeatureFlagStore = create<FeatureFlagState>((set) => ({
  flags: FAIL_CLOSED_FLAGS,
  hydrated: false,
  hydrate: (raw) => {
    const parsed = featureFlagsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      // Garbled/partial response ⇒ fail closed, never partially trusted.
      set({ flags: FAIL_CLOSED_FLAGS, hydrated: true });
      return false;
    }
    set({ flags: parsed.data, hydrated: true });
    return true;
  },
  disableCrypto: () => set((state) => ({ flags: { ...state.flags, cryptoEnabled: false } })),
  disableGovernance: () =>
    set((state) => ({ flags: { ...state.flags, governanceEnabled: false } })),
  disableRegion: (key) =>
    set((state) => ({
      flags: { ...state.flags, regionFlags: { ...state.flags.regionFlags, [key]: false } },
    })),
  reset: () => set({ flags: FAIL_CLOSED_FLAGS, hydrated: false }),
}));

export function selectCryptoEnabled(state: FeatureFlagState): boolean {
  return state.flags.cryptoEnabled;
}

export function selectGovernanceEnabled(state: FeatureFlagState): boolean {
  return state.flags.governanceEnabled;
}

/** A region flag is enabled only if explicitly present and true (absent ⇒ off). */
export function selectRegionEnabled(state: FeatureFlagState, key: string): boolean {
  return state.flags.regionFlags[key] === true;
}

/** WS-Q.6.2 — the content-room rollout surface (flags + video caps). Fail-closed
 *  by construction: an un-hydrated store returns the OFF/hard-ceiling defaults. */
export function selectContentSurface(
  state: FeatureFlagState,
): FeatureFlagState['flags']['content'] {
  return state.flags.content;
}
