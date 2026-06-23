// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.2 — the canonical DAG-CBOR determinism + rejection suite (PRIVATE_SPEC
// §10.1.1, §9.4).  The properties that EVERY AAD/signature/CID/reducer
// comparison rests on:
//   (P1) equal logical value ⇒ identical bytes (across runs);
//   (P2) decode∘canonical = id on values, canonical∘decode = id on canonical bytes;
//   (P3) every non-canonical input fails closed with the exact reason + offset.
import { describe, expect, it } from 'vitest';
import {
  CanonicalDecodeError,
  type CanonicalDecodeReason,
  CanonicalEncodeError,
  type CanonicalValue,
  canonical,
  decodeCanonical,
} from '../crypto/canonical.js';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bytesOf = (...n: number[]): Uint8Array => Uint8Array.from(n);

describe('WS-S.2.2 integer boundary table (shortest-form, §9.1.5-equivalent)', () => {
  const cases: Array<[number | bigint, string]> = [
    [0, '00'],
    [23, '17'],
    [24, '1818'],
    [255, '18ff'],
    [256, '190100'],
    [65535, '19ffff'],
    [65536, '1a00010000'],
    [4_294_967_295, '1affffffff'],
    [4_294_967_296, '1b0000000100000000'],
    [-1, '20'],
    [-24, '37'],
    [-256, '38ff'],
  ];
  for (const [value, expected] of cases) {
    it(`encodes ${value} to ${expected}`, () => {
      expect(hex(canonical(value))).toBe(expected);
      // Round-trips back to the same numeric value.
      expect(decodeCanonical(canonical(value))).toBe(value);
    });
  }

  it('encodes the full uint64 max via bigint and rejects out-of-range', () => {
    expect(hex(canonical((1n << 64n) - 1n))).toBe('1bffffffffffffffff');
    expect(() => canonical(1n << 64n)).toThrow(CanonicalEncodeError);
    expect(() => canonical(-(1n << 64n) - 1n)).toThrow(CanonicalEncodeError);
  });
});

describe('WS-S.2.2 empty values + simple values', () => {
  it('encodes empty byte/text/array/object to the canonical one-byte head', () => {
    expect(hex(canonical(new Uint8Array()))).toBe('40');
    expect(hex(canonical(''))).toBe('60');
    expect(hex(canonical([]))).toBe('80');
    expect(hex(canonical({}))).toBe('a0');
  });

  it('encodes booleans + null to the canonical simple values', () => {
    expect(hex(canonical(false))).toBe('f4');
    expect(hex(canonical(true))).toBe('f5');
    expect(hex(canonical(null))).toBe('f6');
  });
});

