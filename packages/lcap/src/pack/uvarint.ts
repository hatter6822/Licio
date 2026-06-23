// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unsigned LEB128 varints for the pack length prefixes (OFFLINE_SPEC §14.3).
// Safe-integer arithmetic (not 32-bit bitwise) so lengths up to 2^53−1 round-trip.

export function writeUvarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('uvarint out of range');
  const bytes: number[] = [];
  let v = value;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return Uint8Array.from(bytes);
}

export interface UvarintRead {
  readonly value: number;
  readonly bytesRead: number;
}

export function readUvarint(bytes: Uint8Array, offset: number): UvarintRead {
  let value = 0;
  let scale = 1;
  let bytesRead = 0;
  for (;;) {
    if (offset + bytesRead >= bytes.length) throw new Error('uvarint truncated');
    const b = bytes[offset + bytesRead] as number;
    bytesRead += 1;
    value += (b & 0x7f) * scale;
    // Reject as soon as the ACCUMULATED value leaves the safe-integer range —
    // checking `value` (not just `scale`) catches the terminator-byte case the
    // scale guard misses (it sits after the `break`), where a high final group
    // would otherwise round to a wrong length instead of being rejected.
    if (value > Number.MAX_SAFE_INTEGER) throw new Error('uvarint too large');
    if ((b & 0x80) === 0) break;
    scale *= 128;
    if (scale > Number.MAX_SAFE_INTEGER) throw new Error('uvarint too large');
  }
  return { value, bytesRead };
}
