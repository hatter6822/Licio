// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.2 — the ONE canonical encoding for the private-rooms plane
// (PRIVATE_SPEC §10.1.1, §9.4): the DAG-CBOR deterministic profile (RFC 8949
// §4.2.1 core deterministic encoding).  Every structure that is hashed into a
// CID, fed to an AEAD as AAD, covered by a signature, or compared for reducer
// determinism MUST pass through `canonical(...)`, so two honest devices ALWAYS
// produce byte-identical bytes for equal logical state — the foundation of
// cross-device convergence (§14.3.2) and forgery resistance (§10.5).
//
// The rules MATCH LCAP's LDC profile (`docs/OFFLINE_SPEC.md` §9.1) — but this is
// a SEPARATE, zero-dependency implementation (the two planes pin different
// suites on purpose and never share code or keys; `@licio/private-p2p` depends
// on `@licio/shared` only, never `@licio/lcap`):
//
//   - integers and all length/count arguments use the SHORTEST form, at the
//     exact thresholds 24 / 2^8 / 2^16 / 2^32 / 2^64;
//   - byte strings, text strings, arrays, and maps are DEFINITE-length only;
//   - MAP KEYS ARE SORTED by the bytewise-lexicographic order of their ENCODED
//     key bytes (RFC 8949 §4.2.1); byte-identical encoded keys are rejected;
//   - OPTIONAL fields are OMITTED, never `null`-filled (a `undefined` object
//     value is dropped; an explicit `null` is the distinct simple value 0xf6);
//   - text is validated UTF-8 + NFC; floats, tags, `undefined`, indefinite
//     lengths, and non-false/true/null simple values are REFUSED.
//
// Map keys are TEXT only (the private-rooms model has no integer-keyed maps,
// unlike COSE header maps), so a decoded map is returned as a plain object.

/** A reason a value cannot be canonically encoded. */
export type CanonicalEncodeReason =
  | 'non_integer_number'
  | 'integer_out_of_range'
  | 'invalid_utf8'
  | 'non_nfc_text'
  | 'invalid_map_key_type'
  | 'duplicate_map_key'
  | 'unsupported_type';

/** Thrown by `canonical(...)` on any value the deterministic profile rejects. */
export class CanonicalEncodeError extends Error {
  constructor(
    readonly reason: CanonicalEncodeReason,
    readonly path: string,
  ) {
    super(`canonical encode rejected (${reason}) at ${path || '<root>'}`);
    this.name = 'CanonicalEncodeError';
  }
}

/** A reason a byte string is not canonical DAG-CBOR. */
export type CanonicalDecodeReason =
  | 'unexpected_end'
  | 'reserved_additional_info'
  | 'indefinite_length'
  | 'non_shortest_argument'
  | 'unsupported_major_type'
  | 'unsupported_simple_value'
  | 'invalid_utf8'
  | 'non_nfc_text'
  | 'invalid_map_key_type'
  | 'map_key_not_sorted'
  | 'trailing_bytes'
  | 'max_depth_exceeded'
  | 'max_bytes_exceeded'
  | 'item_budget_exceeded';

/** Thrown by `decodeCanonical(...)` with the exact reason and byte offset. */
export class CanonicalDecodeError extends Error {
  constructor(
    readonly reason: CanonicalDecodeReason,
    readonly offset: number,
  ) {
    super(`canonical decode rejected (${reason}) at byte ${offset}`);
    this.name = 'CanonicalDecodeError';
  }
}

/** A plain string-keyed object in the canonical value model. */
export interface CanonicalObject {
  readonly [key: string]: CanonicalValue | undefined;
}

/**
 * A logical canonical value: a JS safe integer or `bigint` (the full CBOR
 * 0..2^64−1 / −2^64..−1 argument range), a byte string, an NFC valid-UTF-8 text
 * string, a boolean, `null`, an array, or a string-keyed object.  `undefined`
 * is NOT a value — it is the "omit this optional field" marker inside an object.
 */
export type CanonicalValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | readonly CanonicalValue[]
  | CanonicalObject;

/** The value a successful decode returns (objects for maps; never `undefined`). */
export type DecodedCanonicalValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | DecodedCanonicalValue[]
  | { [key: string]: DecodedCanonicalValue };

/** Resource caps applied by the strict decoder (PRIVATE_SPEC §27 / §9.4). */
export interface CanonicalDecodeLimits {
  readonly maxDepth: number;
  readonly maxBytes: number;
  readonly maxItems: number;
}

/** Conservative defaults; callers MAY tighten per object class. */
export const DEFAULT_CANONICAL_DECODE_LIMITS: CanonicalDecodeLimits = {
  maxDepth: 32,
  maxBytes: 4_194_304,
  maxItems: 131_072,
};

