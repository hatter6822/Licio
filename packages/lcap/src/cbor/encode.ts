// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LDC encoder (OFFLINE_SPEC §9.1.1-§9.1.3): the canonical, hand-rolled
// serializer for the LCAP Deterministic CBOR profile.  Two conforming encoders
// MUST produce byte-identical output for the same logical value, so every
// degree of freedom CBOR leaves open is pinned here:
//
//   - integers and all length/count arguments use the shortest (preferred)
//     form, chosen at the exact thresholds 24 / 2^8 / 2^16 / 2^32 / 2^64;
//   - byte/text strings, arrays, and maps are definite-length only;
//   - MAP KEYS ARE SORTED by the bytewise-lexicographic order of their *encoded*
//     key bytes (RFC 8949 §4.2.1), and byte-identical encoded keys are rejected;
//   - text is validated UTF-8 + NFC; floats, tags, undefined, and other simple
//     values are refused (§9.1.2).

import { isUint8Array } from '../runtime.js';
import { LdcEncodeError } from './errors.js';
import type { LdcKey, LdcMap, LdcValue } from './types.js';

/** The largest unsigned value a CBOR 8-byte argument can carry (2^64 − 1). */
const MAX_UINT64 = (1n << 64n) - 1n;

const TEXT_ENCODER = new TextEncoder();

/**
 * Matches a UTF-16 lone surrogate (a high surrogate not followed by a low, or a
 * low surrogate not preceded by a high) — i.e. a string that is not
 * well-formed Unicode and therefore not valid UTF-8.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Compare two byte strings in ascending bytewise-lexicographic order: the first
 * differing byte decides, and a proper prefix sorts before its extension.
 * Returns a negative/zero/positive number like `Array.prototype.sort`.
 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < len; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    if (ai !== bi) return ai - bi;
  }
  return a.length - b.length;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Emit `major`'s initial byte plus the shortest-form argument for `n`
 * (`0 ≤ n ≤ 2^64 − 1`).  Multi-byte arguments are big-endian and serialized via
 * BigInt so there is no 32-bit signedness ambiguity.
 */
function writeArgument(major: number, n: bigint): Uint8Array {
  const mt = major << 5;
  if (n < 24n) return Uint8Array.of(mt | Number(n));

  let width: number;
  let head: number;
  if (n < 0x100n) {
    width = 1;
    head = 24;
  } else if (n < 0x1_0000n) {
    width = 2;
    head = 25;
  } else if (n < 0x1_0000_0000n) {
    width = 4;
    head = 26;
  } else {
    // n ≤ MAX_UINT64 is guaranteed by the callers (encodeInteger range-checks
    // values; lengths/counts of in-memory data cannot reach 2^64).
    width = 8;
    head = 27;
  }

  const out = new Uint8Array(1 + width);
  out[0] = mt | head;
  let x = n;
  for (let i = width; i >= 1; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function encodeInteger(value: number | bigint, path: string): Uint8Array {
  let n: bigint;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new LdcEncodeError('non_integer_number', path);
    }
    n = BigInt(value);
  } else {
    n = value;
  }

  if (n >= 0n) {
    if (n > MAX_UINT64) throw new LdcEncodeError('integer_out_of_range', path);
    return writeArgument(0, n);
  }
  // Negative integers (major type 1) encode the argument −1 − n.
  const arg = -1n - n;
  if (arg > MAX_UINT64) throw new LdcEncodeError('integer_out_of_range', path);
  return writeArgument(1, arg);
}

function encodeText(value: string, path: string): Uint8Array {
  if (LONE_SURROGATE.test(value)) throw new LdcEncodeError('invalid_utf8', path);
  if (value.normalize('NFC') !== value) throw new LdcEncodeError('non_nfc_text', path);
  const utf8 = TEXT_ENCODER.encode(value);
  return concat([writeArgument(3, BigInt(utf8.length)), utf8]);
}

function encodeBytes(value: Uint8Array, _path: string): Uint8Array {
  return concat([writeArgument(2, BigInt(value.length)), value]);
}

function encodeKey(key: LdcKey, path: string): Uint8Array {
  if (typeof key === 'string') return encodeText(key, path);
  return encodeInteger(key, path);
}

function encodeMap(map: LdcMap, path: string): Uint8Array {
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  for (const [k, v] of map) {
    if (typeof k !== 'number' && typeof k !== 'bigint' && typeof k !== 'string') {
      throw new LdcEncodeError('invalid_map_key_type', `${path} key`);
    }
    const keyBytes = encodeKey(k, `${path} key`);
    const valueBytes = encode(v, `${path}[${String(k)}]`);
    entries.push({ key: keyBytes, value: valueBytes });
  }

  entries.sort((a, b) => compareBytes(a.key, b.key));
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (prev && cur && compareBytes(prev.key, cur.key) === 0) {
      throw new LdcEncodeError('duplicate_map_key', path);
    }
  }

  const parts: Uint8Array[] = [writeArgument(5, BigInt(map.size))];
  for (const entry of entries) {
    parts.push(entry.key, entry.value);
  }
  return concat(parts);
}

function encodeArray(arr: readonly LdcValue[], path: string): Uint8Array {
  const parts: Uint8Array[] = [writeArgument(4, BigInt(arr.length))];
  for (let i = 0; i < arr.length; i++) {
    parts.push(encode(arr[i] as LdcValue, `${path}[${i}]`));
  }
  return concat(parts);
}

/**
 * Encode a logical LDC value to its single canonical byte sequence.  Throws
 * `LdcEncodeError` (with the offending path) on any value LDC cannot represent:
 * a non-integer/out-of-range number, a non-UTF-8 or non-NFC string, a
 * non-int/text map key, duplicate encoded keys, or an unsupported type.
 */
export function encode(value: LdcValue, path = ''): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6);

  switch (typeof value) {
    case 'boolean':
      return Uint8Array.of(value ? 0xf5 : 0xf4);
    case 'number':
    case 'bigint':
      return encodeInteger(value, path);
    case 'string':
      return encodeText(value, path);
    case 'object': {
      if (isUint8Array(value)) return encodeBytes(value, path);
      if (value instanceof Map) return encodeMap(value, path);
      if (Array.isArray(value)) return encodeArray(value, path);
      throw new LdcEncodeError('unsupported_type', path);
    }
    default:
      throw new LdcEncodeError('unsupported_type', path);
  }
}
