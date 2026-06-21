// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic property-test harness for the LCAP codec (the same mulberry32
// approach as `@licio/invariants`).  A seeded PRNG keeps every run reproducible;
// the LDC value generator only produces *encodable* values (ASCII/NFC text,
// in-range integers, string-keyed maps) so the round-trip properties exercise
// the codec, not its input guards (those are tested explicitly elsewhere).

import type { LdcKey, LdcValue } from '../cbor/types.js';

export type Rng = () => number;

/** mulberry32: a small, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function int(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function pick<T>(rng: Rng, values: readonly T[]): T {
  const value = values[int(rng, 0, values.length - 1)];
  if (value === undefined) throw new Error('pick from empty array');
  return value;
}

export function bool(rng: Rng): boolean {
  return rng() < 0.5;
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';

/** A short ASCII string (always valid UTF-8 and NFC). */
export function genAscii(rng: Rng, maxLen = 6): string {
  const len = int(rng, 0, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) out += LOWER[int(rng, 0, LOWER.length - 1)];
  return out;
}

function genBytes(rng: Rng, maxLen = 8): Uint8Array {
  const len = int(rng, 0, maxLen);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = int(rng, 0, 255);
  return out;
}

/** Generate an encodable LDC value of bounded depth (maps use string keys). */
export function genValue(rng: Rng, depth: number): LdcValue {
  const leaf = ['uint', 'nint', 'tstr', 'bstr', 'bool', 'null'] as const;
  const branch = ['array', 'map'] as const;
  const kind = depth > 0 ? pick(rng, [...leaf, ...branch]) : pick(rng, leaf);
  switch (kind) {
    case 'uint':
      return int(rng, 0, 1_000_000);
    case 'nint':
      return -int(rng, 1, 1_000_000);
    case 'tstr':
      return genAscii(rng);
    case 'bstr':
      return genBytes(rng);
    case 'bool':
      return bool(rng);
    case 'null':
      return null;
    case 'array': {
      const n = int(rng, 0, 4);
      const arr: LdcValue[] = [];
      for (let i = 0; i < n; i++) arr.push(genValue(rng, depth - 1));
      return arr;
    }
    default: {
      const n = int(rng, 0, 4);
      const keys = new Set<string>();
      while (keys.size < n) keys.add(genAscii(rng) + keys.size);
      const map = new Map<LdcKey, LdcValue>();
      for (const key of keys) map.set(key, genValue(rng, depth - 1));
      return map;
    }
  }
}

function toBig(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

/** Structural LDC equality: integers compare by value, maps order-independent. */
export function deepEqualLdc(a: LdcValue, b: LdcValue): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((child, i) => deepEqualLdc(child, b[i] as LdcValue));
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key)) return false;
      if (!deepEqualLdc(value, b.get(key) as LdcValue)) return false;
    }
    return true;
  }
  if (
    (typeof a === 'number' || typeof a === 'bigint') &&
    (typeof b === 'number' || typeof b === 'bigint')
  ) {
    return toBig(a) === toBig(b);
  }
  return a === b;
}

/** Run `predicate` over `n` generated cases; throw with seed/case on failure. */
export function forAll(
  seed: number,
  n: number,
  generate: (rng: Rng) => LdcValue,
  predicate: (value: LdcValue) => boolean | string,
): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const value = generate(rng);
    const result = predicate(value);
    if (result !== true) {
      const message = typeof result === 'string' ? result : 'property violated';
      throw new Error(`${message} (seed=${seed}, case=${i})`);
    }
  }
}
