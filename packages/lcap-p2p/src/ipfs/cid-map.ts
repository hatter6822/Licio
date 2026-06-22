// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The verification-preserving LCAP-block-CID ⇄ IPFS-CID mapping (OFFLINE_SPEC §22.7,
// §9.2, WS-R.15.7a).  An LCAP `block_cid` is a custom §9 layout, NOT an IPFS CID, but
// it EMBEDS a sha2-256 digest.  To announce/request a public block over an IPFS network
// we wrap THE SAME digest as `CIDv1(raw 0x55, sha2-256 multihash)` — the canonical IPFS
// addressing of raw bytes — so the two names point at the identical content.  Crucially
// the bridge re-derives and re-verifies the LCAP `block_cid` over every fetched block
// BEFORE any use, so DHT interop never weakens LCAP hash verification (no transport
// trust).  The multibase-b base32 encoder is hand-rolled (the §31.1 zero-dep ethos).

import { parseCid } from '@licio/lcap';

// RFC 4648 base32, lowercase, no padding — IPFS multibase code 'b'.
const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Encode bytes as multibase-`b` base32 (lowercase, unpadded) — an IPFS CIDv1 text form.
 *  `value` is masked to the un-emitted low bits after each 5-bit group, so the
 *  accumulator never exceeds 12 bits and correctness does not rely on JS's 32-bit
 *  overflow silently dropping stale high bits (cf. `@licio/lcap` `base32Encode`). */
export function multibaseBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = 'b'; // the multibase prefix for base32 (RFC 4648 lowercase)
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(value >>> bits) & 0x1f];
    }
    value &= (1 << bits) - 1; // keep only the un-emitted low `bits` bits
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

const CIDV1_VERSION = 0x01;
const RAW_CODEC = 0x55;
const SHA2_256 = 0x12;
const DIGEST_LEN = 0x20;

/** Build the IPFS `CIDv1(raw, sha2-256)` text form over a 32-byte sha2-256 `digest`. */
export function ipfsCidV1FromDigest(digest: Uint8Array): string {
  if (digest.length !== 32) throw new RangeError('sha2-256 digest must be 32 bytes');
  const cidBytes = new Uint8Array(4 + 32);
  cidBytes[0] = CIDV1_VERSION;
  cidBytes[1] = RAW_CODEC;
  cidBytes[2] = SHA2_256;
  cidBytes[3] = DIGEST_LEN;
  cidBytes.set(digest, 4);
  return multibaseBase32(cidBytes);
}

/**
 * Map an LCAP `block_cid` to the IPFS `CIDv1(raw, sha2-256)` over the SAME digest.
 * Throws if `blockCid` is malformed or is not a `block` CID (only blocks bridge to the
 * public DHT; records/proofs/chunks never do).
 */
export function ipfsCidForBlockCid(blockCid: string): string {
  const parsed = parseCid(blockCid);
  if (parsed.kind !== 'block') {
    throw new Error(`only block CIDs bridge to IPFS (got ${parsed.kind})`);
  }
  return ipfsCidV1FromDigest(parsed.digest);
}
