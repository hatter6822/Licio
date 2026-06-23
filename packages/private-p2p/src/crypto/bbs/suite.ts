// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 (rendezvous cap) — the BBS ciphersuite layer, `BLS12-381-SHA-256`.
//
// A THIN protocol layer over `@noble/curves`'s VETTED BLS12-381 (we do NOT
// re-implement pairing arithmetic), conformant to `draft-irtf-cfrg-bbs-signatures`
// and PINNED to its published byte-exact test vectors (`bbs/__tests__`, fetched from
// the `decentralized-identity/bbs-signature` reference fixtures).  Gated behind
// `check:p2p-bbs-wrapper` (no deep `@noble/curves` imports elsewhere) and loaded only
// from the lazy private-p2p chunk.  The Tier-2 cap it backs FAILS OPEN to the Tier-1
// sample-poll.  See docs/private-p2p/TIER2-RENDEZVOUS-CAP.md.

import { expand_message_xmd } from '@noble/curves/abstract/hash-to-curve.js';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const G1 = bls.G1.Point;
export const G2 = bls.G2.Point;
export type G1Point = InstanceType<typeof G1>;
export type G2Point = InstanceType<typeof G2>;

/** The BLS12-381 subgroup order (the scalar field modulus `r`). */
export const ORDER: bigint = bls.fields.Fr.ORDER;
export const OCTET_SCALAR_LENGTH = 32;
export const OCTET_POINT_LENGTH = 48; // G1 compressed; G2 is 96
const EXPAND_LEN = 48;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The `BLS12-381-SHA-256` ciphersuite + the BBS Signatures Interface `api_id`. */
export const CIPHERSUITE_ID = 'BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_';
export const API_ID = `${CIPHERSUITE_ID}H2G_HM2S_`;

const DST_SEED = enc(`${API_ID}SIG_GENERATOR_SEED_`);
const DST_GENERATOR = enc(`${API_ID}SIG_GENERATOR_DST_`);
const GENERATOR_SEED = enc(`${API_ID}MESSAGE_GENERATOR_SEED`);
const DST_MAP_MSG = enc(`${API_ID}MAP_MSG_TO_SCALAR_AS_HASH_`);
/** The hash-to-scalar DST used by `e`, the domain, and the proof challenge. */
export const DST_H2S = enc(`${API_ID}H2S_`);
export const API_ID_BYTES = enc(API_ID);

/** The fixed ciphersuite point `P1` (the §test-vector value, verified in the tests). */
const P1_HEX =
  'a8ce256102840821a3e94ea9025e4662b205762f9776b3a766c872b948f1fd225e7c59698588e70d11406d161b4e28c9';
export const P1: G1Point = G1.fromHex(P1_HEX);

// --- octet/scalar helpers ----------------------------------------------------

/** I2OSP: a non-negative integer to a fixed-length big-endian octet string. */
export function i2osp(value: number | bigint, length: number): Uint8Array {
  let v = BigInt(value);
  if (v < 0n) throw new Error('i2osp: negative');
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error('i2osp: integer too large');
  return out;
}

/** OS2IP: a big-endian octet string to a non-negative integer. */
export function os2ip(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export const mod = (x: bigint): bigint => ((x % ORDER) + ORDER) % ORDER;

/** Modular inverse in the scalar field (via the vetted field op). */
export function invScalar(x: bigint): bigint {
  const Fr = bls.fields.Fr;
  return Fr.inv(Fr.create(mod(x))) as bigint;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// --- BBS primitives (draft §Utilities) ---------------------------------------

/** `hash_to_scalar(msg, dst)` — expand_message_xmd-SHA-256 to 48 bytes, then mod r. */
export function hashToScalar(msg: Uint8Array, dst: Uint8Array = DST_H2S): bigint {
  return mod(os2ip(expand_message_xmd(msg, dst, EXPAND_LEN, sha256)));
}

/** `messages_to_scalars` — map one application message (octets) to a scalar. */
export function messageToScalar(message: Uint8Array): bigint {
  return hashToScalar(message, DST_MAP_MSG);
}

/**
 * `create_generators(count)` (draft §Generators) — `v = expand(seed)`, then for each
 * i: `v = expand(v || I2OSP(i, 8))`, `generator_i = hash_to_curve_g1(v, generator_dst)`.
 * Returns `[Q_1, H_1, …, H_{count-1}]`.
 */
export function createGenerators(count: number): G1Point[] {
  const gens: G1Point[] = [];
  let v = expand_message_xmd(GENERATOR_SEED, DST_SEED, EXPAND_LEN, sha256);
  for (let i = 1; i <= count; i++) {
    v = expand_message_xmd(concatBytes(v, i2osp(i, 8)), DST_SEED, EXPAND_LEN, sha256);
    gens.push(bls.G1.hashToCurve(v, { DST: DST_GENERATOR }) as unknown as G1Point);
  }
  return gens;
}

/** Serialize a G1 point to its 48-byte compressed encoding (`point_to_octets_E1`). */
export const g1Bytes = (p: G1Point): Uint8Array => p.toBytes();
/** Serialize a G2 point to its 96-byte compressed encoding (`point_to_octets_E2`). */
export const g2Bytes = (p: G2Point): Uint8Array => p.toBytes();
/** A scalar to its fixed 32-byte big-endian encoding. */
export const scalarBytes = (s: bigint): Uint8Array => i2osp(mod(s), OCTET_SCALAR_LENGTH);

/**
 * `calculate_domain` (draft §Domain Calculation):
 *   dom = hash_to_scalar(PK || serialize((L, Q_1, H_1..H_L)) || api_id
 *                           || I2OSP(len(header), 8) || header, H2S_dst)
 */
export function calculateDomain(
  pk: G2Point,
  q1: G1Point,
  hGenerators: readonly G1Point[],
  header: Uint8Array,
): bigint {
  const dom: Uint8Array[] = [i2osp(hGenerators.length, 8), g1Bytes(q1)];
  for (const h of hGenerators) dom.push(g1Bytes(h));
  const domOcts = concatBytes(concatBytes(...dom), API_ID_BYTES);
  const domInput = concatBytes(g2Bytes(pk), domOcts, i2osp(header.length, 8), header);
  return hashToScalar(domInput, DST_H2S);
}

/** The pairing check `e(a, x) == e(b, y)` in GT. */
export function pairingEqual(a: G1Point, x: G2Point, b: G1Point, y: G2Point): boolean {
  return bls.fields.Fp12.eql(bls.pairing(a, x), bls.pairing(b, y));
}

export { bls };
