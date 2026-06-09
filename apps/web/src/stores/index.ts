// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Zustand client-state stores (WS-C.1.3). Auth (session status, never the
// token), UI (the accessibility-adapter surface), and feature flags (fail-closed
// crypto/governance gating).
export {
  type AuthState,
  type AuthStatus,
  initAuthSync,
  selectIsAuthenticated,
  selectIsRestricted,
  useAuthStore,
} from './auth.js';
export { applyMotion, applyTheme } from './dom-sync.js';
export {
  type FeatureFlagState,
  selectCryptoEnabled,
  selectGovernanceEnabled,
  selectRegionEnabled,
  useFeatureFlagStore,
} from './feature-flags.js';
export { clearPersisted, loadPersisted, type PersistConfig, savePersisted } from './persist.js';
export {
  initUIStore,
  type MotionPreference,
  type SheetState,
  type ThemePreference,
  type UIState,
  useUIStore,
} from './ui.js';
