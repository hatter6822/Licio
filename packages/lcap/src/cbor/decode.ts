// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LDC strict decoder (OFFLINE_SPEC §9.1.1/§9.1.4/§27.1): a bounded
// recursive-descent parser that REJECTS (never normalizes) any input that is
// not in canonical LDC form, with a typed `LdcDecodeError(reason, offset)`.
// Anything hashed into a CID or covered by a signature must round-trip
// byte-for-byte, so the decoder is the verifier's first line of defense: a
// successfully decoded body is, by construction, the unique canonical encoding
// of the value it returns.
//
// Rejections: reserved/indefinite additional-info; non-shortest arguments; CBOR
// tags (major 6); every major-7 value but false/true/null; invalid UTF-8;
// non-NFC text; non-strictly-ascending or duplicate map keys; non-int/text map
// keys; trailing bytes; and the §27.1 depth/size/item caps.

import { compareBytes } from './encode.js';
import { LdcDecodeError } from './errors.js';
import {
  DEFAULT_DECODE_LIMITS,
  type LdcDecodeLimits,
  type LdcKey,
  type LdcValue,
} from './types.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** A `fatal` UTF-8 decoder: it throws (rather than substituting U+FFFD). */
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

interface Reader {
  readonly bytes: Uint8Array;
  pos: number;
  depth: number;
  items: number;
  readonly limits: LdcDecodeLimits;
}

/** Represent an integer as a JS `number` when safe, else as a `bigint`. */
function asInteger(n: bigint): number | bigint {
  return n >= MIN_SAFE && n <= MAX_SAFE ? Number(n) : n;
}

function need(r: Reader, n: number, offset: number): void {
  if (r.pos + n > r.bytes.length) throw new LdcDecodeError('unexpected_end', offset);
}

/**
 * A byte string/array/map length or count cannot exceed the input-size cap:
 * every remaining item or byte needs at least one input byte, so a larger
 * declared count can never be satisfied by the bounded input — fail closed
 * (this also keeps the subsequent `Number()` exact, since `maxBytes` is well
 * under 2^53).
 */
function toBoundedCount(n: bigint, r: Reader, offset: number): number {
  if (n > BigInt(r.limits.maxBytes)) throw new LdcDecodeError('max_bytes_exceeded', offset);
  return Number(n);
}

/** Read the shortest-form argument for additional-info `ai` of a major 0-5 head. */
function readArgument(r: Reader, ai: number, headOffset: number): bigint {
  if (ai < 24) return BigInt(ai);

  let width: number;
  let min: bigint;
  switch (ai) {
    case 24:
      width = 1;
      min = 24n;
      break;
    case 25:
      width = 2;
      min = 0x100n;
      break;
    case 26:
      width = 4;
      min = 0x1_0000n;
      break;
    case 27:
      width = 8;
      min = 0x1_0000_0000n;
      break;
    case 28:
    case 29:
    case 30:
      throw new LdcDecodeError('reserved_additional_info', headOffset);
    default: // 31
      throw new LdcDecodeError('indefinite_length', headOffset);
  }

  need(r, width, headOffset);
  let n = 0n;
  for (let i = 0; i < width; i++) {
    n = (n << 8n) | BigInt(r.bytes[r.pos + i] as number);
  }
  r.pos += width;
  if (n < min) throw new LdcDecodeError('non_shortest_argument', headOffset);
  return n;
}

function decodeItem(r: Reader): LdcValue {
  if (r.depth > r.limits.maxDepth) throw new LdcDecodeError('max_depth_exceeded', r.pos);
  r.items += 1;
  if (r.items > r.limits.maxItems) throw new LdcDecodeError('item_budget_exceeded', r.pos);

  const headOffset = r.pos;
  need(r, 1, headOffset);
  const ib = r.bytes[r.pos] as number;
  r.pos += 1;
  const major = ib >> 5;
  const ai = ib & 0x1f;

  switch (major) {
    case 0:
      return asInteger(readArgument(r, ai, headOffset));
    case 1:
      return asInteger(-1n - readArgument(r, ai, headOffset));
    case 2: {
      const len = toBoundedCount(readArgument(r, ai, headOffset), r, headOffset);
      need(r, len, headOffset);
      const slice = r.bytes.slice(r.pos, r.pos + len);
      r.pos += len;
      return slice;
    }
    case 3: {
      const len = toBoundedCount(readArgument(r, ai, headOffset), r, headOffset);
      need(r, len, headOffset);
      const slice = r.bytes.subarray(r.pos, r.pos + len);
      r.pos += len;
      let text: string;
      try {
        text = TEXT_DECODER.decode(slice);
      } catch {
        throw new LdcDecodeError('invalid_utf8', headOffset);
      }
      if (text.normalize('NFC') !== text) throw new LdcDecodeError('non_nfc_text', headOffset);
      return text;
    }
    case 4: {
      const count = toBoundedCount(readArgument(r, ai, headOffset), r, headOffset);
      r.depth += 1;
      const arr: LdcValue[] = [];
      for (let i = 0; i < count; i++) arr.push(decodeItem(r));
      r.depth -= 1;
      return arr;
    }
    case 5: {
      const count = toBoundedCount(readArgument(r, ai, headOffset), r, headOffset);
      r.depth += 1;
      const map = new Map<LdcKey, LdcValue>();
      let prevKey: Uint8Array | null = null;
      for (let i = 0; i < count; i++) {
        const keyStart = r.pos;
        const key = decodeItem(r);
        const keyEnd = r.pos;
        if (typeof key !== 'number' && typeof key !== 'bigint' && typeof key !== 'string') {
          throw new LdcDecodeError('invalid_map_key_type', keyStart);
        }
        const keyBytes = r.bytes.subarray(keyStart, keyEnd);
        // Strictly ascending encoded-key order catches both mis-ordering and
        // duplicate keys (equal encoded bytes) in a single comparison.
        if (prevKey !== null && compareBytes(prevKey, keyBytes) >= 0) {
          throw new LdcDecodeError('map_key_not_sorted', keyStart);
        }
        prevKey = keyBytes;
        map.set(key, decodeItem(r));
      }
      r.depth -= 1;
      return map;
    }
    case 6:
      throw new LdcDecodeError('unsupported_major_type', headOffset);
    default: {
      // major === 7 (simple values); the only canonical members are
      // false (0xf4) / true (0xf5) / null (0xf6).
      switch (ai) {
        case 20:
          return false;
        case 21:
          return true;
        case 22:
          return null;
        case 28:
        case 29:
        case 30:
          throw new LdcDecodeError('reserved_additional_info', headOffset);
        default:
          throw new LdcDecodeError('unsupported_simple_value', headOffset);
      }
    }
  }
}

/**
 * Decode canonical LDC bytes to a logical value.  Total over its bounded input:
 * any non-canonical or over-budget input throws `LdcDecodeError` with the exact
 * reason and byte offset.  `decode(encode(v))` is structurally `v`, and
 * `encode(decode(b))` is byte-identical to canonical `b`.
 */
export function decode(
  bytes: Uint8Array,
  limits: LdcDecodeLimits = DEFAULT_DECODE_LIMITS,
): LdcValue {
  if (bytes.length > limits.maxBytes) throw new LdcDecodeError('max_bytes_exceeded', 0);
  const r: Reader = { bytes, pos: 0, depth: 0, items: 0, limits };
  const value = decodeItem(r);
  if (r.pos !== bytes.length) throw new LdcDecodeError('trailing_bytes', r.pos);
  return value;
}
