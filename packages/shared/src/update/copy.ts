// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — the EXACT §20.6 update-trust UX copy SSOT (PRIVATE_SPEC §20.6).
// When the running private-mode bundle is not in the transparency log, not
// signed by required maintainers, differs from the pinned hash, or is stale, the
// private-room surface LOCKS (keys stay sealed) and shows this message verbatim.
// Pinned here so the lock UI (WS-S.7.5 render) and the CI gate
// (`check:update-channel`) read the same locale-ready, prohibited-language-free
// string, and a copy drift is a test failure rather than a silent regression.

/**
 * The verbatim PRIVATE_SPEC §20.6 lock message.  Do NOT soften, qualify, or
 * collapse into a false "secure" badge — the honest-UI doctrine (PRIVATE_SPEC
 * §7.7) forbids it.
 */
export const PRIVATE_BUNDLE_LOCK_MESSAGE: string =
  'Private room locked: this Licio build has not passed private-mode code ' +
  'verification. Your room keys were not unlocked. You can keep using public ' +
  'Licio, review the update, or switch to a verified build.';

/** Short label for the locked state (badge / list entry). */
export const PRIVATE_BUNDLE_LOCK_LABEL = 'Private rooms locked' as const;
