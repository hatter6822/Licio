// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.0.2a/b — the LDC encoder + strict decoder.  Byte-exact per-major-type
// assertions, the §9.1.5 integer-boundary table, map sort/dedup, the full
// decode rejection matrix (with offsets), and round-trips.

import { describe, expect, it } from 'vitest';
import { decode } from '../cbor/decode.js';
import { compareBytes, encode } from '../cbor/encode.js';
import { LdcDecodeError, LdcEncodeError } from '../cbor/errors.js';
import type { LdcKey, LdcValue } from '../cbor/types.js';
import { bytesToHex, hexToBytes } from './hex.js';

function enc(value: LdcValue): string {
  return bytesToHex(encode(value));
}

describe('LDC encoder — major types (WS-R.0.2a)', () => {
  it('encodes the integer-boundary set to the §9.1.5 shortest bytes', () => {
    const table: Array<[number | bigint, string]> = [
      [0, '00'],
      [23, '17'],
      [24, '1818'],
      [255, '18ff'],
      [256, '190100'],
      [65535, '19ffff'],
      [65536, '1a00010000'],
      [4294967295, '1affffffff'], // 2^32 − 1
      [4294967296n, '1b0000000100000000'], // 2^32
      [-1, '20'],
      [-24, '37'],
      [-256, '38ff'],
    ];
    for (const [value, hex] of table) expect(enc(value)).toBe(hex);
  });

  it('encodes the largest representable integers (2^64 − 1 boundary)', () => {
    expect(enc((1n << 64n) - 1n)).toBe('1bffffffffffffffff');
    expect(enc(-(1n << 64n))).toBe('3bffffffffffffffff'); // nint arg = 2^64 − 1
  });

  it('encodes byte/text strings with definite-length, shortest-arg prefixes', () => {
    expect(enc(new Uint8Array())).toBe('40');
    expect(enc(new Uint8Array([1, 2]))).toBe('420102');
    expect(enc('')).toBe('60');
    expect(enc('a')).toBe('6161');
    expect(enc('IETF')).toBe('6449455446');
  });

  it('encodes arrays and the simple values', () => {
    expect(enc([])).toBe('80');
    expect(enc([1, 2, 3])).toBe('83010203');
    expect(enc(false)).toBe('f4');
    expect(enc(true)).toBe('f5');
    expect(enc(null)).toBe('f6');
  });

  it('encodes maps with keys sorted by encoded-key bytes (RFC 8949 §4.2.1)', () => {
    expect(enc(new Map())).toBe('a0');
    // String keys: "a" (0x6161) sorts before "b" (0x6162) regardless of order.
    expect(
      enc(
        new Map<LdcKey, LdcValue>([
          ['b', 1],
          ['a', 2],
        ]),
      ),
    ).toBe('a2616102616201');
    // Integer keys: 1 (0x01) sorts before −7 (0x26); the COSE ES256 header.
    expect(
      enc(
        new Map<LdcKey, LdcValue>([
          [-7, 3],
          [1, 2],
        ]),
      ),
    ).toBe('a201022603');
  });

  it('is independent of map insertion order', () => {
    const a = new Map<LdcKey, LdcValue>([
      ['x', 1],
      ['y', 2],
      ['z', 3],
    ]);
    const b = new Map<LdcKey, LdcValue>([
      ['z', 3],
      ['x', 1],
      ['y', 2],
    ]);
    expect(compareBytes(encode(a), encode(b))).toBe(0);
  });
});