const MAX_UINT64 = (1n << 64n) - 1n;
const TEXT_ENCODER = new TextEncoder();
/** A `fatal` UTF-8 decoder: throws on malformed bytes rather than substituting. */
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** A UTF-16 lone surrogate ⇒ not well-formed Unicode ⇒ not valid UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Compare two byte strings in ascending bytewise-lexicographic order: the first
 * differing byte decides, and a proper prefix sorts before its extension.
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

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
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

// --- encoder ---------------------------------------------------------------

/** Emit `major`'s head byte plus the shortest-form argument for `0 ≤ n ≤ 2^64−1`. */
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
    if (!Number.isSafeInteger(value)) throw new CanonicalEncodeError('non_integer_number', path);
    n = BigInt(value);
  } else {
    n = value;
  }
  if (n >= 0n) {
    if (n > MAX_UINT64) throw new CanonicalEncodeError('integer_out_of_range', path);
    return writeArgument(0, n);
  }
  const arg = -1n - n;
  if (arg > MAX_UINT64) throw new CanonicalEncodeError('integer_out_of_range', path);
  return writeArgument(1, arg);
}

function encodeText(value: string, path: string): Uint8Array {
  if (LONE_SURROGATE.test(value)) throw new CanonicalEncodeError('invalid_utf8', path);
  if (value.normalize('NFC') !== value) throw new CanonicalEncodeError('non_nfc_text', path);
  const utf8 = TEXT_ENCODER.encode(value);
  return concat([writeArgument(3, BigInt(utf8.length)), utf8]);
}

function encodeBytes(value: Uint8Array): Uint8Array {
  return concat([writeArgument(2, BigInt(value.length)), value]);
}

function encodeArray(arr: readonly CanonicalValue[], path: string): Uint8Array {
  const parts: Uint8Array[] = [writeArgument(4, BigInt(arr.length))];
  for (let i = 0; i < arr.length; i++) {
    parts.push(encodeValue(arr[i] as CanonicalValue, `${path}[${i}]`));
  }
  return concat(parts);
}

function encodeObject(obj: CanonicalObject, path: string): Uint8Array {
  // Collect (encodedKey, encodedValue) for every PRESENT key — `undefined`
  // values are omitted (the optional-omit rule), never encoded as null.
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined) continue;
    const keyBytes = encodeText(k, `${path} key`);
    const valueBytes = encodeValue(v, `${path}.${k}`);
    entries.push({ key: keyBytes, value: valueBytes });
  }

  entries.sort((a, b) => compareBytes(a.key, b.key));
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (prev && cur && compareBytes(prev.key, cur.key) === 0) {
      throw new CanonicalEncodeError('duplicate_map_key', path);
    }
  }

  const parts: Uint8Array[] = [writeArgument(5, BigInt(entries.length))];
  for (const entry of entries) parts.push(entry.key, entry.value);
  return concat(parts);
}

function encodeValue(value: CanonicalValue, path: string): Uint8Array {
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
      if (isUint8Array(value)) return encodeBytes(value);
      if (Array.isArray(value)) return encodeArray(value, path);
      // FAIL CLOSED on any exotic object (Date, Map, Set, RegExp, typed arrays,
      // class instances): `Object.keys(...)` is empty for most of them, so the
      // permissive path would SILENTLY encode them as an empty map — a forgery /
      // collision vector for a structure that is hashed + signed.  Only a plain
      // object (`{}` / `Object.create(null)`) is a canonical map.  This matters
      // because several schemas carry `z.unknown()` fields (`submission_metadata`,
      // `location_scope`, `metadata`, `terms`) whose contents reach `canonical`.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalEncodeError('unsupported_type', path);
      }
      return encodeObject(value as CanonicalObject, path);
    }
    default:
      throw new CanonicalEncodeError('unsupported_type', path);
  }
}

/**
 * Encode a logical value to its SINGLE canonical DAG-CBOR byte sequence.  This
 * is THE `canonical(...)` referenced everywhere in PRIVATE_SPEC.  Throws
 * `CanonicalEncodeError` (with the offending path) on any value the profile
 * cannot represent.
 */
export function canonical(value: CanonicalValue): Uint8Array {
  return encodeValue(value, '');
}

// --- decoder ---------------------------------------------------------------

interface Reader {
  readonly bytes: Uint8Array;
  pos: number;
  depth: number;
  items: number;
  readonly limits: CanonicalDecodeLimits;
}

