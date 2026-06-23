// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — BBS per-verifier-linkability PSEUDONYM (the rendezvous-cap nullifier).
//
// A pseudonym binds a per-context value `nym = OP(context)^nid` to a designated
// undisclosed credential message `nid` (the holder's pseudonym secret), where
// `OP(context) = hash_to_curve_g1(context)` is a nothing-up-my-sleeve per-context
// generator. The show proves, in zero knowledge, that the SAME `nid` signed in the
// credential is the discrete log of `nym` w.r.t. `OP` — by reusing the base proof's
// blinding `m~_nid` / response `m^_nid` for the `nid` message and adding the Schnorr
// commitment `U = OP^{m~_nid}` (prover) / `U = OP^{m^_nid} − nym·c` (verifier) to the
// Fiat-Shamir challenge.
//
// Properties (the cap): `nym` is DETERMINISTIC in `(nid, context)` → a refresh in the
// same context reuses one slot; INDEPENDENT across contexts → cross-context unlinkable;
// and UNFORGEABLE — a `nym` not equal to `OP^nid` for the credential's own `nid`, or a
// `nym` for a different `nid`, fails verification.
//
// This extension is layered on the IETF-VECTOR-PINNED base proof (signature.ts/proof.ts);
// the published `draft-irtf-cfrg-bbs-per-verifier-linkability` test vectors are not
// mirrored in the reference repo, so the pseudonym layer is verified by determinism,
// unlinkability, soundness, and round-trip properties (pseudonym.test.ts), NOT IETF
// vectors. See docs/private-p2p/TIER2-RENDEZVOUS-CAP.md §9 (maturity caveat).

import {
  type BbsProof,
  bbsMul,
  genFinalize,
  genInit,
  type Prepared,
  proofChallenge,
  proofFromBytes,
  proofPairingHolds,
  verifyRecompute,
} from './proof.js';
import { type BbsSignature, randomScalar, setup } from './signature.js';
import {
  bls,
  CIPHERSUITE_ID,
  calculateDomain,
  concatBytes,
  createGenerators,
  type G1Point,
  type G2Point,
  g1Bytes,
  messageToScalar,
} from './suite.js';

const NYM_GENERATOR_DST = new TextEncoder().encode(`${CIPHERSUITE_ID}LICIO_NYM_GENERATOR_`);

export interface PseudonymProof {
  /** The base BBS proof octets (the `nid` message is undisclosed within it). */
  readonly proof: Uint8Array;
  /** The per-context pseudonym `nym = OP(context)^nid` (the dedup key / nullifier). */
  readonly pseudonym: G1Point;
}

/** `OP(context)` — the nothing-up-my-sleeve per-context generator in G1. */
export function deriveNymGenerator(context: Uint8Array): G1Point {
  return bls.G1.hashToCurve(context, { DST: NYM_GENERATOR_DST }) as unknown as G1Point;
}

/** `nym = OP(context)^nid`. Deterministic; the Tier-2 dedup key. */
export function computePseudonym(nidSecret: bigint, context: Uint8Array): G1Point {
  return bbsMul(deriveNymGenerator(context), nidSecret);
}

const pseudonymExtra = (op: G1Point, nym: G1Point, u: G1Point): Uint8Array =>
  concatBytes(g1Bytes(op), g1Bytes(nym), g1Bytes(u));

const defaultRandoms = (count: number): bigint[] =>
  Array.from({ length: count }, () => randomScalar());

/**
 * Core pseudonym show over a PREPARED generator set (base interface uses `setup()`; the
 * blind interface, blind.ts, supplies blind generators + scalar messages). Emits a
 * per-`context` pseudonym bound to the undisclosed message at `nidIndex`.
 */
export function proveWithPseudonymPrepared(
  signature: BbsSignature,
  prepared: Prepared,
  nidIndex: number,
  disclosedIndexes: readonly number[],
  context: Uint8Array,
  ph: Uint8Array = new Uint8Array(0),
  randomScalarsOverride?: (count: number) => bigint[],
): PseudonymProof {
  if (nidIndex < 0 || nidIndex >= prepared.msgScalars.length)
    throw new Error('pseudonym: nidIndex out of range');
  if (disclosedIndexes.includes(nidIndex)) throw new Error('pseudonym: nid must stay undisclosed');
  const u = prepared.msgScalars.length - disclosedIndexes.length;
  const rs = (randomScalarsOverride ?? defaultRandoms)(5 + u);
  const init = genInit(signature, prepared, disclosedIndexes, rs);

  const op = deriveNymGenerator(context);
  const nid = init.msgScalars[nidIndex] as bigint;
  const pseudonym = bbsMul(op, nid);
  const pos = init.undisclosed.indexOf(nidIndex);
  const nymTilde = init.mTilde[pos] as bigint;
  const uCommit = bbsMul(op, nymTilde);

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
    pseudonymExtra(op, pseudonym, uCommit),
  );
  return { proof: genFinalize(signature, challenge, rs, init), pseudonym };
}