describe('LDC encoder — rejections (WS-R.0.2a)', () => {
  const reason = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      if (error instanceof LdcEncodeError) return error.reason;
      throw error;
    }
    throw new Error('expected LdcEncodeError');
  };

  it('rejects a non-integer / NaN / Infinity number', () => {
    expect(reason(() => encode(1.5))).toBe('non_integer_number');
    expect(reason(() => encode(Number.NaN))).toBe('non_integer_number');
    expect(reason(() => encode(Number.POSITIVE_INFINITY))).toBe('non_integer_number');
  });

  it('rejects out-of-range bigint integers', () => {
    expect(reason(() => encode(1n << 64n))).toBe('integer_out_of_range');
    expect(reason(() => encode(-(1n << 64n) - 1n))).toBe('integer_out_of_range');
  });

  it('rejects non-NFC and invalid-UTF-8 text', () => {
    // U+00C5 (Å, NFC) vs the decomposed A + combining ring (NFD).
    expect(reason(() => encode('Å'))).toBe('non_nfc_text');
    expect(reason(() => encode('\uD800'))).toBe('invalid_utf8'); // lone high surrogate
  });

  it('rejects a non-int/text map key and duplicate encoded keys', () => {
    expect(reason(() => encode(new Map<LdcKey, LdcValue>([[true as never, 1]])))).toBe(
      'invalid_map_key_type',
    );
    // number 1 and bigint 1n are distinct JS keys but encode identically.
    expect(
      reason(() =>
        encode(
          new Map<LdcKey, LdcValue>([
            [1, 'a'],
            [1n, 'b'],
          ]),
        ),
      ),
    ).toBe('duplicate_map_key');
  });

  it('rejects undefined and other unsupported types', () => {
    expect(reason(() => encode(undefined as never))).toBe('unsupported_type');
    expect(reason(() => encode((() => 0) as never))).toBe('unsupported_type');
  });

  it('reports the offending path', () => {
    // Both assertions used to live ONLY inside the catch, so an encoder that
    // stopped throwing here finished the test with zero assertions and vitest
    // reported a pass.  This is the only test in the repository that feeds a
    // plain (non-Map, non-Array, non-Uint8Array) object to `encode`, and the
    // sibling "rejects undefined and other unsupported types" does not cover
    // the same branch — `undefined` and a function fall through to the
    // `default:` arm, not the `case 'object'` arm this guards.  Verified by
    // mutation: replacing that throw with `encodeMap(new Map(), path)` — so
    // every distinct object body encodes to the same one-byte map, and two
    // different records share a CID — kept all 419 @licio/lcap tests green.
    // The `reason` helper above already fails on a non-throw; use it.
    expect(reason(() => encode([0, { not: 'a map' } as never]))).toBe('unsupported_type');
    try {
      encode([0, { not: 'a map' } as never]);
      expect.unreachable('encode must reject a plain object');
    } catch (error) {
      expect(error).toBeInstanceOf(LdcEncodeError);
      expect((error as LdcEncodeError).path).toBe('[1]');
    }
  });

  it('rejects an EXOTIC object — a Date, Set, RegExp or class instance', () => {
    // The realm-crossing and wrapper cases the `case 'object'` arm exists for.
    // `packages/private-p2p`'s canonical encoder has had this table since
    // WS-S.2.2 ("fail-closed on EXOTIC objects — forgery / collision defense");
    // the LDC encoder is the same kind of canonical serializer, feeding
    // `cidFor()` and COSE Sign1, and had no equivalent.
    for (const value of [new Date(0), new Set([1]), /re/, Object.create(null), { a: 1 }]) {
      expect(reason(() => encode(value as never))).toBe('unsupported_type');
      // …and nested, where a permissive encoder would corrupt a body rather
      // than refuse a top-level call.
      expect(reason(() => encode([value] as never))).toBe('unsupported_type');
      expect(reason(() => encode(new Map([['k', value]]) as never))).toBe('unsupported_type');
    }
  });
});

