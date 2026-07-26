// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — BLIND BBS issuance (the admin-unlinkability upgrade).
//
// Goal: an issuer signs a credential over a holder's hidden message(s) `nid` WITHOUT
// learning `nid`. Shape (per `draft-irtf-cfrg-bbs-blind-signatures`, adapted to compose
// with our IETF-VECTOR-PINNED base):
//
//   1. Holder COMMITs: C = Σ J_i·msg_i + Q2·s'  (a Pedersen commitment over independent
//      blind-seed generators) + a Schnorr proof of knowledge of (msg_i, s'). The blinding
//      `s'` keeps the issuer (and anyone seeing C) from recovering the messages.
//   2. Issuer BLIND-SIGNs: after verifying the PoK, it forms `B` in our base's own form
//      `B = P1 + Q1·domain + Σ H_i·known_i + C` and signs `A = B·1/(SK+e)`. It NEVER sees
//      the committed scalars or `s'`.
//   3. The result `(A, e)` is a base BBS signature over the scalar vector
//      `[known…, committed…, s']` with message-generators `[H…, J…, Q2]`, so it VERIFIES
//      under the vetted `bbsVerifyScalars` (the composition anchor) and is shown via the
//      vetted `proveWithPseudonymPrepared`.
//
// No published blind test vectors exist yet (the draft's are "TBD"), so this layer is
// verified by: the commit-PoK round-trip + soundness, the finalized signature verifying
// under the vetted base, the full issue→show→verify round-trip, and structural blindness
// (blindSign's input is the commitment, never the messages). See
// docs/private-p2p/TIER2-RENDEZVOUS-CAP.md §6.2/§9.

import { bbsMul } from './proof.js';
import {
  type BbsKeyPair,
  type BbsSignature,
  bbsVerifyScalars,
  randomScalar,
  signatureToBytes,
} from './signature.js';
import {
  CIPHERSUITE_ID,
  calculateDomain,
  concatBytes,
  createGenerators,
  DST_H2S,
  G1,
  type G1Point,
  type G2Point,
  g1Bytes,
  hashToScalar,
  i2osp,
  interfaceDsts,
  invScalar,
  messageToScalar,
  mod,
  OCTET_POINT_LENGTH,
  OCTET_SCALAR_LENGTH,
  ORDER,
  os2ip,
  P1,
  SIGNATURE_LENGTH,
  scalarBytes,
} from './suite.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** Independent NUMS generators for committed messages + the blind factor (distinct from
 *  the base `H` generators, so a committed message can never collide with a known one). */
const BLIND_GEN_DSTS = interfaceDsts(`${CIPHERSUITE_ID}LICIO_BLIND_COMMIT_`);
const COMMIT_POK_DST = enc(`${CIPHERSUITE_ID}LICIO_BLIND_COMMIT_POK_`);

/** Blind generators for `m` committed messages: returns `(J_1…J_m)` + the blind generator `Q2`. */
export function blindGenerators(m: number): { js: G1Point[]; q2: G1Point } {
  const g = createGenerators(m + 1, BLIND_GEN_DSTS);
  return { js: g.slice(0, m), q2: g[m] as G1Point };
}

function commitChallenge(c: G1Point, cBar: G1Point, js: readonly G1Point[], q2: G1Point): bigint {
  const parts: Uint8Array[] = [i2osp(js.length, 8)];
  for (const j of js) parts.push(g1Bytes(j));
  parts.push(g1Bytes(q2), g1Bytes(c), g1Bytes(cBar));
  return hashToScalar(concatBytes(...parts), COMMIT_POK_DST);
}

export interface BlindCommitment {
  /** The serialized commitment + Schnorr proof to send to the issuer (opaque to it). */
  readonly commitmentWithProof: Uint8Array;
  /** The blinding factor `s'` — the holder keeps it secret; needed to show the credential. */
  readonly secretProverBlind: bigint;
}

