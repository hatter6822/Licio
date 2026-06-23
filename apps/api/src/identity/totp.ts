// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RFC 6238 TOTP (and the RFC 4226 HOTP it builds on) for steward/moderator MFA
// (WS-D.1.5).  Implemented on node:crypto's HMAC primitive and validated against
// the official RFC 6238 Appendix B test vectors — this is the standard, accepted
// way to provide TOTP (a defined HMAC-truncation construction with published
// vectors), not bespoke cryptography.
//
// Also: RFC 4648 base32 for the `otpauth://` secret encoding, and single-use
// recovery codes (generated here, stored hashed by the caller).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateOneTimeCode, hashOneTimeCode } from './codes.js';

/** RFC 4648 base32 alphabet (NOT Crockford — authenticator apps expect this one). */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encode bytes as RFC 4648 base32 (no padding), for the otpauth secret. */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // keep only the un-emitted low bits (no 32-bit overflow reliance)
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Decode an RFC 4648 base32 string (padding/whitespace tolerant) back to bytes. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1; // keep only the un-emitted low bits (no 32-bit overflow reliance)
  }
  return Buffer.from(out);
}

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20; // 160-bit secret (WS-D.1.5a)

/** Generate a 160-bit TOTP secret. */
export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** Counter → 8-byte big-endian buffer (RFC 4226 moving factor). */
function counterToBuffer(counter: number): Buffer {
  const buf = Buffer.alloc(8);
  // counter fits comfortably in 53-bit safe-integer range for any realistic time.
  buf.writeBigUInt64BE(BigInt(Math.floor(counter)));
  return buf;
}

/**
 * RFC 4226 HOTP: dynamic-truncate an HMAC into a `digits`-digit code.
 * `algorithm` is configurable only to exercise the SHA-256/512 RFC 6238 vectors;
 * production MFA uses the default SHA-1 that authenticator apps implement.
 */
export function hotp(
  secret: Buffer,
  counter: number,
  digits: number = TOTP_DIGITS,
  algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1',
): string {
  const hmac = createHmac(algorithm, secret).update(counterToBuffer(counter)).digest();
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const binary =
    (((hmac[offset] as number) & 0x7f) << 24) |
    (((hmac[offset + 1] as number) & 0xff) << 16) |
    (((hmac[offset + 2] as number) & 0xff) << 8) |
    ((hmac[offset + 3] as number) & 0xff);
  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

/** The TOTP step index for an epoch-millisecond instant. */
export function totpStep(epochMs: number, stepSeconds: number = TOTP_STEP_SECONDS): number {
  return Math.floor(epochMs / 1000 / stepSeconds);
}

/** Compute the TOTP code for a given instant. */
export function totp(
  secret: Buffer,
  epochMs: number = Date.now(),
  digits: number = TOTP_DIGITS,
  stepSeconds: number = TOTP_STEP_SECONDS,
  algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1',
): string {
  return hotp(secret, totpStep(epochMs, stepSeconds), digits, algorithm);
}

export interface TotpVerifyResult {
  valid: boolean;
  /** The matched step index (for replay tracking, WS-D.1.5b), or null if invalid. */
  step: number | null;
}

/**
 * Verify a presented TOTP code within ±`window` steps (default ±1, ~±30s drift).
 * Returns the matched step so the caller can reject a code REPLAYED within the
 * same step (replay prevention, WS-D.1.5b).  Comparison is constant-time.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  epochMs: number = Date.now(),
  window = 1,
  digits: number = TOTP_DIGITS,
  stepSeconds: number = TOTP_STEP_SECONDS,
): TotpVerifyResult {
  const trimmed = code.trim();
  const current = totpStep(epochMs, stepSeconds);
  for (let delta = -window; delta <= window; delta += 1) {
    const expected = hotp(secret, current + delta, digits);
    if (
      expected.length === trimmed.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(trimmed))
    ) {
      return { valid: true, step: current + delta };
    }
  }
  return { valid: false, step: null };
}

/** Build an `otpauth://totp/...` provisioning URI for QR display (issuer "Licio"). */
export function otpauthUri(secret: Buffer, accountName: string, issuer = 'Licio'): string {
  const secretB32 = base32Encode(secret);
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export const RECOVERY_CODE_COUNT = 10;

/** Generate `count` single-use recovery codes (Crockford base32, hyphenated). */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = generateOneTimeCode(10);
    // Group as XXXXX-XXXXX for legibility; normalization strips the hyphen on use.
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Hash a recovery code for at-rest storage (single-use; same normalization as OTC). */
export function hashRecoveryCode(code: string): string {
  return hashOneTimeCode(code);
}
