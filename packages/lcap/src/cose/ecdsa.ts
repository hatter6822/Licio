// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ES256 (P-256 / SHA-256) signing + verification with MANDATORY low-S
// canonicalization (OFFLINE_SPEC §10.1, §10.1.1).  ECDSA signatures are
// malleable: `(r, s)` and `(r, n − s)` both verify.  LCAP removes that freedom
// so a signature has exactly one valid encoding — raw fixed-width `r || s`
// (never DER), with `0 < r < n` and `0 < s ≤ n/2`.  WebCrypto already emits raw
// `r || s`; the low-S rule is applied on top.

import { getSubtle, toBufferSource } from '../runtime.js';

/** The P-256 group order n. */
export const P256_ORDER =
  0xffffffff_00000000_ffffffff_ffffffff_bce6faad_a7179e84_f3b9cac2_fc632551n;

/**
 * floor(n/2).  Because n is odd, `s ≤ n/2` (the low-S predicate) is exactly
 * `s ≤ floor(n/2)`, so `s > P256_HALF_ORDER` is the high-S test.
 */
export const P256_HALF_ORDER = P256_ORDER >> 1n;

/** Raw ES256 signature length: 32-byte r || 32-byte s. */
export const ES256_SIG_LENGTH = 64;

const ECDSA_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) {
    n = (n << 8n) | BigInt(bytes[i] as number);
  }
  return n;
}

function bigIntToBytesBE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export type SignatureRejection = 'malformed' | 'out_of_range' | 'high_s';

export type SignatureCheck =
  | { readonly ok: true; readonly r: bigint; readonly s: bigint }
  | { readonly ok: false; readonly reason: SignatureRejection };

/**
 * Decide whether `sig` is a canonical low-S ES256 signature, with a precise
 * rejection reason (§10.1.1): `malformed` (not 64 raw bytes — this also rejects
 * any DER-wrapped form, which is ≥ 70 bytes); `out_of_range` (`r`/`s` zero or
 * `≥ n`); `high_s` (`s > n/2`).  Only `0 < r < n ∧ 0 < s ≤ n/2` is accepted.
 */
export function checkCanonicalSignature(sig: Uint8Array): SignatureCheck {
  if (sig.length !== ES256_SIG_LENGTH) return { ok: false, reason: 'malformed' };
  const r = bytesToBigIntBE(sig.subarray(0, 32));
  const s = bytesToBigIntBE(sig.subarray(32, 64));
  if (r === 0n || s === 0n || r >= P256_ORDER || s >= P256_ORDER) {
    return { ok: false, reason: 'out_of_range' };
  }
  if (s > P256_HALF_ORDER) return { ok: false, reason: 'high_s' };
  return { ok: true, r, s };
}

/**
 * Normalize a raw 64-byte `r || s` signature to low-S: if `s > n/2`, replace it
 * with `n − s` (which also verifies).  Assumes a well-formed in-range raw
 * signature, as produced by `crypto.subtle.sign`.
 */
export function normalizeLowS(sig: Uint8Array): Uint8Array {
  if (sig.length !== ES256_SIG_LENGTH) {
    throw new Error(`expected ${ES256_SIG_LENGTH}-byte raw signature, got ${sig.length}`);
  }
  let s = bytesToBigIntBE(sig.subarray(32, 64));
  if (s <= P256_HALF_ORDER) return sig.slice();
  s = P256_ORDER - s;
  const out = new Uint8Array(ES256_SIG_LENGTH);
  out.set(sig.subarray(0, 32), 0);
  out.set(bigIntToBytesBE(s, 32), 32);
  return out;
}

/**
 * Sign `message` (already the full bytes to authenticate; WebCrypto applies
 * SHA-256 internally) and return a canonical low-S raw `r || s` signature.
 */
export async function signEs256(privateKey: CryptoKey, message: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await getSubtle().sign(ECDSA_PARAMS, privateKey, toBufferSource(message)),
  );
  if (raw.length !== ES256_SIG_LENGTH) {
    throw new Error(`unexpected ECDSA signature length ${raw.length}`);
  }
  return normalizeLowS(raw);
}

/**
 * The cryptographic verification step ONLY (§10.2.4 step 6).  Assumes the
 * caller has already enforced canonical low-S via `checkCanonicalSignature`
 * (§10.2.4 step 5), so the two checks can be ordered and mapped to distinct
 * statuses by the COSE verifier.
 */
export function verifyEs256Raw(
  publicKey: CryptoKey,
  message: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> {
  return getSubtle().verify(ECDSA_PARAMS, publicKey, toBufferSource(sig), toBufferSource(message));
}

/**
 * Verify `sig` over `message`: rejects any non-canonical (non-64-byte,
 * out-of-range, or high-S) signature BEFORE the cryptographic check, then
 * verifies cryptographically.  Returns a plain boolean; the COSE verifier uses
 * `checkCanonicalSignature` + `verifyEs256Raw` directly when it needs the
 * precise rejection status.
 */
export async function verifyEs256(
  publicKey: CryptoKey,
  message: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> {
  if (!checkCanonicalSignature(sig).ok) return false;
  return verifyEs256Raw(publicKey, message, sig);
}
