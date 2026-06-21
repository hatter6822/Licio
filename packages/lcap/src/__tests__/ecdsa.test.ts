// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.0.5a — ES256 low-S sign/verify.  Signatures are always emitted low-S;
// the rejection matrix is exact (malformed / out-of-range / high-S); and the
// malleability twin (r, n−s) — which is cryptographically valid — is rejected
// by `verifyEs256` precisely because the canonical check runs before the
// cryptographic verification.

import { describe, expect, it } from 'vitest';
import {
  checkCanonicalSignature,
  ES256_SIG_LENGTH,
  P256_HALF_ORDER,
  P256_ORDER,
  signEs256,
  verifyEs256,
  verifyEs256Raw,
} from '../cose/ecdsa.js';
import { generateDeviceKey } from '../cose/keys.js';

function toBE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function sigFrom(r: bigint, s: bigint): Uint8Array {
  const out = new Uint8Array(ES256_SIG_LENGTH);
  out.set(toBE(r, 32), 0);
  out.set(toBE(s, 32), 32);
  return out;
}

describe('canonical low-S check (§10.1.1)', () => {
  it('accepts only 0 < r < n ∧ 0 < s ≤ n/2', () => {
    expect(checkCanonicalSignature(sigFrom(1n, 1n)).ok).toBe(true);
    expect(checkCanonicalSignature(sigFrom(1n, P256_HALF_ORDER)).ok).toBe(true); // s = n/2 is low
  });

  it('rejects with the exact reason at each boundary', () => {
    const reason = (sig: Uint8Array): string => {
      const check = checkCanonicalSignature(sig);
      return check.ok ? 'ok' : check.reason;
    };
    expect(reason(new Uint8Array(70))).toBe('malformed'); // DER-shaped / wrong length
    expect(reason(sigFrom(0n, 1n))).toBe('out_of_range'); // r = 0
    expect(reason(sigFrom(1n, 0n))).toBe('out_of_range'); // s = 0
    expect(reason(sigFrom(P256_ORDER, 1n))).toBe('out_of_range'); // r = n
    expect(reason(sigFrom(1n, P256_ORDER))).toBe('out_of_range'); // s = n
    expect(reason(sigFrom(1n, P256_HALF_ORDER + 1n))).toBe('high_s'); // s = n/2 + 1
    expect(reason(sigFrom(1n, P256_ORDER - 1n))).toBe('high_s');
  });
});

describe('sign/verify round-trip + malleability defense', () => {
  it('always emits low-S and round-trips', async () => {
    const { publicKey, privateKey } = await generateDeviceKey();
    for (let i = 0; i < 16; i++) {
      const message = new TextEncoder().encode(`message ${i}`);
      const sig = await signEs256(privateKey, message);
      expect(checkCanonicalSignature(sig).ok).toBe(true); // low-S by construction
      expect(await verifyEs256(publicKey, message, sig)).toBe(true);
    }
  });

  it('rejects the high-S malleability twin even though it is crypto-valid', async () => {
    const { publicKey, privateKey } = await generateDeviceKey();
    const message = new TextEncoder().encode('malleability');
    const low = await signEs256(privateKey, message);

    let r = 0n;
    let s = 0n;
    for (let i = 0; i < 32; i++) r = (r << 8n) | BigInt(low[i] as number);
    for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(low[i] as number);
    const high = sigFrom(r, P256_ORDER - s); // (r, n − s)

    // The twin is cryptographically valid (proves it is a real ECDSA signature)…
    expect(await verifyEs256Raw(publicKey, message, high)).toBe(true);
    // …but rejected by the canonical-first verifier.
    const check = checkCanonicalSignature(high);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('high_s');
    expect(await verifyEs256(publicKey, message, high)).toBe(false);
  });

  it('fails verification for a wrong message or a malformed signature', async () => {
    const { publicKey, privateKey } = await generateDeviceKey();
    const sig = await signEs256(privateKey, new TextEncoder().encode('a'));
    expect(await verifyEs256(publicKey, new TextEncoder().encode('b'), sig)).toBe(false);
    expect(await verifyEs256(publicKey, new TextEncoder().encode('a'), new Uint8Array(64))).toBe(
      false,
    );
  });
});
