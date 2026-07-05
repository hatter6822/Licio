// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The single external-navigation primitive shared by every link-safety surface
// (the UGC sink `UgcBody` and the `SafeExternalLink` used for citation/source
// links).  Opening a destination in a new tab severs the opener so the
// destination can never reach back into the app (`window.opener` reverse
// tabnabbing), and a popup-blocked open is reported to the caller (which offers
// a fresh user gesture) instead of failing silently.
//
// The `noopener` FEATURE STRING is deliberately NOT used: per spec it makes
// `window.open` return null even on success, which would make popup blocking
// undetectable.  Nulling `opener` on the returned proxy gives the same security
// property while keeping the block observable.

/** Open `href` in a new tab with the opener severed; `onBlocked` fires when the
 *  popup was blocked (a falsy return — spec-compliant blocking, or jsdom). */
export function openExternal(href: string, onBlocked: () => void): void {
  const opened = window.open(href, '_blank');
  if (!opened) {
    onBlocked();
    return;
  }
  opened.opener = null;
}
