// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3 — runtime crypto-adapter tests: the byte helpers, the constant-time
// comparator, UTF-8 round-tripping, base64url codec, and the chunked CSPRNG.
import { describe, expect, it } from 'vitest';
import {
  Base64UrlError,
  concatBytes,
  fromBase64Url,
  fromUtf8,
  getCrypto,
  getSubtle,
  isUint8Array,
  randomBytes,
  timingSafeEqual,
  toBase64Url,
  utf8,
} from '../crypto/runtime.js';

describe('isUint8Array', () => {
  it('recognizes genuine byte arrays and rejects others', () => {
    expect(isUint8Array(new Uint8Array(3))).toBe(true);
    expect(isUint8Array([1, 2, 3])).toBe(false);
    expect(isUint8Array(new ArrayBuffer(3))).toBe(false);
    expect(isUint8Array(new DataView(new ArrayBuffer(3)))).toBe(false);
    expect(isUint8Array('bytes')).toBe(false);
    expect(isUint8Array(null)).toBe(false);
  });
});

describe('concatBytes', () => {
  it('concatenates in order into a fresh array', () => {
    const out = concatBytes(Uint8Array.of(1, 2), Uint8Array.of(), Uint8Array.of(3));
    expect(Array.from(out)).toStrictEqual([1, 2, 3]);
  });
  it('returns an empty array for no parts', () => {
    expect(concatBytes()).toHaveLength(0);
  });
});

describe('timingSafeEqual', () => {
  it('is true for equal arrays', () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
  });
  it('is false for same-length but different content', () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
  });
  it('is false for different lengths', () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
  });
  it('is true for two empty arrays', () => {
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe('UTF-8 helpers', () => {
  it('round-trips text', () => {
    expect(fromUtf8(utf8('café — 私'))).toBe('café — 私');
  });
  it('throws on malformed UTF-8 bytes', () => {
    expect(() => fromUtf8(Uint8Array.of(0xff, 0xfe))).toThrow();
  });
});

describe('base64url codec', () => {
  it('round-trips arbitrary bytes (unpadded, URL-safe)', () => {
    for (let len = 0; len < 40; len++) {
      const bytes = randomBytes(len);
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(Array.from(fromBase64Url(encoded))).toStrictEqual(Array.from(bytes));
    }
  });
  it('produces the canonical encoding for a known input', () => {
    expect(toBase64Url(utf8('hello'))).toBe('aGVsbG8');
  });
  it('rejects invalid base64url characters', () => {
    expect(() => fromBase64Url('abc$def')).toThrow(Base64UrlError);
    expect(() => fromBase64Url('a b c')).toThrow(Base64UrlError);
  });
});

describe('randomBytes', () => {
  it('returns the requested length, including the chunked (> 65536) path', () => {
    expect(randomBytes(0)).toHaveLength(0);
    expect(randomBytes(32)).toHaveLength(32);
    const big = randomBytes(70_000);
    expect(big).toHaveLength(70_000);
    // the tail past the 65 536-byte getRandomValues cap must be filled, not zero
    expect(big.subarray(65_536).some((b) => b !== 0)).toBe(true);
  });
  it('rejects a negative or non-integer length', () => {
    expect(() => randomBytes(-1)).toThrow(RangeError);
    expect(() => randomBytes(1.5)).toThrow(RangeError);
  });
  it('produces different output across calls', () => {
    const a = toBase64Url(randomBytes(16));
    const b = toBase64Url(randomBytes(16));
    expect(a).not.toBe(b);
  });
});

describe('WebCrypto resolution', () => {
  it('resolves a usable Crypto and SubtleCrypto', () => {
    expect(typeof getCrypto().getRandomValues).toBe('function');
    expect(typeof getSubtle().digest).toBe('function');
  });
});