/** Holder: commit to `committedScalars` (hidden) + prove knowledge of the opening. */
export function blindCommit(committedScalars: readonly bigint[]): BlindCommitment {
  const m = committedScalars.length;
  const { js, q2 } = blindGenerators(m);
  const sPrime = randomScalar();
  let c = bbsMul(q2, sPrime);
  for (let i = 0; i < m; i++) c = c.add(bbsMul(js[i] as G1Point, committedScalars[i] as bigint));
  // Schnorr PoK of (committedScalars…, s')
  const rMsgs = committedScalars.map(() => randomScalar());
  const rS = randomScalar();
  let cBar = bbsMul(q2, rS);
  for (let i = 0; i < m; i++) cBar = cBar.add(bbsMul(js[i] as G1Point, rMsgs[i] as bigint));
  const ch = commitChallenge(c, cBar, js, q2);
  const zMsgs = committedScalars.map((msg, i) => mod((rMsgs[i] as bigint) + msg * ch));
  const zS = mod(rS + sPrime * ch);
  return { commitmentWithProof: serializeCommit(c, ch, zMsgs, zS), secretProverBlind: sPrime };
}

interface ParsedCommit {
  c: G1Point;
  ch: bigint;
  zMsgs: bigint[];
  zS: bigint;
}

function serializeCommit(c: G1Point, ch: bigint, zMsgs: readonly bigint[], zS: bigint): Uint8Array {
  return concatBytes(g1Bytes(c), scalarBytes(ch), ...zMsgs.map(scalarBytes), scalarBytes(zS));
}

/** Parse + structurally validate a commitment-with-proof for `m` committed messages. */
function deserializeCommit(bytes: Uint8Array, m: number): ParsedCommit {
  if (bytes.length !== OCTET_POINT_LENGTH + OCTET_SCALAR_LENGTH * (m + 2))
    throw new Error('blind: malformed commitment length');
  const c = G1.fromBytes(bytes.slice(0, OCTET_POINT_LENGTH));
  if (c.is0()) throw new Error('blind: identity commitment');
  c.assertValidity();
  const sc = (o: number): bigint => {
    const s = os2ip(bytes.slice(o, o + OCTET_SCALAR_LENGTH));
    if (s <= 0n || s >= ORDER) throw new Error('blind: scalar out of range');
    return s;
  };
  const ch = sc(OCTET_POINT_LENGTH);
  // Past `c || ch`.  Spelled from the two wire widths rather than as `80`, so
  // the length check above and these field offsets can never describe different
  // layouts — that disagreement would not throw, it would parse the next
  // field's bytes as a scalar.  Deliberately NOT `SIGNATURE_LENGTH`, which is
  // the same number for an unrelated reason.
  const zBase = OCTET_POINT_LENGTH + OCTET_SCALAR_LENGTH;
  const zMsgs: bigint[] = [];
  for (let i = 0; i < m; i++) zMsgs.push(sc(zBase + i * OCTET_SCALAR_LENGTH));
  const zS = sc(zBase + m * OCTET_SCALAR_LENGTH);
  return { c, ch, zMsgs, zS };
}

/** Issuer: verify the holder's commitment proof of knowledge (call before signing). */
export function verifyCommitment(commitmentWithProof: Uint8Array, m: number): boolean {
  let parsed: ParsedCommit;
  try {
    parsed = deserializeCommit(commitmentWithProof, m);
  } catch {
    return false;
  }
  const { c, ch, zMsgs, zS } = parsed;
  const { js, q2 } = blindGenerators(m);
  // Cbar' = Σ J_i·z_i + Q2·zS − C·ch
  let cBar = bbsMul(q2, zS);
  for (let i = 0; i < m; i++) cBar = cBar.add(bbsMul(js[i] as G1Point, zMsgs[i] as bigint));
  cBar = cBar.subtract(bbsMul(c, ch));
  return commitChallenge(c, cBar, js, q2) === ch;
}

/**
 * Issuer: produce a BLIND BBS signature. Validates the commitment PoK, then signs
 * `B = P1 + Q1·domain + Σ H_i·known_i + C`. NEVER receives the committed scalars or `s'`.
 * Returns the 80-byte base signature octets.
 */
