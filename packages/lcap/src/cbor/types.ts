// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The LCAP Deterministic CBOR (LDC) value model (OFFLINE_SPEC §9.1).  LDC is a
// closed subset of RFC 8949 §4.2.1 Core Deterministic Encoding: integers, byte
// strings, text strings, arrays, maps, and the three simple values
// false/true/null.  There are deliberately NO floats, tags, `undefined`, or
// indefinite-length items (§9.1.2) — every quantity is an integer (time is
// integer milliseconds) and every binary value is a byte string.

/**
 * A map key in an LDC value.  CBOR permits any value as a map key, but LCAP
 * record bodies and COSE header maps only ever key by integer (COSE header
 * labels such as `1`, `-7`) or text (record field names), so LDC restricts map
 * keys to those two kinds and fails closed on anything else (§9.1.2).
 */
export type LdcKey = number | bigint | string;

/**
 * A logical LDC value.  Integers are `number` (a JavaScript safe integer) or
 * `bigint` (for the full 64-bit CBOR argument range); `Uint8Array` is a byte
 * string; `string` is an NFC, valid-UTF-8 text string; `Map` is an LDC map.
 * Plain objects are deliberately NOT accepted — a `Map` makes the integer-keyed
 * COSE headers expressible and the key ordering explicit.
 */
export type LdcValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | readonly LdcValue[]
  | LdcMap;

/** An LDC map: an insertion-ordered key→value map; the encoder re-sorts keys. */
export type LdcMap = Map<LdcKey, LdcValue>;

/** Resource caps applied by the strict decoder (OFFLINE_SPEC §27.1). */
export interface LdcDecodeLimits {
  /** Maximum nesting depth of arrays/maps before the parser fails closed. */
  readonly maxDepth: number;
  /** Maximum total input length in bytes. */
  readonly maxBytes: number;
  /** Maximum number of decoded data items (a many-tiny-items bomb cap). */
  readonly maxItems: number;
}

/** Conservative LDC decode caps; callers MAY tighten them per transport. */
export const DEFAULT_DECODE_LIMITS: LdcDecodeLimits = {
  maxDepth: 16,
  maxBytes: 1_048_576,
  maxItems: 65_536,
};
