// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RFC 4648 §6 base32, lower-case, no padding — the CID string form (§9.2).
// Encoding is MSB-first; decoding is strict (it rejects any character outside
// the lower-case alphabet, any length that cannot be a whole-byte group, and
// any non-zero trailing padding bits) so a CID string has exactly one byte
// preimage.

/** RFC 4648 base32 alphabet, lower-cased (a–z, 2–7). */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const DECODE_MAP: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((ch, index) => [ch, index]),
);

/** Thrown by `base32Decode` on any non-canonical / out-of-alphabet input. */
export class Base32Error extends Error {
  override readonly name = 'Base32Error';
}

export function base32Encode(data: Uint8Array): string {
  let output = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | (data[i] as number);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(value >>> bits) & 31];
    }
    // Drop the bits we just emitted so `value` never overflows 32 bits.
    value &= (1 << bits) - 1;
  }
  if (bits > 0) {
    // Zero-pad the final partial group up to 5 bits (RFC 4648 bit padding).
    output += ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const idx = DECODE_MAP.get(ch);
    if (idx === undefined) throw new Base32Error(`invalid base32 character: ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
    value &= (1 << bits) - 1;
  }
  // A canonical no-padding encoding leaves < 5 leftover bits, all zero.
  if (bits >= 5) throw new Base32Error('invalid base32 length');
  if (value !== 0) throw new Base32Error('non-zero base32 padding bits');
  return Uint8Array.from(out);
}
