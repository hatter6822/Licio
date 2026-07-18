// SPDX-License-Identifier: AGPL-3.0-or-later
//
// otpauth:// URI helpers for the WS-D TOTP-enrollment surface.  The server's
// canonical enroll response spells every parameter out (secret, issuer,
// algorithm, digits, period); this module derives the two presentation forms
// the Security page renders from it:
//   • a COMPACT equivalent URI for the QR code — the spec-default parameters
//     (SHA1 / 6 digits / 30 s) are stripped, because a worst-case full URI
//     (30-char handle) exceeds the 106-byte v5-L QR capacity while the compact
//     form's worst case is exactly 104 bytes.  Non-default parameters are
//     PRESERVED (stripping those would change the codes the app generates).
//   • the bare base32 SETUP KEY, grouped for the "enter a setup key" manual
//     path every authenticator app offers.
import { z } from 'zod';

const secretSchema = z.string().regex(/^[A-Z2-7]+$/);

export interface OtpauthTotp {
  /** The base32 shared secret (unpadded RFC 4648 upper-case alphabet). */
  secret: string;
  /** The decoded label ("Licio:handle"). */
  label: string;
}

/** Parse an otpauth://totp/ URI; null when it is not one or has no valid secret. */
export function parseOtpauthTotp(uri: string): OtpauthTotp | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'otpauth:' || url.host !== 'totp') return null;
  const secret = url.searchParams.get('secret') ?? '';
  if (!secretSchema.safeParse(secret).success) return null;
  return { secret, label: decodeURIComponent(url.pathname.replace(/^\//, '')) };
}

/** The spec defaults every authenticator app assumes when the param is absent. */
const DEFAULT_PARAMS: ReadonlyArray<readonly [name: string, value: string]> = [
  ['algorithm', 'SHA1'],
  ['digits', '6'],
  ['period', '30'],
];

/**
 * An equivalent, QR-sized form of `uri`: parameters carrying their spec-default
 * value are dropped; everything else (secret, issuer, any NON-default
 * algorithm/digits/period) is kept verbatim.  Falls back to the input when it
 * is not a parseable otpauth URI — the caller then simply QR-encodes (or
 * refuses) the original.
 */
export function compactOtpauthUri(uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return uri;
  }
  if (url.protocol !== 'otpauth:') return uri;
  for (const [name, value] of DEFAULT_PARAMS) {
    if (url.searchParams.get(name)?.toUpperCase() === value) url.searchParams.delete(name);
  }
  return url.toString();
}

/** The setup key in the 4-character groups authenticator apps display. */
export function formatSetupKey(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}
