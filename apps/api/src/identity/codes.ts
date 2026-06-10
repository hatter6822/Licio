// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-time codes for passwordless email sign-in / email-factor verification
// (WS-D.1.4a/b).  Codes are Crockford base32 — 8 chars ≈ 40 bits — chosen over a
// 6-digit numeric so the online-guessing space is ~10^5× larger while staying easy
// to type.  Codes are stored ONLY as sha256(code); a Redis read yields nothing
// replayable.  Comparison is constant-time.
import { randomBytes } from 'node:crypto';
import { constantTimeEqual, sha256Hex } from './crypto.js';

/**
 * Crockford base32 alphabet (excludes I, L, O, U to avoid confusables).  Exactly
 * 32 symbols, so a uniformly-random byte mod 32 maps with ZERO modulo bias
 * (256 = 8 × 32) — no rejection sampling needed.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Default code length: 8 symbols ≈ 41 bits of entropy. */
export const ONE_TIME_CODE_LENGTH = 8;

/** Generate a uniformly-random Crockford-base32 one-time code. */
export function generateOneTimeCode(length: number = ONE_TIME_CODE_LENGTH): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    // 256 % 32 === 0 ⇒ (byte % 32) is uniform over [0,32) with no bias.
    code += CROCKFORD_ALPHABET[(bytes[i] as number) % 32];
  }
  return code;
}

/**
 * Normalize a user-entered code to the canonical comparison form: upper-case,
 * Crockford confusable folding (I/L → 1, O → 0), and removal of spaces/hyphens a
 * user might add.  An unrepresentable character is left as-is so the subsequent
 * hash comparison fails closed rather than silently matching.
 */
export function normalizeOneTimeCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[ILO]/g, (c) => (c === 'O' ? '0' : '1'));
}

/** Hash a code for at-rest storage (sha256 of the normalized form). */
export function hashOneTimeCode(code: string): string {
  return sha256Hex(normalizeOneTimeCode(code));
}

/**
 * Verify a presented code against a stored hash in constant time.  The presented
 * code is normalized then hashed; the comparison never short-circuits on content.
 */
export function verifyOneTimeCode(presented: string, storedHash: string): boolean {
  return constantTimeEqual(hashOneTimeCode(presented), storedHash);
}
