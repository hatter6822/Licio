// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — BBS ProofGen / ProofVerify (`draft-irtf-cfrg-bbs-signatures`,
// BLS12-381-SHA-256): the zero-knowledge proof-of-knowledge of a signature with
// selective disclosure — the unlinkable "show" at the heart of the Tier-2 anonymous
// credential. Vector-pinned in `__tests__/proof.test.ts` (the reference `proofNNN`
// fixtures expose the full `random_scalars`/A_bar/B_bar/D/T1/T2/domain/challenge
// trace, so every intermediate is checked, not just the final proof bytes).
//
// The proof is (Abar, Bbar, D, e^, r1^, r3^, (m^_j…), c). Verification recomputes the
// challenge and checks e(Abar, W)·e(Bbar, -BP2) == 1_GT.

import { expand_message_xmd } from '@noble/curves/abstract/hash-to-curve.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { type BbsSignature, randomScalar, setup } from './signature.js';
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
  g1Bytes,
  hashToScalar,
  i2osp,
  invScalar,
  messageToScalar,
  mod,
  ORDER,
  os2ip,
  P1,
  scalarBytes,
} from './suite.js';

const EXPAND_LEN = 48;
/** Scalar multiply that tolerates a zero scalar (→ identity), unlike noble's `multiply`. */
const mul = (p: G1Point, s: bigint): G1Point => {
  const m = mod(s);
  return m === 0n ? G1.ZERO : p.multiply(m);
};

export interface BbsProof {
  readonly aBar: G1Point;
  readonly bBar: G1Point;
  readonly d: G1Point;
  readonly eHat: bigint;
  readonly r1Hat: bigint;
  readonly r3Hat: bigint;
  readonly commitments: bigint[]; // m^_j for each undisclosed message
  readonly challenge: bigint;
}

/**
 * `seeded_random_scalars(SEED, DST, count)` — the deterministic scalar generator the
 * reference fixtures use to make `ProofGen` reproducible. Also the exact shape of the
 * production generator (which draws fresh `expand_len` bytes per scalar from a CSPRNG).
 */
export function seededRandomScalars(seed: Uint8Array, dst: Uint8Array, count: number): bigint[] {
  const v = expand_message_xmd(seed, dst, EXPAND_LEN * count, sha256);
  const scalars: bigint[] = [];
  for (let i = 0; i < count; i++)
    scalars.push(mod(os2ip(v.slice(i * EXPAND_LEN, (i + 1) * EXPAND_LEN))));
  return scalars;
}

const defaultRandomScalars = (count: number): bigint[] =>
  Array.from({ length: count }, () => randomScalar());

/**
 * `ProofChallengeCalculate`: c = H2S( serialize((R, i,msg_i …, Abar,Bbar,D,T1,T2,domain))
 * || extra || I2OSP(len(ph),8) || ph ). `extra` is empty for the base proof (so the IETF
 * vectors are unchanged) and carries the pseudonym terms `serialize(OP, nym, U)` for the
 * Tier-2 per-verifier-linkability extension (see pseudonym.ts).
 */
export function proofChallenge(
  aBar: G1Point,
  bBar: G1Point,
  d: G1Point,
  t1: G1Point,
  t2: G1Point,
  domain: bigint,
  disclosedScalars: readonly bigint[],
  disclosedIndexes: readonly number[],
  ph: Uint8Array,
  extra: Uint8Array = new Uint8Array(0),
): bigint {
  const parts: Uint8Array[] = [i2osp(disclosedIndexes.length, 8)];
  for (let k = 0; k < disclosedIndexes.length; k++) {
    parts.push(i2osp(disclosedIndexes[k] as number, 8), scalarBytes(disclosedScalars[k] as bigint));
  }
  parts.push(
    g1Bytes(aBar),
    g1Bytes(bBar),
    g1Bytes(d),
    g1Bytes(t1),
    g1Bytes(t2),
    scalarBytes(domain),
  );
  const cOcts = concatBytes(concatBytes(...parts), extra, i2osp(ph.length, 8), ph);
  return hashToScalar(cOcts, DST_H2S);
}

export const complementIndexes = (l: number, disclosed: ReadonlySet<number>): number[] => {
  const out: number[] = [];
  for (let i = 0; i < l; i++) if (!disclosed.has(i)) out.push(i);
  return out;
};

export interface ProofInit {
  aBar: G1Point;
  bBar: G1Point;
  d: G1Point;
  t1: G1Point;
  t2: G1Point;
  domain: bigint;
  msgScalars: bigint[];
  undisclosed: number[];
  mTilde: bigint[];
}

