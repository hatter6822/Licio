// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed encode/decode failures.  Every rejection carries a machine-readable
// `reason` (and, for decode, the byte `offset` of the offending item) so the
// conformance suite can assert the exact failure mode, never a generic throw.

/** Why an encode failed (OFFLINE_SPEC §9.1.2/§9.1.3). */
export type LdcEncodeReason =
  /** A value of a type LDC does not encode (float, undefined, symbol, object). */
  | 'unsupported_type'
  /** A `number` that is not a safe integer (fractional, NaN, or ±Infinity). */
  | 'non_integer_number'
  /** An integer outside the representable CBOR argument range. */
  | 'integer_out_of_range'
  /** A text string with an unpaired UTF-16 surrogate (not valid UTF-8). */
  | 'invalid_utf8'
  /** A text string that is not Unicode NFC-normalized. */
  | 'non_nfc_text'
  /** A map key whose type is neither integer nor text. */
  | 'invalid_map_key_type'
  /** Two map keys whose deterministic encodings are byte-identical. */
  | 'duplicate_map_key';

/** Thrown by `encode` on any non-encodable input, with the offending path. */
export class LdcEncodeError extends Error {
  override readonly name = 'LdcEncodeError';
  readonly reason: LdcEncodeReason;
  /** A dotted/bracketed path to the offending value (e.g. `map["k"]`, `[3]`). */
  readonly path: string;

  constructor(reason: LdcEncodeReason, path: string, message?: string) {
    super(message ?? `LDC encode rejected (${reason}) at ${path || '<root>'}`);
    this.reason = reason;
    this.path = path;
  }
}

/** Why a decode failed (OFFLINE_SPEC §9.1.1/§9.1.4/§27.1). */
export type LdcDecodeReason =
  /** The input ended in the middle of an item. */
  | 'unexpected_end'
  /** Bytes remained after the single top-level item. */
  | 'trailing_bytes'
  /** Additional-info 28/29/30 (reserved by RFC 8949). */
  | 'reserved_additional_info'
  /** An indefinite-length item or a stray break (additional-info 31). */
  | 'indefinite_length'
  /** An argument not in shortest form (e.g. `0x18 0x05` for the value 5). */
  | 'non_shortest_argument'
  /** A CBOR tag (major type 6) — LCAP v0.2 permits none. */
  | 'unsupported_major_type'
  /** A major-type-7 value other than false/true/null (every float, undefined). */
  | 'unsupported_simple_value'
  /** A text string that is not valid UTF-8. */
  | 'invalid_utf8'
  /** A text string that is not Unicode NFC-normalized. */
  | 'non_nfc_text'
  /** A map key whose type is neither integer nor text. */
  | 'invalid_map_key_type'
  /** Map keys not strictly ascending by encoded-key bytes (dup or mis-order). */
  | 'map_key_not_sorted'
  /** Nesting deeper than the configured `maxDepth`. */
  | 'max_depth_exceeded'
  /** Input longer than the configured `maxBytes`. */
  | 'max_bytes_exceeded'
  /** More data items than the configured `maxItems`. */
  | 'item_budget_exceeded';

/** Thrown by `decode` on any non-canonical or over-budget input. */
export class LdcDecodeError extends Error {
  override readonly name = 'LdcDecodeError';
  readonly reason: LdcDecodeReason;
  /** The byte offset at which the failure was detected. */
  readonly offset: number;

  constructor(reason: LdcDecodeReason, offset: number, message?: string) {
    super(message ?? `LDC decode rejected (${reason}) at byte ${offset}`);
    this.reason = reason;
    this.offset = offset;
  }
}
