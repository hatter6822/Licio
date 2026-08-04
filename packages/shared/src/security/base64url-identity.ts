// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When a base64url string is an IDENTITY, one key must have exactly one
// spelling.
//
// Unpadded base64url encodes 6 bits per character, and a byte count that is not
// a multiple of 3 leaves the final character with unused LOW bits that no
// decoder reads.  A 32-byte key is 43 characters — 258 bits of characters for
// 256 bits of key — so every key has FOUR valid spellings, and a 64-byte
// signature (86 characters, 4 slack bits) has sixteen.  Standard encoders emit
// the one with the slack zeroed; nothing stops a caller writing another.
//
// That is harmless while the value is only ever decoded.  It stops being
// harmless the moment the TEXT carries meaning: `private_room_stubs.
// room_public_key` is a UNIQUE index and is compared with `=`, so a room whose
// key is spelled four ways is four rooms to Postgres and one room to Ed25519 —
// and the possession proof verifies under every one of them, because it is
// checked against the decoded bytes.  The uniqueness that makes a room's
// registration unforgeable would be bypassed by flipping one character.
//
// So the boundary requires the canonical spelling, and does it by ARITHMETIC
// rather than by decoding: the final character's alphabet index must have its
// unused low bits clear.  Equivalent to decode-and-re-encode, with no allocation
// and no dependence on a decoder's tolerance for the very bits in question.

/** RFC 4648 §5 (URL and filename safe), in index order. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The exact unpadded base64url length of `bytes` bytes. */
export function base64UrlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/**
 * Whether `value` is the CANONICAL unpadded base64url encoding of exactly
 * `bytes` bytes — the only spelling a conforming encoder produces.
 *
 * Length and alphabet are checked here too, so a caller cannot satisfy this
 * while failing either: this is the whole predicate for "is a key", not a
 * refinement that assumes the others already ran.
 */
export function isCanonicalBase64Url(value: string, bytes: number): boolean {
  const chars = base64UrlLength(bytes);
  if (value.length !== chars) return false;
  for (const character of value) {
    if (!ALPHABET.includes(character)) return false;
  }
  const slackBits = chars * 6 - bytes * 8;
  // A byte count divisible by 3 fills every character; there is no slack to
  // check, and every alphabet-legal string of that length is canonical.
  if (slackBits === 0) return true;
  const index = ALPHABET.indexOf(value.slice(chars - 1));
  return (index & ((1 << slackBits) - 1)) === 0;
}
