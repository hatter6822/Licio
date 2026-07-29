// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The canonical-JSON core, and specifically the ONE axis on which its two
// exported policies differ.  Five hand-rolled copies of this algorithm used to
// exist; what made that dangerous was not the duplication but that they
// disagreed, and only on values JSON cannot represent — so the disagreement was
// invisible to every test any of them had.

import { describe, expect, it } from 'vitest';
import { canonicalJson, totalCanonicalJson } from '../utils/canonical-json.js';

describe('canonical JSON — the shared core', () => {
  it('sorts object keys at every depth; arrays keep their order', () => {
    for (const encode of [canonicalJson, totalCanonicalJson]) {
      expect(encode({ z: { b: 1, a: 2 }, a: 3 })).toBe('{"a":3,"z":{"a":2,"b":1}}');
      expect(encode({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
      expect(encode({ a: 1, b: 2 })).toBe(encode({ b: 2, a: 1 }));
    }
  });

  it('is whitespace-free — the bytes a digest is taken over', () => {
    // `canonicalBundleBytes` in apps/web writes exactly these bytes to the file a
    // member downloads, and the member is told sha256(file) === artifact_digest.
    // A single space would break that promise silently.
    expect(canonicalJson({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
    expect(canonicalJson({ a: 1 })).not.toContain(' ');
  });

  it('nests without depth limit and is idempotent under re-encoding', () => {
    const deep = { a: { b: { c: { d: [{ z: 1, y: 2 }] } } } };
    expect(canonicalJson(deep)).toBe('{"a":{"b":{"c":{"d":[{"y":2,"z":1}]}}}}');
    expect(canonicalJson(JSON.parse(canonicalJson(deep)))).toBe(canonicalJson(deep));
  });
});

describe('the hole policy is the only difference between the two', () => {
  it('canonicalJson OMITS an undefined property, mirroring a jsonb round-trip', () => {
    // This is what makes the hash-chained treasury/compliance audit logs
    // verifiable: the digest is taken in memory and re-checked after the value
    // has been through a `jsonb` column, which does not keep the key either.
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe(
      canonicalJson(JSON.parse(JSON.stringify({ a: undefined, b: 1 }))),
    );
  });

  it('totalCanonicalJson maps undefined and non-finite numbers to null', () => {
    expect(totalCanonicalJson({ a: undefined, b: Number.NaN, c: Number.POSITIVE_INFINITY })).toBe(
      '{"a":null,"b":null,"c":null}',
    );
  });

  it('the two policies disagree ONLY on values JSON cannot represent', () => {
    const representable = {
      s: 'x',
      n: 1.5,
      b: false,
      nul: null,
      arr: [1, 'two', null, { k: 'v' }],
      obj: { z: 1, a: { deep: true } },
    };
    expect(canonicalJson(representable)).toBe(totalCanonicalJson(representable));
    expect(canonicalJson({ hole: undefined })).not.toBe(totalCanonicalJson({ hole: undefined }));
  });

  it('an array hole is null under BOTH policies (JSON has no array hole)', () => {
    // Worth pinning separately: the object case differs but the array case must
    // not, because `JSON.stringify` already writes null for an array hole.
    expect(canonicalJson({ a: [undefined, 1] })).toBe('{"a":[null,1]}');
    expect(totalCanonicalJson({ a: [undefined, 1] })).toBe('{"a":[null,1]}');
  });

  it('key order is code-unit order, not locale order', () => {
    // `localeCompare` would order these differently under some ICU locales, and
    // a digest that depends on the host's locale is not a content address.
    expect(canonicalJson({ ä: 1, b: 2, Z: 3, a: 4 })).toBe('{"Z":3,"a":4,"b":2,"ä":1}');
  });
});