/** Shared ProofGen initialization (ProofInit): blind the signature + undisclosed messages. */
export function genInit(
  pk: G2Point,
  signature: BbsSignature,
  messages: readonly Uint8Array[],
  disclosedIndexes: readonly number[],
  header: Uint8Array,
  rs: bigint[],
): ProofInit {
  const l = messages.length;
  const r = disclosedIndexes.length;
  if (r > l) throw new Error('bbs proof: more disclosed than messages');
  for (const i of disclosedIndexes)
    if (i < 0 || i >= l) throw new Error('bbs proof: index out of range');
  const u = l - r;
  if (rs.length !== 5 + u) throw new Error('bbs proof: wrong random-scalar count');
  const undisclosed = complementIndexes(l, new Set(disclosedIndexes));
  const { q1, h, domain, msgScalars } = setup(pk, header, messages);
  const [r1, r2, eTilde, r1Tilde, r3Tilde] = rs as [bigint, bigint, bigint, bigint, bigint];
  const mTilde = rs.slice(5);

  let b = P1.add(mul(q1, domain));
  for (let i = 0; i < l; i++) b = b.add(mul(h[i] as G1Point, msgScalars[i] as bigint));
  const d = mul(b, r2);
  const aBar = mul(signature.a, mod(r1 * r2));
  const bBar = mul(d, r1).subtract(mul(aBar, signature.e));
  const t1 = mul(aBar, eTilde).add(mul(d, r1Tilde));
  let t2 = mul(d, r3Tilde);
  for (let k = 0; k < u; k++)
    t2 = t2.add(mul(h[undisclosed[k] as number] as G1Point, mTilde[k] as bigint));
  return { aBar, bBar, d, t1, t2, domain, msgScalars, undisclosed, mTilde };
}

/** Shared ProofFinalize: compute the responses + serialize the proof. */
export function genFinalize(
  signature: BbsSignature,
  challenge: bigint,
  rs: bigint[],
  init: ProofInit,
): Uint8Array {
  const [r1, r2, eTilde, r1Tilde, r3Tilde] = rs as [bigint, bigint, bigint, bigint, bigint];
  const eHat = mod(eTilde + signature.e * challenge);
  const r1Hat = mod(r1Tilde - r1 * challenge);
  const r3Hat = mod(r3Tilde - invScalar(r2) * challenge);
  const commitments: bigint[] = [];
  for (let k = 0; k < init.undisclosed.length; k++) {
    commitments.push(
      mod(
        (init.mTilde[k] as bigint) +
          (init.msgScalars[init.undisclosed[k] as number] as bigint) * challenge,
      ),
    );
  }
  return proofToBytes({
    aBar: init.aBar,
    bBar: init.bBar,
    d: init.d,
    eHat,
    r1Hat,
    r3Hat,
    commitments,
    challenge,
  });
}

export interface VerifyRecompute {
  t1: G1Point;
  t2: G1Point;
  domain: bigint;
  q1: G1Point;
  h: G1Point[];
  undisclosed: number[];
  disclosedScalars: bigint[];
}

/** Shared ProofVerifyInit: recompute T1/T2 from the proof + disclosed messages. Returns
 *  null on a structurally-invalid disclosure (caller treats null as INVALID). */
export function verifyRecompute(
  pk: G2Point,
  proof: BbsProof,
  disclosedMessages: readonly Uint8Array[],
  disclosedIndexes: readonly number[],
  header: Uint8Array,
): VerifyRecompute | null {
  const r = disclosedIndexes.length;
  const u = proof.commitments.length;
  const l = r + u;
  if (disclosedMessages.length !== r) return null;
  for (let k = 0; k < r; k++) {
    const idx = disclosedIndexes[k] as number;
    if (idx < 0 || idx >= l) return null;
    if (k > 0 && idx <= (disclosedIndexes[k - 1] as number)) return null; // ascending, distinct
  }
  const gens = createGenerators(l + 1);
  const q1 = gens[0];
  if (q1 === undefined) return null;
  const h = gens.slice(1);
  const disclosedScalars = disclosedMessages.map(messageToScalar);
  const undisclosed = complementIndexes(l, new Set(disclosedIndexes));
  const domain = calculateDomain(pk, q1, h, header);
  const c = proof.challenge;
  const t1 = mul(proof.bBar, c).add(mul(proof.aBar, proof.eHat)).add(mul(proof.d, proof.r1Hat));
  let bv = P1.add(mul(q1, domain));
  for (let k = 0; k < r; k++)
    bv = bv.add(mul(h[disclosedIndexes[k] as number] as G1Point, disclosedScalars[k] as bigint));
  let t2 = mul(bv, c).add(mul(proof.d, proof.r3Hat));
  for (let k = 0; k < u; k++)
    t2 = t2.add(mul(h[undisclosed[k] as number] as G1Point, proof.commitments[k] as bigint));
  return { t1, t2, domain, q1, h, undisclosed, disclosedScalars };
}

