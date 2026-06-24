// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — BBS KeyGen / Sign / Verify (`draft-irtf-cfrg-bbs-signatures`,
// BLS12-381-SHA-256), vector-pinned in `__tests__/signature.test.ts`.
//
//   B = P1 + Q1*domain + Σ H_i*m_i,   A = B * 1/(SK + e)
//   Verify: e(A, W) * e(A*e - B, BP2) == 1_GT   (W = PK)
// The pairing check IS the soundness anchor; round-trip + tamper-rejection are
// decisive. Unforgeability rests on BLS12-381 + q-SDH + the NUMS generators.

import { randomBytes } from '../runtime.js';
import {
  bls,
  calculateDomain,
  concatBytes,
  createGenerators,
  DST_H2S,
  G1,
  type G1Point,
  G2,
  type G2Point,
  hashToScalar,
  invScalar,
  messageToScalar,
  mod,
  ORDER,
  os2ip,
  P1,
  pairingEqual,
  scalarBytes,
} from './suite.js';

export interface BbsKeyPair {
  readonly sk: bigint;
  readonly pk: G2Point;
}
export interface BbsSignature {
  readonly a: G1Point;
  readonly e: bigint;
}

/** A uniformly-random non-zero scalar in `[1, r)` (48 bytes mod r ⇒ negligible bias). */
export function randomScalar(): bigint {
  for (;;) {
    const s = mod(os2ip(randomBytes(48)));
    if (s !== 0n) return s;
  }
}

/** Generate a BBS key pair (`sk` scalar, `pk = sk * BP2`). */
export function bbsKeyGen(): BbsKeyPair {
  const sk = randomScalar();
  return { sk, pk: G2.BASE.multiply(sk) };
}

/** `B = P1 + Q1*domain + Σ H_i*m_i`. */
function computeB(
  domain: bigint,
  q1: G1Point,
  h: readonly G1Point[],
  msgScalars: bigint[],
): G1Point {
  let b = P1.add(q1.multiply(domain));
  for (let i = 0; i < msgScalars.length; i++) {
    const m = msgScalars[i];
    const hi = h[i];
    if (m === undefined || hi === undefined)
      throw new Error('bbs: generator/message length mismatch');
    b = b.add(hi.multiply(m));
  }
  return b;
}

/** The `(Q1, H[], domain, msgScalars)` shared by Sign / Verify / Proof. */
export function setup(
  pk: G2Point,
  header: Uint8Array,
  messages: readonly Uint8Array[],
): { q1: G1Point; h: G1Point[]; domain: bigint; msgScalars: bigint[] } {
  const gens = createGenerators(messages.length + 1);
  const q1 = gens[0];
  if (q1 === undefined) throw new Error('bbs: missing Q1');
  const h = gens.slice(1);
  return {
    q1,
    h,
    domain: calculateDomain(pk, q1, h, header),
    msgScalars: messages.map(messageToScalar),
  };
}

/** Sign a message vector under `sk`/`pk` with a (possibly empty) `header`. */
export function bbsSign(
  keyPair: BbsKeyPair,
  messages: readonly Uint8Array[],
  header: Uint8Array = new Uint8Array(0),
): BbsSignature {
  const { q1, h, domain, msgScalars } = setup(keyPair.pk, header, messages);
  // e = hash_to_scalar(serialize((SK, msg_1..msg_L, domain)), H2S_dst)
  const eInput = concatBytes(
    scalarBytes(keyPair.sk),
    ...msgScalars.map(scalarBytes),
    scalarBytes(domain),
  );
  const e = hashToScalar(eInput, DST_H2S);
  const b = computeB(domain, q1, h, msgScalars);
  const skPlusE = mod(keyPair.sk + e);
  if (skPlusE === 0n) throw new Error('bbs: sk + e == 0 (retry key)'); // negligible
  const a = b.multiply(invScalar(skPlusE));
  if (a.is0()) throw new Error('bbs: A is identity (invalid)');
  return { a, e };
}

/** Verify a BBS signature over a message vector. */
export function bbsVerify(
  pk: G2Point,
  signature: BbsSignature,
  messages: readonly Uint8Array[],
  header: Uint8Array = new Uint8Array(0),
): boolean {
  if (signature.e <= 0n || signature.e >= ORDER) return false;
  let q1: G1Point;
  let h: G1Point[];
  let domain: bigint;
  let msgScalars: bigint[];
  try {
    if (signature.a.is0()) return false;
    signature.a.assertValidity();
    ({ q1, h, domain, msgScalars } = setup(pk, header, messages));
  } catch {
    return false;
  }
  const b = computeB(domain, q1, h, msgScalars);
  // e(A, W) * e(A*e - B, BP2) == 1_GT
  const lhs = bls.pairing(signature.a, pk);
  const rhs = bls.pairing(signature.a.multiply(signature.e).subtract(b), G2.BASE);
  return bls.fields.Fp12.eql(bls.fields.Fp12.mul(lhs, rhs), bls.fields.Fp12.ONE);
}

/**
 * Verify a BBS signature directly against a SCALAR message vector + an explicit message-
 * generator set (the composition anchor for blind issuance, blind.ts): checks that
 * `(A, e)` is a valid base BBS signature over `B = P1 + q1·domain + Σ msgGens_i·msgScalars_i`.
 * This is the SAME vetted pairing check as `bbsVerify`, lifted to scalars/generators.
 */
export function bbsVerifyScalars(
  pk: G2Point,
  signature: BbsSignature,
  q1: G1Point,
  msgGens: readonly G1Point[],
  msgScalars: readonly bigint[],
  header: Uint8Array = new Uint8Array(0),
): boolean {
  if (signature.e <= 0n || signature.e >= ORDER) return false;
  if (msgGens.length !== msgScalars.length) return false;
  try {
    if (signature.a.is0()) return false;
    signature.a.assertValidity();
    pk.assertValidity();
  } catch {
    return false;
  }
  const domain = calculateDomain(pk, q1, msgGens, header);
  let b = P1.add(q1.multiply(domain));
  for (let i = 0; i < msgScalars.length; i++) {
    const s = mod(msgScalars[i] as bigint);
    if (s !== 0n) b = b.add((msgGens[i] as G1Point).multiply(s));
  }
  return pairingEqual(signature.a, pk.add(G2.BASE.multiply(signature.e)), b, G2.BASE);
}

/** Serialize a signature to its 80-byte wire form (`A || e`). */
export function signatureToBytes(sig: BbsSignature): Uint8Array {
  return concatBytes(sig.a.toBytes(), scalarBytes(sig.e));
}

/** Parse an 80-byte wire signature (`A || e`); throws on a malformed encoding. */
export function signatureFromBytes(bytes: Uint8Array): BbsSignature {
  if (bytes.length !== 80) throw new Error('bbs: signature must be 80 bytes');
  const a = G1.fromBytes(bytes.slice(0, 48));
  const e = os2ip(bytes.slice(48, 80));
  if (e <= 0n || e >= ORDER) throw new Error('bbs: signature e out of range');
  return { a, e };
}
