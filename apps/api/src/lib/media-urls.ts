// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.2c — signed read URLs for restricted media.  Public media is served
// from a stable bare `/v1/uploads/:id` path; media belonging to a `room_only`
// story is served only through a short-lived, HMAC-signed URL minted AFTER the
// read-bar check (so an outsider never receives one).  The token binds the
// upload id and an expiry under a dedicated key domain (never shared with the
// DSAR download-token domain), and the serving route recomputes + constant-time
// compares it — so a token cannot be forged, rebound to another upload, or used
// past expiry.  Revocation: the owning story's takedown/visibility is re-checked
// at fetch time (immediate), and rotating SESSION_SECRET invalidates every
// outstanding token (global).  Honest limit (SPEC §14.5.7): a member who already
// holds a valid URL can fetch until it expires — in-room visibility bounds
// distribution, it is not a secrecy guarantee.
import { constantTimeEqual, deriveKey, hmacHex, KEY_DOMAINS } from '../identity/crypto.js';
import { getIdentityServices } from '../identity/services.js';

/** Signed-URL lifetime — long enough for one viewing session (incl. video range
 *  re-fetches/seeks), short enough to bound an already-issued URL.  Fresh URLs
 *  are minted on every feed/story response. */
export const MEDIA_URL_TTL_MS = 2 * 60 * 60_000; // 2 hours

function mediaTokenPayload(uploadId: string, expiresAt: number): string {
  // uploadId is a UUID (fixed 36-char, dash-only) so the '.' separator is
  // unambiguous — no two distinct (uploadId, expiry) pairs collide.
  return `${uploadId}.${expiresAt}`;
}

/** HMAC-SHA256 (hex) over `(uploadId, expiresAt)` under the media-token key. */
export function signMediaToken(secret: string, uploadId: string, expiresAt: number): string {
  return hmacHex(deriveKey(secret, KEY_DOMAINS.mediaToken), mediaTokenPayload(uploadId, expiresAt));
}

/** True iff `sig` is the valid, unexpired signature for `(uploadId, expiresAt)`. */
export function verifyMediaToken(
  secret: string,
  uploadId: string,
  expiresAt: number,
  sig: string,
  now: number,
): boolean {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  return constantTimeEqual(sig, signMediaToken(secret, uploadId, expiresAt));
}

/** The stable, bare read path for an upload (public media + contribution
 *  attachments, which carry no story-scoped restriction). */
export function mediaUrlPath(uploadId: string): string {
  return `/v1/uploads/${uploadId}`;
}

/** A signed, expiring read path for a restricted (room_only) upload. */
export function signedMediaUrlPath(secret: string, uploadId: string, now: number): string {
  const expiresAt = now + MEDIA_URL_TTL_MS;
  return `${mediaUrlPath(uploadId)}?e=${expiresAt}&t=${signMediaToken(secret, uploadId, expiresAt)}`;
}

/** Mints the wire read URL for one media upload: bare for public media, signed
 *  for restricted (room_only) media. */
export type MediaUrlMinter = (uploadId: string, restricted: boolean) => string;

/**
 * A production minter bound to `now`.  The signing secret is read lazily, and
 * ONLY for restricted media, so public-only projections never touch the identity
 * service container (and unit tests inject their own {@link MediaUrlMinter}).
 */
export function makeMediaUrlMinter(now: number = Date.now()): MediaUrlMinter {
  return (uploadId, restricted) =>
    restricted
      ? signedMediaUrlPath(getIdentityServices().config.masterSecret, uploadId, now)
      : mediaUrlPath(uploadId);
}