function asInteger(n: bigint): number | bigint {
  return n >= MIN_SAFE && n <= MAX_SAFE ? Number(n) : n;
}

function need(r: Reader, n: number, offset: number): void {
  if (r.pos + n > r.bytes.length) throw new CanonicalDecodeError('unexpected_end', offset);
}

function toBoundedCount(n: bigint, r: Reader, offset: number): number {
  if (n > BigInt(r.limits.maxBytes)) throw new CanonicalDecodeError('max_bytes_exceeded', offset);
  return Number(n);
}

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
      throw new CanonicalDecodeError('reserved_additional_info', headOffset);
    default: // 31
      throw new CanonicalDecodeError('indefinite_length', headOffset);
  }
  need(r, width, headOffset);
  let n = 0n;
  for (let i = 0; i < width; i++) {
    n = (n << 8n) | BigInt(r.bytes[r.pos + i] as number);
  }
  r.pos += width;
  if (n < min) throw new CanonicalDecodeError('non_shortest_argument', headOffset);
  return n;
}

function decodeItem(r: Reader): DecodedCanonicalValue {
  if (r.depth > r.limits.maxDepth) throw new CanonicalDecodeError('max_depth_exceeded', r.pos);
  r.items += 1;
  if (r.items > r.limits.maxItems) throw new CanonicalDecodeError('item_budget_exceeded', r.pos);

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
        throw new CanonicalDecodeError('invalid_utf8', headOffset);
      }
      if (text.normalize('NFC') !== text) {
        throw new CanonicalDecodeError('non_nfc_text', headOffset);
      }
      return text;
    }
    case 4: {
      const count = toBoundedCount(readArgument(r, ai, headOffset), r, headOffset);
      r.depth += 1;
      const arr: DecodedCanonicalValue[] = [];
      for (let i = 0; i < count; i++) arr.push(decodeItem(r));
      r.depth -= 1;
      return arr;
    }
    case 5: {
      const count = toBoundedCount(readArgument(r, ai, headOffset), r, headOffset);
      r.depth += 1;
      // A NULL-prototype object: a canonical map key is arbitrary text, so a key
      // like `__proto__` (legitimate inside a `z.unknown()` field) must become an
      // OWN property — on a plain `{}` it would invoke the prototype setter and
      // drop/mutate the field, breaking the `canonical(decodeCanonical(b))` round
      // trip (and risking prototype pollution).  `Object.keys` still enumerates it.
      const obj: { [key: string]: DecodedCanonicalValue } = Object.create(null);
      let prevKey: Uint8Array | null = null;
      for (let i = 0; i < count; i++) {
        const keyStart = r.pos;
        const key = decodeItem(r);
        const keyEnd = r.pos;
        if (typeof key !== 'string') {
          throw new CanonicalDecodeError('invalid_map_key_type', keyStart);
        }
        const keyBytes = r.bytes.subarray(keyStart, keyEnd);
        // Strictly-ascending encoded-key order catches mis-ordering AND
        // duplicates (equal encoded bytes) in one comparison.
        if (prevKey !== null && compareBytes(prevKey, keyBytes) >= 0) {
          throw new CanonicalDecodeError('map_key_not_sorted', keyStart);
        }
        prevKey = keyBytes;
        obj[key] = decodeItem(r);
      }
      r.depth -= 1;
      return obj;
    }
    case 6:
      throw new CanonicalDecodeError('unsupported_major_type', headOffset);
    default: {
      // major === 7 — only false (0xf4) / true (0xf5) / null (0xf6) are canonical.
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
          throw new CanonicalDecodeError('reserved_additional_info', headOffset);
        default:
          throw new CanonicalDecodeError('unsupported_simple_value', headOffset);
      }
    }
  }
}

/**
 * Decode canonical DAG-CBOR bytes to a logical value, REJECTING (never
 * normalizing) any non-canonical or over-budget input with a typed
 * `CanonicalDecodeError(reason, offset)`.  Total over its bounded input:
 * `decodeCanonical(canonical(v))` is structurally `v`, and
 * `canonical(decodeCanonical(b))` is byte-identical to canonical `b`.
 */
export function decodeCanonical(
  bytes: Uint8Array,
  limits: CanonicalDecodeLimits = DEFAULT_CANONICAL_DECODE_LIMITS,
): DecodedCanonicalValue {
  if (bytes.length > limits.maxBytes) throw new CanonicalDecodeError('max_bytes_exceeded', 0);
  const r: Reader = { bytes, pos: 0, depth: 0, items: 0, limits };
  const value = decodeItem(r);
  if (r.pos !== bytes.length) throw new CanonicalDecodeError('trailing_bytes', r.pos);
  return value;
}
