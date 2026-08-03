// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The arithmetic must agree with an actual decoder, or it is a guess about
// base64url rather than a fact about it.  So the property test below builds the
// answer the slow way — decode, re-encode, compare — and asserts the constant-
// work check matches it on every spelling of a key.
import { describe, expect, it } from 'vitest';
import { fromBase64Url } from '../update/crypto.js';
import { base64UrlLength, isCanonicalBase64Url } from './base64url-identity.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A plain unpadded base64url encoder — the reference the check is measured
 *  against. `@licio/shared` is browser-safe, so no `Buffer` here (and the
 *  runtime's own decoder is what ignores the slack bits, which is the premise
 *  under test). */
function encode(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET[(acc >> bits) & 0x3f];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (6 - bits)) & 0x3f];
  return out;
}

/** Decode-and-re-encode: the definition `isCanonicalBase64Url` stands in for. */
function reEncodes(value: string): boolean {
  try {
    return encode(fromBase64Url(value)) === value;
  } catch {
    return false;
  }
}

/** Bytes → hex, for showing two spellings decode to the same key. */
function hex(value: string): string {
  return [...fromBase64Url(value)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const KEY = 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI';
const SIGNATURE = encode(new Uint8Array(64).fill(7));

describe('canonical base64url identity', () => {
  it('measures the exact unpadded length of a byte count', () => {
    expect(base64UrlLength(32)).toBe(43);
    expect(base64UrlLength(64)).toBe(86);
    expect(base64UrlLength(33)).toBe(44);
  });

  it('accepts what an encoder produces', () => {
    expect(isCanonicalBase64Url(KEY, 32)).toBe(true);
    expect(isCanonicalBase64Url(SIGNATURE, 64)).toBe(true);
    expect(reEncodes(KEY)).toBe(true);
  });

  it('rejects the three OTHER spellings of the same 32-byte key', () => {
    // The final character carries 2 unused low bits, so the four characters at
    // alphabet indices i, i+1, i+2, i+3 (i divisible by 4) decode identically.
    const stem = KEY.slice(0, 42);
    const variants = ['I', 'J', 'K', 'L'].map((tail) => stem + tail);
    const decoded = variants.map((v) => hex(v));
    // Same key bytes, four different texts — the premise of the defect.
    expect(new Set(decoded).size).toBe(1);
    expect(new Set(variants).size).toBe(4);

    const accepted = variants.filter((v) => isCanonicalBase64Url(v, 32));
    expect(accepted).toEqual([`${stem}I`]);
    for (const variant of variants) {
      expect(isCanonicalBase64Url(variant, 32)).toBe(reEncodes(variant));
    }
  });

  it('agrees with decode-and-re-encode across EVERY final character', () => {
    for (const tail of ALPHABET) {
      const key = KEY.slice(0, 42) + tail;
      expect(isCanonicalBase64Url(key, 32)).toBe(reEncodes(key));
      const signature = SIGNATURE.slice(0, 85) + tail;
      expect(isCanonicalBase64Url(signature, 64)).toBe(reEncodes(signature));
    }
  });

  it('rejects wrong lengths and non-alphabet characters', () => {
    expect(isCanonicalBase64Url(KEY.slice(0, 42), 32)).toBe(false);
    expect(isCanonicalBase64Url(`${KEY}A`, 32)).toBe(false);
    expect(isCanonicalBase64Url(`${KEY.slice(0, 42)}+`, 32)).toBe(false);
    expect(isCanonicalBase64Url(`${KEY.slice(0, 42)}=`, 32)).toBe(false);
    expect(isCanonicalBase64Url('', 32)).toBe(false);
  });

  it('has no slack to check when the byte count divides by 3', () => {
    const exact = encode(new Uint8Array(33).fill(3));
    expect(exact).toHaveLength(44);
    expect(isCanonicalBase64Url(exact, 33)).toBe(true);
    // Every alphabet-legal final character is canonical at this length.
    expect(isCanonicalBase64Url(`${exact.slice(0, 43)}_`, 33)).toBe(true);
  });
});
