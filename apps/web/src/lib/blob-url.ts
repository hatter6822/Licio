// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Safe rendering of locally-minted object URLs (image/video previews shown
// before upload). `URL.createObjectURL` always returns a same-origin `blob:`
// URL, but the value derives from a user-selected File, so before it reaches a
// DOM `src` sink it passes through two independent guards:
//
//   1. Scheme validation via the URL API — `new URL(raw).protocol === 'blob:'`.
//      This is the genuine security invariant: any value that is not a browser
//      blob handle — for example a script-scheme, data, or remote URL
//      introduced by a future refactor or a tampered caller — is rejected
//      outright. Using the URL API rather than a substring test is the form the
//      platform recommends and cannot be bypassed by scheme casing or embedded
//      separators.
//
//   2. Percent-encoding via `encodeURI`. On a well-formed blob URL this is a
//      no-op (every character — scheme, origin, and UUID — is already
//      URI-safe), so the preview still loads; but any HTML metacharacter that
//      somehow reached this point is escaped, so the value can never be
//      reinterpreted as markup at the sink.
//
// Both guards are applied at the sink itself so the protection is local and
// auditable, and so static analysis can see the value is sanitized before use.

/**
 * Validate and percent-encode a single object-URL string for a DOM `src` sink.
 * Returns the sanitized URL, or `null` when `raw` is not a parseable `blob:`
 * URL. The returned string is byte-identical to a well-formed blob handle, so
 * it remains a valid argument to {@link URL.revokeObjectURL}.
 */
export function sanitizeBlobUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'blob:') return null;
  return encodeURI(parsed.href);
}

/**
 * Mint an object URL for a local file preview, returning the raw `blob:` handle
 * (so {@link URL.revokeObjectURL} matches it exactly) or `null` when the
 * platform lacks `URL.createObjectURL` or the minted value is not a `blob:` URL
 * (in which case the unusable handle is revoked before returning). The raw
 * handle must still be passed through {@link sanitizeBlobUrl} at the DOM sink.
 */
export function mintObjectUrl(file: File): string | null {
  if (typeof URL.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(file);
  if (sanitizeBlobUrl(url) === null) {
    URL.revokeObjectURL(url);
    return null;
  }
  return url;
}
