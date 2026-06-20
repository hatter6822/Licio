// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.1f — canonical JSON for config hashing. The same configuration always
// produces the same string regardless of key order; arrays keep order;
// undefined/non-finite normalize to null.
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../index.js';

describe('canonicalJson', () => {
  it('is independent of object key order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('sorts nested object keys recursively', () => {
    expect(canonicalJson({ z: { b: 1, a: 2 }, a: 3 })).toBe('{"a":3,"z":{"a":2,"b":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it('normalizes undefined and non-finite numbers to null', () => {
    expect(canonicalJson({ a: undefined, b: Number.NaN, c: Infinity })).toBe(
      '{"a":null,"b":null,"c":null}',
    );
  });

  it('is deterministic across calls', () => {
    const value = { model: 'm', temperature: 0, tools: ['a', 'b'] };
    expect(canonicalJson(value)).toBe(canonicalJson(value));
  });
});
