// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the rendezvous-cap CREDENTIAL layer (PRIVATE_SPEC Tier-2,
// docs/private-p2p/TIER2-RENDEZVOUS-CAP.md). A thin application wrapper over the BBS
// primitives (crypto/bbs/*) realizing "1 presence slot per device per (epoch, bucket)"
// without the rendezvous server learning any device/room identity.
//
// Flow (BLIND issuance — the issuer never learns `nid`):
//   1. createCredentialRequest(nid)         → device commits its secret `nid` (+ keeps s').
//   2. issueCredential(issuer, request, e)  → the per-epoch admin blind-signs it.
//   3. proveRendezvousPresence(...)         → device emits a ZK show + a per-context
//                                             pseudonym (the dedup key / nullifier).
//   4. verifyRendezvousPresence(...)        → server verifies vs the per-epoch issuer key
//                                             and keys the slot by the pseudonym.
//
// The server only ever sees the proof + the pseudonym (a discrete-log image of a secret it
// never holds), so server-blindness (§15.3.1) holds and the cap learns only a per-epoch
// pseudonym. The whole cap FAILS OPEN to the Tier-1 sample-poll (the plumbing layer).

import {
  blindCommit,
  blindSign,
  credentialLayout,
  credentialScalars,
  verifyBlindCredential,
} from '../crypto/bbs/blind.js';
import {
  proveWithPseudonymPrepared,
  verifyWithPseudonymPrepared,
} from '../crypto/bbs/pseudonym.js';
import { type BbsKeyPair, bbsKeyGen, signatureFromBytes } from '../crypto/bbs/signature.js';
import {
  concatBytes,
  G1,
  type G1Point,
  G2,
  type G2Point,
  hashToScalar,
  i2osp,
  messageToScalar,
} from '../crypto/bbs/suite.js';
import { randomBytes } from '../crypto/runtime.js';
import { RENDEZVOUS_DEFAULT_BUCKET_MS } from '../sync/rendezvous.js';

/** The fixed index of `nid` in the one-committed-message rendezvous credential. */
const NID_INDEX = 0;
/** Sentinel bucket selecting the `per-epoch` granularity (no per-bucket rotation). */
export const PER_EPOCH_BUCKET = -1;

/**
 * The cap time-bucket width — the SSOT for the announcer, the server verifier, and the client
 * poll-filter. ALL THREE must agree, or a valid announce lands out-of-window. It is PINNED to
 * the §15.3.2 rendezvous discovery bucket (`RENDEZVOUS_DEFAULT_BUCKET_MS`) BY CONSTRUCTION,
 * because the carrier derives the cap bucket AND the `room_blind_id` bucket from the same
 * `rendezvousTimeBucket(now)` — so the cap bucket IS the discovery bucket, not a second clock.
 * (`apps/api`'s `DEFAULT_RENDEZVOUS_CONFIG.bucketWidthMs` mirrors this value.)
 */
export const DEFAULT_BUCKET_WIDTH_MS = RENDEZVOUS_DEFAULT_BUCKET_MS;