/**
 * Show a credential anonymously while emitting a per-`context` pseudonym bound to the
 * undisclosed message at `nidIndex`. `disclosedIndexes` MUST NOT include `nidIndex`.
 */
export function proveWithPseudonym(
  pk: G2Point,
  signature: BbsSignature,
  messages: readonly Uint8Array[],
  nidIndex: number,
  disclosedIndexes: readonly number[],
  context: Uint8Array,
  header: Uint8Array = new Uint8Array(0),
  ph: Uint8Array = new Uint8Array(0),
  randomScalarsOverride?: (count: number) => bigint[],
): PseudonymProof {
  return proveWithPseudonymPrepared(
    signature,
    setup(pk, header, messages),
    nidIndex,
    disclosedIndexes,
    context,
    ph,
    randomScalarsOverride,
  );
}

/**
 * Core pseudonym verify over a PREPARED generator set (`{q1, h, domain}`) + disclosed
 * SCALARS. The blind interface supplies blind generators; the base wrapper builds them
 * from `createGenerators`/`messages_to_scalars`.
 */
export function verifyWithPseudonymPrepared(
  pk: G2Point,
  proofBytes: Uint8Array,
  pseudonym: G1Point,
  prepared: { q1: G1Point; h: G1Point[]; domain: bigint },
  disclosedScalars: readonly bigint[],
  disclosedIndexes: readonly number[],
  nidIndex: number,
  context: Uint8Array,
  ph: Uint8Array = new Uint8Array(0),
): boolean {
  if (disclosedIndexes.includes(nidIndex)) return false;
  let proof: BbsProof;
  try {
    proof = proofFromBytes(proofBytes);
    pk.assertValidity();
    pseudonym.assertValidity();
  } catch {
    return false;
  }
  if (pseudonym.is0()) return false; // a degenerate nym (nid ≡ 0) is not a valid identity
  const rec = verifyRecompute(proof, prepared, disclosedScalars, disclosedIndexes);
  if (rec === null) return false;
  const l = disclosedIndexes.length + proof.commitments.length;
  if (nidIndex < 0 || nidIndex >= l) return false;
  const pos = rec.undisclosed.indexOf(nidIndex);
  if (pos < 0) return false;

  const op = deriveNymGenerator(context);
  const mHatNid = proof.commitments[pos] as bigint;
  // U = OP^{m^_nid} − nym·c  (must equal the prover's OP^{m~_nid})
  const uCommit = bbsMul(op, mHatNid).subtract(bbsMul(pseudonym, proof.challenge));
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
    pseudonymExtra(op, pseudonym, uCommit),
  );
  if (challenge !== proof.challenge) return false;
  return proofPairingHolds(proof, pk);
}

/** Verify a pseudonym-bound show: the base proof holds AND `pseudonym = OP^nid` for the
 *  credential's own undisclosed `nid`. Builds the base generator set from `createGenerators`. */
export function verifyWithPseudonym(
  pk: G2Point,
  proofBytes: Uint8Array,
  pseudonym: G1Point,
  disclosedMessages: readonly Uint8Array[],
  disclosedIndexes: readonly number[],
  nidIndex: number,
  context: Uint8Array,
  header: Uint8Array = new Uint8Array(0),
  ph: Uint8Array = new Uint8Array(0),
): boolean {
  let proof: BbsProof;
  try {
    proof = proofFromBytes(proofBytes);
  } catch {
    return false;
  }
  if (disclosedMessages.length !== disclosedIndexes.length) return false;
  const l = disclosedIndexes.length + proof.commitments.length;
  const gens = createGenerators(l + 1);
  const q1 = gens[0];
  if (q1 === undefined) return false;
  const h = gens.slice(1);
  let domain: bigint;
  try {
    pk.assertValidity();
    domain = calculateDomain(pk, q1, h, header);
  } catch {
    return false;
  }
  const disclosedScalars = disclosedMessages.map(messageToScalar);
  return verifyWithPseudonymPrepared(
    pk,
    proofBytes,
    pseudonym,
    { q1, h, domain },
    disclosedScalars,
    disclosedIndexes,
    nidIndex,
    context,
    ph,
  );
}
