// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.2 — the §9.4 private CIDv1-over-ciphertext profile (dependency-free).
// A private CID is ALWAYS over CIPHERTEXT (§9.1: encrypt → pad → encrypt → chunk
// → CID; a plaintext private CID must never exist), so two devices content-
// address the identical encrypted bytes.  CIDv1 layout (multiformats-compatible,
// hand-rolled to keep the package free of the heavy Helia/multiformats trees):
//
//   multihash = 0x12 (sha2-256) || 0x20 (32-byte length) || SHA-256(ciphertext)
//   cidv1     = 0x01 (version)  || codec || multihash
//   string    = "b" (multibase base32-lower, no pad) || base32(cidv1)
//
// codec: 0x71 dag-cbor (small encrypted metadata) | 0x55 raw (large encrypted
// media chunks), per §9.4.

import { getSubtle, toBufferSource } from './runtime.js';

/** The §9.4 codecs: dag-cbor for small metadata, raw for large media chunks. */
export const PRIVATE_CID_CODEC = { dagCbor: 0x71, raw: 0x55 } as const;
export type PrivateCidCodec = (typeof PRIVATE_CID_CODEC)[keyof typeof PRIVATE_CID_CODEC];

const MULTIHASH_SHA256 = 0x12;
const SHA256_LENGTH = 0x20;
const CIDV1_VERSION = 0x01;
/** RFC 4648 base32 lowercase alphabet (multibase "b"). */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** SHA-256 over `data` via WebCrypto. */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await getSubtle().digest('SHA-256', toBufferSource(data)));
}

/** RFC 4648 base32 (lowercase, NO padding) — the multibase "b" body. */
export function base32LowerNoPad(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] as number);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Compute the §9.4 private CIDv1 string for `ciphertext` under `codec`.  ALWAYS
 * over ciphertext — there is no plaintext-CID entry point.
 */
export async function computePrivateCid(
  ciphertext: Uint8Array,
  codec: PrivateCidCodec,
): Promise<string> {
  const digest = await sha256(ciphertext);
  const cidBytes = new Uint8Array(2 + 2 + digest.length);
  cidBytes[0] = CIDV1_VERSION;
  cidBytes[1] = codec;
  cidBytes[2] = MULTIHASH_SHA256;
  cidBytes[3] = SHA256_LENGTH;
  cidBytes.set(digest, 4);
  return `b${base32LowerNoPad(cidBytes)}`;
}

/** Recompute and constant-relevant-compare a private CID over `ciphertext`. */
export async function verifyPrivateCid(
  ciphertext: Uint8Array,
  cid: string,
  codec: PrivateCidCodec,
): Promise<boolean> {
  return (await computePrivateCid(ciphertext, codec)) === cid;
}