/** The current time bucket index for `nowMs` (a per-bucket pseudonym rotates with it). */
export function currentBucket(nowMs: number, widthMs: number = DEFAULT_BUCKET_WIDTH_MS): number {
  return Math.floor(nowMs / widthMs);
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const lenPrefixed = (b: Uint8Array): Uint8Array => concatBytes(i2osp(b.length, 8), b);

/** A device's long-lived pseudonym secret (`nid`): 32 fresh random bytes. */
export function generateNidSecret(): Uint8Array {
  return randomBytes(32);
}

/** Generate a per-epoch issuer key pair (the committing admin's BBS keys for one epoch). */
export function generateIssuerKeyPair(): BbsKeyPair {
  return bbsKeyGen();
}

/** Generate a long-lived issuer SEED (32 bytes). The admin persists ONE seed device-locally;
 *  the per-epoch issuer key derives from it, so its public key is STABLE across reloads (and
 *  across re-issuances within an epoch) without storing a key per epoch. */
export function generateIssuerSeed(): Uint8Array {
  return randomBytes(32);
}

const ISSUER_DERIVE_PREFIX = new TextEncoder().encode('licio.tier2.rendezvous.issuer.v1');

/** Derive the per-epoch BBS issuer key pair deterministically from a stable seed + epoch. */
export function deriveIssuerKeyPair(seed: Uint8Array, epoch: Uint8Array): BbsKeyPair {
  const sk = hashToScalar(concatBytes(ISSUER_DERIVE_PREFIX, lenPrefixed(seed), lenPrefixed(epoch)));
  return { sk, pk: G2.BASE.multiply(sk) };
}

/** Bind the epoch into the BBS header so a credential is valid for exactly one epoch. */
function epochHeader(epoch: Uint8Array): Uint8Array {
  return concatBytes(enc('licio.tier2.rendezvous.epoch.v1'), lenPrefixed(epoch));
}

/**
 * The per-announce context the pseudonym is derived against. `per-bucket` (default,
 * `bucket >= 0`) rotates the pseudonym every time bucket → cross-bucket unlinkable;
 * `PER_EPOCH_BUCKET` omits the bucket → one stable pseudonym per epoch (the stronger cap,
 * within-epoch linkable). See the spec §6.7 granularity policy.
 */
export function rendezvousContext(
  roomBlindId: Uint8Array,
  epoch: Uint8Array,
  bucket: number,
): Uint8Array {
  return concatBytes(
    enc('licio.tier2.rendezvous.ctx.v1'),
    lenPrefixed(roomBlindId),
    lenPrefixed(epoch),
    bucket === PER_EPOCH_BUCKET
      ? concatBytes(Uint8Array.of(0xff), i2osp(0, 8))
      : concatBytes(Uint8Array.of(0x00), i2osp(bucket, 8)),
  );
}

/** A device's per-epoch credential + the secrets needed to show it. */
export interface RendezvousCredential {
  /** The 80-byte blind-issued BBS signature. */
  readonly credential: Uint8Array;
  /** The device's long-lived `nid` secret (octets). */
  readonly nidSecret: Uint8Array;
  /** The per-issuance blinding factor `s'` (kept secret; needed to show). */
  readonly secretProverBlind: bigint;
}

/** A device's request to be issued a credential (the blind commitment to send the admin). */
export interface CredentialRequest {
  /** The opaque commitment-with-proof the admin blind-signs (reveals no `nid`). */
  readonly commitmentWithProof: Uint8Array;
  /** The blinding factor `s'` the device retains. */
  readonly secretProverBlind: bigint;
}

/** Device, step 1: commit `nid` (the admin will never see it). */
export function createCredentialRequest(nidSecret: Uint8Array): CredentialRequest {
  const { commitmentWithProof, secretProverBlind } = blindCommit([messageToScalar(nidSecret)]);
  return { commitmentWithProof, secretProverBlind };
}

/** Admin, step 2: blind-sign the request for `epoch`. Never learns `nid`. */
export function issueCredential(
  issuer: BbsKeyPair,
  request: CredentialRequest,
  epoch: Uint8Array,
): Uint8Array {
  return issueCredentialForCommitment(issuer, request.commitmentWithProof, epoch);
}

/**
 * Admin, step 2 (op flow): blind-sign a device's PUBLISHED commitment for `epoch`. The
 * admin holds only the commitment (from the converged `rendezvous.request` state), never the
 * device's `secret_prover_blind` — exactly what blind issuance needs.
 */
export function issueCredentialForCommitment(
  issuer: BbsKeyPair,
  commitmentWithProof: Uint8Array,
  epoch: Uint8Array,
): Uint8Array {
  return blindSign(issuer, commitmentWithProof, 1, [], epochHeader(epoch));
}

/** Assemble the device-held credential from its request + the admin's signature. */
export function assembleCredential(
  nidSecret: Uint8Array,
  request: CredentialRequest,
  signature: Uint8Array,
): RendezvousCredential {
  return { credential: signature, nidSecret, secretProverBlind: request.secretProverBlind };
}

/**
 * Verify a device's OWN blind-issued credential against the per-epoch issuer key BEFORE
 * relying on it. Catches a credential issued for a STALE commitment (e.g. the device rotated
 * its `nid` and the op log still carries an issuance for the old commitment) or any
 * corrupt/mismatched issuance — so the device stays on Tier-1 instead of building shows that
 * silently fail at peers. Composition-anchored: this is the vetted base `bbsVerifyScalars`.
 */
export function verifyRendezvousCredential(
  issuerPk: G2Point,
  signature: Uint8Array,
  nidSecret: Uint8Array,
  secretProverBlind: bigint,
  epoch: Uint8Array,
): boolean {
  try {
    return verifyBlindCredential(
      issuerPk,
      signature,
      [],
      [messageToScalar(nidSecret)],
      secretProverBlind,
      epochHeader(epoch),
    );
  } catch {
    return false;
  }
}

/** A device's presence announcement: the ZK show + the pseudonym (dedup key). */
export interface RendezvousPresence {
  readonly proof: Uint8Array;
  readonly pseudonym: G1Point;
}

/** Device, step 3: prove presence for `(epoch, context)`, emitting the pseudonym. */
export function proveRendezvousPresence(
  issuerPk: BbsKeyPair['pk'],
  cred: RendezvousCredential,
  epoch: Uint8Array,
  context: Uint8Array,
): RendezvousPresence {
  const layout = credentialLayout(issuerPk, 1, [], epochHeader(epoch));
  const msgScalars = credentialScalars(
    [],
    [messageToScalar(cred.nidSecret)],
    cred.secretProverBlind,
  );
  return proveWithPseudonymPrepared(
    signatureFromBytes(cred.credential),
    { q1: layout.q1, h: layout.msgGens, domain: layout.domain, msgScalars },
    NID_INDEX,
    [],
    context,
  );
}

/** Server, step 4: verify a presence show against the per-epoch issuer key. */
export function verifyRendezvousPresence(
  issuerPk: BbsKeyPair['pk'],
  proof: Uint8Array,
  pseudonym: G1Point,
  epoch: Uint8Array,
  context: Uint8Array,
): boolean {
  const layout = credentialLayout(issuerPk, 1, [], epochHeader(epoch));
  return verifyWithPseudonymPrepared(
    issuerPk,
    proof,
    pseudonym,
    { q1: layout.q1, h: layout.msgGens, domain: layout.domain },
    [],
    [],
    NID_INDEX,
    context,
  );
}

/** The 48-byte wire encoding of a pseudonym (the dedup key the server stores). */
export function pseudonymToBytes(nym: G1Point): Uint8Array {
  return nym.toBytes();
}

/** Parse a 48-byte pseudonym; throws on a malformed/identity encoding. */
export function pseudonymFromBytes(bytes: Uint8Array): G1Point {
  const p = G1.fromBytes(bytes);
  if (p.is0()) throw new Error('rendezvous-cap: identity pseudonym');
  p.assertValidity();
  return p;
}

/** The 96-byte wire encoding of a per-epoch issuer public key (BBS G2). */
export function issuerKeyToBytes(pk: G2Point): Uint8Array {
  return pk.toBytes();
}

/** Parse a 96-byte issuer public key; throws on a malformed/identity encoding. */
export function issuerKeyFromBytes(bytes: Uint8Array): G2Point {
  const pk = G2.fromBytes(bytes);
  if (pk.is0()) throw new Error('rendezvous-cap: identity issuer key');
  pk.assertValidity();
  return pk;
}

export type { G2Point };
