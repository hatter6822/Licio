// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.5 / WS-S.10.2b — the §20.6 update-trust LOCK UI (PRIVATE_SPEC §20.6,
// §7.7).  A guard wrapper the private-room surface mounts AROUND any view that
// would unlock room keys.  It consults the verify-before-unlock gate
// (`useUpdateGate`):
//
//   * `checking` — the bundle verification is in flight; render a neutral
//     loading placeholder (NEVER the children — fail-closed: a slow check must
//     not momentarily expose room content);
//   * `locked` — the running Licio build did not pass private-mode code
//     verification; render the VERBATIM §20.6 lock copy (the honest-UI doctrine
//     §7.7 forbids softening it into a "secure" badge) and DO NOT render the
//     children, so no room key is unlocked;
//   * `trusted` — render the children (the real private-room view).
//
// This is the NEW guard the routes/views consume per the strict file-ownership
// rule: it reads the existing `gate.ts` state via `useUpdateGate` and renders
// the existing `PRIVATE_BUNDLE_LOCK_MESSAGE` SSOT verbatim; it never touches the
// room-manager / sync-session / connect-peer internals.

import { PRIVATE_BUNDLE_LOCK_LABEL, PRIVATE_BUNDLE_LOCK_MESSAGE } from '@licio/shared';
import type { ReactNode } from 'react';
import { useT } from '../../i18n/index.js';
import {
  type AssertTrustedDeps,
  isUpdateChannelConfigured,
  useUpdateGate,
} from '../../update/index.js';
import { LoadingState } from '../ui/LoadingState/index.js';
import { RestrictedState } from '../ui/RestrictedState/index.js';

export interface PrivateBundleGuardProps {
  /** The private-room content shown ONLY when the bundle verdict is trusted. */
  readonly children: ReactNode;
  /** Disable the gate (e.g. for a public-only surface that never unlocks keys). */
  readonly enabled?: boolean;
  /** Inject a config/fetch for tests (passed straight to the gate). */
  readonly deps?: AssertTrustedDeps;
  /** Heading level so the lock state fits its surrounding hierarchy. */
  readonly headingLevel?: 2 | 3 | 4;
}

/**
 * Block a private-room view behind the verify-before-unlock gate.  Renders the
 * verbatim §20.6 lock copy on an untrusted verdict and a loading placeholder
 * while the verification is in flight; renders `children` only on a `trusted`
 * verdict (fail-closed default).
 *
 * The gate ENGAGES only when the update channel is CONFIGURED — a maintainer
 * signer set pinned into this build (`isUpdateChannelConfigured`, the same
 * predicate the room-manager's key-unlock chokepoint applies, so the guard UI
 * and the engine can never disagree).  An UNCONFIGURED build (dev/test, an
 * unpinned deployment) renders the children with the control not engaged: dev
 * serves no hashed chunk and no signed manifest, so verification there can
 * never succeed, and a pinned set cannot be unconfigured by an attacker at
 * runtime (it is baked into the bundle).  A production release MUST pin the
 * signer set to engage the control (docs/DEVELOPMENT.md §17.2).
 */
export function PrivateBundleGuard({
  children,
  enabled = true,
  deps,
  headingLevel = 2,
}: PrivateBundleGuardProps): React.ReactElement {
  const t = useT();
  const configured = isUpdateChannelConfigured(deps?.config);
  const gate = useUpdateGate({ enabled: enabled && configured, ...(deps ? { deps } : {}) });

  // A disabled gate (no private rooms / public surface) renders children as-is;
  // so does an UNCONFIGURED channel (control not engaged — see the doc above).
  if (!enabled || !configured) return <>{children}</>;

  if (gate.status === 'checking') {
    return (
      <LoadingState rows={1} label={t('privateBundle.checking', 'Verifying this Licio build…')} />
    );
  }

  if (gate.locked) {
    // Render the EXACT §20.6 copy verbatim (the SSOT message), never the room.
    return (
      <RestrictedState
        title={PRIVATE_BUNDLE_LOCK_LABEL}
        reason={gate.message ?? PRIVATE_BUNDLE_LOCK_MESSAGE}
        headingLevel={headingLevel}
      />
    );
  }

  return <>{children}</>;
}