export function blindSign(
  issuer: BbsKeyPair,
  commitmentWithProof: Uint8Array,
  committedCount: number,
  knownMessages: readonly Uint8Array[] = [],
  header: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (!verifyCommitment(commitmentWithProof, committedCount)) {
    throw new Error('blind: invalid commitment proof');
  }
  const { c } = deserializeCommit(commitmentWithProof, committedCount);
  const layout = credentialLayout(issuer.pk, committedCount, knownMessages, header);
  const knownScalars = knownMessages.map(messageToScalar);
  let b = P1.add(bbsMul(layout.q1, layout.domain));
  for (let i = 0; i < knownScalars.length; i++) {
    b = b.add(bbsMul(layout.knownH[i] as G1Point, knownScalars[i] as bigint));
  }
  b = b.add(c); // C absorbs Σ J_i·committed_i + Q2·s' (hidden from the issuer)
  const e = hashToScalar(
    concatBytes(scalarBytes(issuer.sk), g1Bytes(b), scalarBytes(layout.domain)),
    DST_H2S,
  );
  const a = bbsMul(b, invScalar(mod(issuer.sk + e)));
  if (a.is0()) throw new Error('blind: A is identity');
  return signatureToBytes({ a, e });
}

export interface CredentialLayout {
  /** `Q_1` (base). */
  q1: G1Point;
  /** Known-message generators `H_1…H_L` (base). */
  knownH: G1Point[];
  /** Committed-message generators `J_1…J_M` (blind). */
  js: G1Point[];
  /** The blind-factor generator `Q2`. */
  q2: G1Point;
  /** The full message-generator vector `[H…, J…, Q2]` (for the signed scalar vector). */
  msgGens: G1Point[];
  /** `calculate_domain(pk, Q1, msgGens, header)`. */
  domain: bigint;
}

/** The deterministic generator/domain layout both issuer + holder + verifier reconstruct. */
export function credentialLayout(
  pk: G2Point,
  committedCount: number,
  knownMessages: readonly Uint8Array[],
  header: Uint8Array,
): CredentialLayout {
  const l = knownMessages.length;
  const baseGens = createGenerators(l + 1);
  const q1 = baseGens[0] as G1Point;
  const knownH = baseGens.slice(1);
  const { js, q2 } = blindGenerators(committedCount);
  const msgGens = [...knownH, ...js, q2];
  const domain = calculateDomain(pk, q1, msgGens, header);
  return { q1, knownH, js, q2, msgGens, domain };
}

/**
 * Holder: assemble the message-scalar vector `[known…, committed…, s']` the credential was
 * signed over, for use with the vetted show (`proveWithPseudonymPrepared`) / verify
 * (`bbsVerifyScalars`). The committed scalars + `s'` are the holder's secrets.
 */
export function credentialScalars(
  knownMessages: readonly Uint8Array[],
  committedScalars: readonly bigint[],
  secretProverBlind: bigint,
): bigint[] {
  return [...knownMessages.map(messageToScalar), ...committedScalars, mod(secretProverBlind)];
}

/** Convenience: verify a blind-issued credential under the vetted base (composition anchor). */
export function verifyBlindCredential(
  pk: G2Point,
  signatureBytes: Uint8Array,
  knownMessages: readonly Uint8Array[],
  committedScalars: readonly bigint[],
  secretProverBlind: bigint,
  header: Uint8Array,
): boolean {
  const layout = credentialLayout(pk, committedScalars.length, knownMessages, header);
  const sig: BbsSignature = {
    a: G1.fromBytes(signatureBytes.slice(0, OCTET_POINT_LENGTH)),
    e: os2ip(signatureBytes.slice(OCTET_POINT_LENGTH, SIGNATURE_LENGTH)),
  };
  const scalars = credentialScalars(knownMessages, committedScalars, secretProverBlind);
  return bbsVerifyScalars(pk, sig, layout.q1, layout.msgGens, scalars, header);
}
