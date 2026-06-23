// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2a/b — the private-mode update-channel client surface.  The app
// consults `useUpdateGate()` (or `assertPrivateBundleTrusted()` directly) to
// verify the running private-mode bundle against the transparency log BEFORE
// unlocking room keys, and `installSwUpdatePinning()` to refuse a silent SW
// takeover by an unverified build.  The pure verifier lives in `@licio/shared`
// (`verifyUpdateManifest`); this tree is the I/O + SW + React glue.

export {
  computeRunningBundleDigest,
  discoverPrivateBundleUrl,
} from './bundle-digest.js';
export {
  loadUpdateChannelConfig,
  PRIVATE_BUNDLE_ARTIFACT_ID,
  UPDATE_MANIFEST_PATH,
  type UpdateChannelConfig,
  withRotatedSigners,
} from './config.js';
export {
  type AssertTrustedDeps,
  assertPrivateBundleTrusted,
  isPrivateBundleLocked,
  type PrivateBundleGateState,
  privateBundleGateState,
  requirePrivateBundleTrusted,
  resetPrivateBundleGate,
  subscribePrivateBundleGate,
} from './gate.js';
export {
  gateServiceWorkerActivation,
  installSwUpdatePinning,
  type UpdateActivationGate,
} from './sw-pinning.js';
export { type UpdateGate, useUpdateGate } from './useUpdateGate.js';