describe('WS-S.2.2 (P1) map-key order independence — equal value ⇒ equal bytes', () => {
  it('re-sorts object keys by their encoded bytes regardless of insertion order', () => {
    const a: CanonicalValue = { z: 1, a: 2, m: 3 };
    const b: CanonicalValue = { m: 3, z: 1, a: 2 };
    expect(hex(canonical(a))).toBe(hex(canonical(b)));
    // map(3) with keys "a" < "m" < "z": a→2 (6161 02), m→3 (616d 03), z→1 (617a 01).
    expect(hex(canonical(a))).toBe('a3616102616d03617a01');
  });

  it('omits undefined optional fields (omit, never null-fill)', () => {
    expect(hex(canonical({ a: 1, b: undefined }))).toBe(hex(canonical({ a: 1 })));
    // An EXPLICIT null is distinct from omission.
    expect(hex(canonical({ a: 1, b: null }))).not.toBe(hex(canonical({ a: 1 })));
  });

  it('sorts shorter keys before their extensions (length-prefixed order)', () => {
    // "a" (0x6161) sorts before "aa" (0x626161) because the length byte differs.
    const out = canonical({ aa: 1, a: 2 });
    expect(hex(out)).toBe('a261610262616101');
  });

  it('preserves a `__proto__` map key through decode (null-prototype, no pollution)', () => {
    // A canonical map key is arbitrary text, so `__proto__` is legitimate inside a
    // z.unknown() field.  Decoding into a plain `{}` would invoke the prototype
    // setter and drop the field; decode must use a null-prototype object so it
    // becomes an OWN property and `canonical(decodeCanonical(b))` stays identical.
    const input: Record<string, CanonicalValue> = Object.create(null);
    // `Object.defineProperty` (not the `['__proto__']` accessor) sets an OWN
    // `__proto__` data property — exactly the shape a decoded map must reproduce.
    Object.defineProperty(input, '__proto__', {
      value: 'x',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    input['a'] = 1;
    const bytes = canonical(input);
    const decoded = decodeCanonical(bytes) as Record<string, CanonicalValue>;
    expect(Object.getPrototypeOf(decoded)).toBe(null); // no prototype pollution
    expect(Object.getOwnPropertyNames(decoded)).toContain('__proto__');
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toBe('x');
    expect(hex(canonical(decoded))).toBe(hex(bytes)); // byte-identical round trip
  });
});

describe('WS-S.2.2 encode rejections', () => {
  it('rejects a non-integer (float) number', () => {
    expect(() => canonical(1.5)).toThrow(CanonicalEncodeError);
    try {
      canonical(1.5);
    } catch (e) {
      expect((e as CanonicalEncodeError).reason).toBe('non_integer_number');
    }
  });

  it('rejects NaN / Infinity', () => {
    expect(() => canonical(Number.NaN)).toThrow(CanonicalEncodeError);
    expect(() => canonical(Number.POSITIVE_INFINITY)).toThrow(CanonicalEncodeError);
  });

  it('rejects a non-NFC text string', () => {
    // U+00C5 (composed Å) is NFC; "A" + U+030A (combining ring) is NOT.
    const decomposed = 'Å';
    expect(decomposed.normalize('NFC')).not.toBe(decomposed);
    expect(() => canonical(decomposed)).toThrow(CanonicalEncodeError);
  });

  it('rejects a lone surrogate (invalid UTF-8)', () => {
    expect(() => canonical('\uD800')).toThrow(CanonicalEncodeError);
  });

  it('rejects a duplicate object key only at the bytes level (JS objects cannot have dup string keys)', () => {
    // JS object literals can't carry duplicate keys; the duplicate-key guard is
    // exercised on the DECODE side below.  Here we assert nested objects encode.
    expect(hex(canonical({ outer: { inner: 1 } }))).toBe('a1656f75746572a165696e6e657201');
  });
});

describe('WS-S.2.2 fail-closed on EXOTIC objects (forgery / collision defense)', () => {
  // A non-plain object has an empty `Object.keys`, so a permissive encoder would
  // SILENTLY encode it as an empty map — two different Dates colliding, etc.
  // The encoder fails closed on anything that is not a plain object / null-proto
  // dict / Uint8Array / array.  This guards the `z.unknown()` schema fields
  // (submission_metadata, location_scope, metadata, terms) that reach canonical.
  const exotic: unknown[] = [
    new Date(),
    new Map([['a', 1]]),
    new Set([1]),
    /regex/,
    new Float64Array([1]),
    new Int8Array([1]),
    new (class Foo {
      x = 1;
    })(),
  ];
  for (const value of exotic) {
    it(`rejects ${Object.getPrototypeOf(value)?.constructor?.name ?? 'exotic'}`, () => {
      expect(() => canonical(value as CanonicalValue)).toThrow(CanonicalEncodeError);
    });
  }

  it('rejects an exotic value NESTED inside a plain object (the z.unknown() path)', () => {
    expect(() =>
      canonical({ metadata: { when: new Date() } } as unknown as CanonicalValue),
    ).toThrow(CanonicalEncodeError);
    expect(() => canonical([1, new Map()] as unknown as CanonicalValue)).toThrow(
      CanonicalEncodeError,
    );
  });

  it('still ACCEPTS a plain object and a null-prototype dict', () => {
    expect(() => canonical({ a: 1 })).not.toThrow();
    const dict = Object.create(null) as Record<string, number>;
    dict['a'] = 1;
    expect(hex(canonical(dict))).toBe(hex(canonical({ a: 1 })));
  });
});

describe('WS-S.2.2 (P2) round-trip', () => {
  const values: CanonicalValue[] = [
    0,
    -1,
    'hello',
    new Uint8Array([1, 2, 3]),
    [1, 'two', true, null],
    { schema: 'licio.private.op.v1', epoch: 3, parents: ['a', 'b'], flag: false },
    { nested: { deep: [{ x: 1 }, { y: 2 }] } },
  ];
  for (const value of values) {
    it(`decode∘canonical is structurally identity for ${JSON.stringify(value)?.slice(0, 40)}`, () => {
      const encoded = canonical(value);
      const decoded = decodeCanonical(encoded);
      // canonical∘decode is byte-identical (the stronger of the two directions).
      expect(hex(canonical(decoded as CanonicalValue))).toBe(hex(encoded));
    });
  }

  it('decodes a Uint8Array back to a Uint8Array', () => {
    const decoded = decodeCanonical(canonical(new Uint8Array([9, 8, 7])));
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded as Uint8Array)).toEqual([9, 8, 7]);
  });
});