/** The final BBS proof pairing check: e(Abar, W)·e(Bbar, -BP2) == 1_GT. */
export function proofPairingHolds(proof: BbsProof, pk: G2Point): boolean {
  const lhs = bls.pairing(proof.aBar, pk);
  const rhs = bls.pairing(proof.bBar, G2.BASE.negate());
  return bls.fields.Fp12.eql(bls.fields.Fp12.mul(lhs, rhs), bls.fields.Fp12.ONE);
}

/**
 * Generate a BBS proof disclosing `disclosedIndexes` of `messages`. `randomScalarsOverride`
 * injects the mocked generator for the vector tests; production omits it (fresh CSPRNG).
 */
export function proofGen(
  pk: G2Point,
  signature: BbsSignature,
  messages: readonly Uint8Array[],
  disclosedIndexes: readonly number[],
  header: Uint8Array = new Uint8Array(0),
  ph: Uint8Array = new Uint8Array(0),
  randomScalarsOverride?: (count: number) => bigint[],
): Uint8Array {
  const u = messages.length - disclosedIndexes.length;
  const rs = (randomScalarsOverride ?? defaultRandomScalars)(5 + u);
  const init = genInit(pk, signature, messages, disclosedIndexes, header, rs);
  const disclosedScalars = disclosedIndexes.map((i) => init.msgScalars[i] as bigint);
  const challenge = proofChallenge(
    init.aBar,
    init.bBar,
    init.d,
    init.t1,
    init.t2,
    init.domain,
    disclosedScalars,
    disclosedIndexes,
    ph,
  );
  return genFinalize(signature, challenge, rs, init);
}

/** Verify a BBS proof against the disclosed messages. */
export function proofVerify(
  pk: G2Point,
  proofBytes: Uint8Array,
  disclosedMessages: readonly Uint8Array[],
  disclosedIndexes: readonly number[],
  header: Uint8Array = new Uint8Array(0),
  ph: Uint8Array = new Uint8Array(0),
): boolean {
  let proof: BbsProof;
  try {
    proof = proofFromBytes(proofBytes);
    pk.assertValidity();
  } catch {
    return false;
  }
  const rec = verifyRecompute(pk, proof, disclosedMessages, disclosedIndexes, header);
  if (rec === null) return false;
  const challenge = proofChallenge(
    proof.aBar,
    proof.bBar,
    proof.d,
    rec.t1,
    rec.t2,
    rec.domain,
    rec.disclosedScalars,
    disclosedIndexes,
    ph,
  );
  if (challenge !== proof.challenge) return false;
  return proofPairingHolds(proof, pk);
}

/** Scalar-multiply (zero-tolerant) — exported for the pseudonym extension. */
export { mul as bbsMul };

/** `proof_to_octets`: Abar||Bbar||D||e^||r1^||r3^||(m^_j…)||c. */
export function proofToBytes(proof: BbsProof): Uint8Array {
  return concatBytes(
    g1Bytes(proof.aBar),
    g1Bytes(proof.bBar),
    g1Bytes(proof.d),
    scalarBytes(proof.eHat),
    scalarBytes(proof.r1Hat),
    scalarBytes(proof.r3Hat),
    ...proof.commitments.map(scalarBytes),
    scalarBytes(proof.challenge),
  );
}

const PROOF_FLOOR = 3 * 48 + 4 * 32; // 272

/** `octets_to_proof`: parse + validate (G1 non-identity points; scalars in [1, r)). */
export function proofFromBytes(bytes: Uint8Array): BbsProof {
  if (bytes.length < PROOF_FLOOR || (bytes.length - PROOF_FLOOR) % 32 !== 0) {
    throw new Error('bbs proof: malformed length');
  }
  const u = (bytes.length - PROOF_FLOOR) / 32;
  const pt = (o: number): G1Point => {
    const p = G1.fromBytes(bytes.slice(o, o + 48));
    if (p.is0()) throw new Error('bbs proof: identity point');
    p.assertValidity();
    return p;
  };
  const sc = (o: number): bigint => {
    const s = os2ip(bytes.slice(o, o + 32));
    if (s <= 0n || s >= ORDER) throw new Error('bbs proof: scalar out of range');
    return s;
  };
  const aBar = pt(0);
  const bBar = pt(48);
  const d = pt(96);
  const eHat = sc(144);
  const r1Hat = sc(176);
  const r3Hat = sc(208);
  const commitments: bigint[] = [];
  for (let k = 0; k < u; k++) commitments.push(sc(240 + k * 32));
  const challenge = sc(240 + u * 32);
  return { aBar, bBar, d, eHat, r1Hat, r3Hat, commitments, challenge };
}