describe('LDC decoder — rejection matrix with offsets (WS-R.0.2b)', () => {
  const decodeReason = (hex: string): { reason: string; offset: number } => {
    try {
      decode(hexToBytes(hex));
    } catch (error) {
      if (error instanceof LdcDecodeError) return { reason: error.reason, offset: error.offset };
      throw error;
    }
    throw new Error('expected LdcDecodeError');
  };

  it('rejects indefinite-length items', () => {
    expect(decodeReason('9f00ff')).toEqual({ reason: 'indefinite_length', offset: 0 });
    expect(decodeReason('5f42010242030400ff')).toEqual({ reason: 'indefinite_length', offset: 0 });
  });

  it('rejects non-shortest integer arguments', () => {
    expect(decodeReason('1805')).toEqual({ reason: 'non_shortest_argument', offset: 0 }); // 5 as 2-byte
    expect(decodeReason('190017')).toEqual({ reason: 'non_shortest_argument', offset: 0 }); // 23 as 2-byte
    expect(decodeReason('1a0000ffff')).toEqual({ reason: 'non_shortest_argument', offset: 0 });
  });

  it('rejects reserved additional-info 28/29/30', () => {
    expect(decodeReason('1c')).toEqual({ reason: 'reserved_additional_info', offset: 0 });
    expect(decodeReason('1e')).toEqual({ reason: 'reserved_additional_info', offset: 0 });
  });

  it('rejects CBOR tags (major type 6)', () => {
    expect(decodeReason('c074323031332d30332d32315432303a30343a30305a')).toEqual({
      reason: 'unsupported_major_type',
      offset: 0,
    });
  });

  it('rejects floats and other simple values (major type 7)', () => {
    expect(decodeReason('f97e00')).toEqual({ reason: 'unsupported_simple_value', offset: 0 }); // half NaN
    expect(decodeReason('fa47c35000')).toEqual({ reason: 'unsupported_simple_value', offset: 0 }); // single
    expect(decodeReason('fb7ff8000000000000')).toEqual({
      reason: 'unsupported_simple_value',
      offset: 0,
    }); // double
    expect(decodeReason('f7')).toEqual({ reason: 'unsupported_simple_value', offset: 0 }); // undefined
  });

  it('rejects out-of-order and duplicate map keys', () => {
    // {"b":1,"a":2}: keys 0x6162 then 0x6161 — descending → rejected.
    expect(decodeReason('a2616201616102')).toEqual({ reason: 'map_key_not_sorted', offset: 4 });
    // {"a":1,"a":2}: duplicate encoded key.
    expect(decodeReason('a2616101616102')).toEqual({ reason: 'map_key_not_sorted', offset: 4 });
  });

  it('rejects invalid UTF-8 and non-NFC text', () => {
    // 0x61 then 0x80 0x80 — a 2-byte string with an invalid UTF-8 continuation.
    expect(decodeReason('628080')).toEqual({ reason: 'invalid_utf8', offset: 0 });
    // The NFD "Å" (0x41 0xCC 0x8A) as a text string is non-NFC.
    expect(decodeReason('6341cc8a')).toEqual({ reason: 'non_nfc_text', offset: 0 });
  });

  it('rejects trailing bytes after the top-level item', () => {
    expect(decodeReason('0000')).toEqual({ reason: 'trailing_bytes', offset: 1 });
  });

  it('rejects truncated input', () => {
    expect(decodeReason('18')).toEqual({ reason: 'unexpected_end', offset: 0 }); // missing arg byte
    expect(decodeReason('4205')).toEqual({ reason: 'unexpected_end', offset: 0 }); // bstr len 2, 1 byte
  });

  it('aborts a depth bomb at the cap rather than exhausting memory', () => {
    // 40 nested single-element arrays exceed the default maxDepth of 16.
    const nested = `${'81'.repeat(40)}00`;
    const { reason } = decodeReason(nested);
    expect(reason).toBe('max_depth_exceeded');
  });

  it('aborts an over-size input at the byte cap', () => {
    const big = new Uint8Array(64);
    expect(() => decode(big, { maxDepth: 4, maxBytes: 16, maxItems: 16 })).toThrowError(
      LdcDecodeError,
    );
  });

  it('enforces the total item budget', () => {
    // A 5-element array with maxItems 4 (array head + 4 items = 5 > 4).
    expect(() =>
      decode(hexToBytes('8500010203'), { maxDepth: 8, maxBytes: 64, maxItems: 4 }),
    ).toThrowError(/item_budget_exceeded/);
  });
});

describe('LDC round-trips (WS-R.0.2b)', () => {
  it('decode∘encode is structurally identical; encode∘decode is byte-identical', () => {
    const samples: LdcValue[] = [
      0,
      -1,
      4294967296n,
      'licio',
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      [1, 'two', new Uint8Array([3]), [true, null]],
      new Map<LdcKey, LdcValue>([
        ['z', 1],
        ['a', new Map([['nested', [false]]])],
      ]),
    ];
    for (const value of samples) {
      const bytes = encode(value);
      const decoded = decode(bytes);
      expect(compareBytes(encode(decoded), bytes)).toBe(0);
    }
  });
});