describe('WS-S.2.2 (P3) decode rejects every non-canonical input', () => {
  const reject = (bytes: Uint8Array, reason: CanonicalDecodeReason) => {
    expect(() => decodeCanonical(bytes)).toThrow(CanonicalDecodeError);
    try {
      decodeCanonical(bytes);
    } catch (e) {
      expect((e as CanonicalDecodeError).reason).toBe(reason);
    }
  };

  it('rejects a non-shortest integer argument (0x18 0x05 for 5)', () => {
    reject(bytesOf(0x18, 0x05), 'non_shortest_argument');
  });
  it('rejects an indefinite-length item', () => {
    reject(bytesOf(0x5f), 'indefinite_length');
  });
  it('rejects reserved additional info (28)', () => {
    reject(bytesOf(0x1c), 'reserved_additional_info');
  });
  it('rejects a CBOR tag (major 6)', () => {
    reject(bytesOf(0xc0, 0x00), 'unsupported_major_type');
  });
  it('rejects a float (major 7, ai 26)', () => {
    reject(bytesOf(0xfa, 0x00, 0x00, 0x00, 0x00), 'unsupported_simple_value');
  });
  it('rejects an undefined simple value (0xf7)', () => {
    reject(bytesOf(0xf7), 'unsupported_simple_value');
  });
  it('rejects an out-of-order map key (b before a)', () => {
    // map(2) { "b":1, "a":1 } — keys not strictly ascending.
    reject(bytesOf(0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x01), 'map_key_not_sorted');
  });
  it('rejects a duplicate map key', () => {
    // map(2) { "a":1, "a":1 } — equal encoded keys ⇒ not strictly ascending.
    reject(bytesOf(0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x01), 'map_key_not_sorted');
  });
  it('rejects an integer map key (text keys only)', () => {
    // map(1) { 1: 1 } — integer key.
    reject(bytesOf(0xa1, 0x01, 0x01), 'invalid_map_key_type');
  });
  it('rejects trailing bytes after the top-level item', () => {
    reject(bytesOf(0x00, 0x00), 'trailing_bytes');
  });
  it('rejects truncated input', () => {
    reject(bytesOf(0x18), 'unexpected_end');
  });
  it('rejects invalid UTF-8 in a text string', () => {
    // tstr(1) with byte 0xff (not valid UTF-8).
    reject(bytesOf(0x61, 0xff), 'invalid_utf8');
  });
});

describe('WS-S.2.2 resource caps (bombs abort at the cap, not by OOM)', () => {
  it('aborts an over-depth nested array at the depth cap', () => {
    // 40 nested arrays exceeds the default maxDepth of 32.
    const deep = new Uint8Array(40).fill(0x81); // 40× array(1) heads
    expect(() => decodeCanonical(deep, { maxDepth: 32, maxBytes: 1024, maxItems: 1024 })).toThrow(
      CanonicalDecodeError,
    );
  });

  it('aborts when the declared count exceeds the byte cap', () => {
    // array head claiming 2^32 items — far beyond maxBytes.
    const bomb = bytesOf(0x9a, 0xff, 0xff, 0xff, 0xff);
    try {
      decodeCanonical(bomb, { maxDepth: 32, maxBytes: 1024, maxItems: 1024 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalDecodeError);
      expect((e as CanonicalDecodeError).reason).toBe('max_bytes_exceeded');
    }
  });

  it('aborts when total decoded items exceed the item budget', () => {
    // array(5) of small ints, but maxItems = 3.
    const many = bytesOf(0x85, 0x00, 0x00, 0x00, 0x00, 0x00);
    expect(() => decodeCanonical(many, { maxDepth: 32, maxBytes: 1024, maxItems: 3 })).toThrow(
      CanonicalDecodeError,
    );
  });

  it('rejects input larger than maxBytes outright', () => {
    expect(() =>
      decodeCanonical(new Uint8Array(2000), { maxDepth: 4, maxBytes: 1024, maxItems: 8 }),
    ).toThrow(CanonicalDecodeError);
  });
});

describe('WS-S.2.2 NFC enforcement on decode', () => {
  it('rejects non-NFC text bytes', () => {
    // "A" + combining ring (U+030A) as UTF-8: 0x41 0xCC 0x8A — valid UTF-8 but non-NFC.
    const nonNfc = bytesOf(0x63, 0x41, 0xcc, 0x8a);
    expect(() => decodeCanonical(nonNfc)).toThrow(CanonicalDecodeError);
    try {
      decodeCanonical(nonNfc);
    } catch (e) {
      expect((e as CanonicalDecodeError).reason).toBe('non_nfc_text');
    }
  });
});
