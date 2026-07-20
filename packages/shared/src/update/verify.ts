// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2a — `verifyUpdateManifest` + `decideUpdateActivation`: the PURE,
// fail-closed code-transparency verifier that decides whether the running
// private-mode bundle is trustworthy (PRIVATE_SPEC §20.6, §22.4; WS-O.3.2b/3.2e).
//
// The activation contract (the verify-BEFORE-unlock rule, §20.6): private rooms
// activate ONLY if the manifest is
//
//   * SIGNED by a trusted maintainer release key (Ed25519),
//   * over a body whose `bundle_digest` equals the SHA-256 of the RUNNING bundle
//     bytes (no substitution),
//   * present in the APPEND-ONLY transparency log — proven by an RFC 9162
//     inclusion proof against a checkpoint that the log's key SIGNED, and
//   * not STALE (its release sequence is not below the last-trusted sequence,
//     anti-rollback).
//
// Anything else — an unsigned manifest, an untrusted signer, a digest mismatch,
// a checkpoint with a bad signature, an inclusion proof that does not
// reconstruct the signed root, a missing/short proof, an older release, or ANY
// read/parse/crypto failure — yields a typed UNTRUSTED verdict that locks the
// rooms.  There is no soft pass and no "unknown ⇒ allow" branch.

import { ED25519_PUBLIC_KEY_LENGTH, fromBase64Url, sha256Concat, verifyEd25519 } from './crypto.js';
import { bytesEqual, leafHash, verifyInclusion } from './merkle.js';
import {
  canonicalCheckpointBody,
  canonicalManifestBody,
  type UpdateManifest,
  updateManifestSchema,
} from './schema.js';

/** Domain separator for the transparency-log leaf input (§22.4). */
const LOG_LEAF_DOMAIN = new TextEncoder().encode('licio-update-v1:');

/** The typed reasons a bundle is NOT trusted (consumed verbatim by the UI). */
export type UpdateUntrustedReason =
  | 'malformed_manifest' // the manifest failed strict schema validation / decode
  | 'signature_invalid' // signer not trusted, or the maintainer signature failed
  | 'digest_mismatch' // the running bundle's hash != the manifest digest
  | 'not_in_transparency_log' // inclusion proof / checkpoint signature failed
  | 'artifact_mismatch' // the signed body attests a different artifact than expected
  | 'stale'; // the release sequence is below the last-trusted sequence

/** The verifier's verdict: a trusted bundle, or an untrusted one with a reason. */
export type TrustedBundleVerdict =
  | { readonly trusted: true; readonly releaseSequence: number; readonly bundleVersion: string }
  | { readonly trusted: false; readonly reason: UpdateUntrustedReason };

/** The activation decision the client acts on. */
export type UpdateActivationDecision =
  | {
      readonly action: 'activate';
      readonly releaseSequence: number;
      readonly bundleVersion: string;
    }
  | { readonly action: 'lock-rooms'; readonly reason: UpdateUntrustedReason };

/** Inputs to the verifier (all provided by the trusted, already-running app). */
export interface VerifyUpdateManifestInput {
  /** The raw manifest object (typically parsed from a fetched JSON document). */
  readonly manifest: unknown;
  /** The stable id of the artifact this client expects the manifest to attest
   *  (the private-mode chunk name).  The signed body's `artifact_id` must equal
   *  it — a valid signature over the WRONG artifact is not a match for THIS
   *  bundle, so it is rejected before any digest/log work. */
  readonly expectedArtifactId: string;
  /** The SHA-256 digest of the RUNNING private-mode bundle bytes, base64url.
   *  The caller hashes the actual loaded chunk and passes the result; the
   *  verifier never trusts a digest the manifest asserts about itself. */
  readonly runningBundleDigest: string;
  /** Raw Ed25519 public keys (base64url) of the maintainers whose signature on
   *  the manifest body is accepted.  Post-incident key rotation = passing a
   *  ROTATED signer set (a superset / replacement); the manifest's
   *  `signer_public_key` must be a member. */
  readonly trustedSignerPublicKeys: readonly string[];
  /** Raw Ed25519 public key (base64url) of the transparency log whose checkpoint
   *  signature is accepted (the log's signed tree head). */
  readonly logPublicKey: string;
  /** The highest release sequence this client has previously TRUSTED (anti-
   *  rollback).  Omit / `undefined` on first run (no floor). */
  readonly lastTrustedSequence?: number;
}

/** Decode the bundle digest, comparing the manifest's claim to the running hash. */
function digestsMatch(manifestDigestB64: string, runningDigestB64: string): boolean {
  let a: Uint8Array;
  let b: Uint8Array;
  try {
    a = fromBase64Url(manifestDigestB64);
    b = fromBase64Url(runningDigestB64);
  } catch {
    return false;
  }
  if (a.length === 0 || a.length !== b.length) return false;
  return bytesEqual(a, b);
}

/**
 * Verify a signed update manifest against the running bundle, the trusted signer
 * set, and the transparency log.  Pure + deterministic + fail-closed: every
 * failure path returns an explicit untrusted reason; only an end-to-end pass
 * returns `{ trusted: true }`.
 */
export async function verifyUpdateManifest(
  input: VerifyUpdateManifestInput,
): Promise<TrustedBundleVerdict> {
  // 1. Strict schema validation — an unknown/missing/extra field is malformed.
  const parsed = updateManifestSchema.safeParse(input.manifest);
  if (!parsed.success) return { trusted: false, reason: 'malformed_manifest' };
  const manifest: UpdateManifest = parsed.data;

  // 1b. Artifact binding: the signed body must attest the artifact this client
  //     expects.  A valid signature over a DIFFERENT artifact_id is honest but
  //     not about THIS bundle — reject with a distinct reason.  The subsequent
  //     signature check still proves the signer attested this exact artifact_id.
  if (manifest.body.artifact_id !== input.expectedArtifactId) {
    return { trusted: false, reason: 'artifact_mismatch' };
  }

  // 2. Decode every byte field once; any decode failure ⇒ malformed.
  let signerKey: Uint8Array;
  let signature: Uint8Array;
  let merkleRoot: Uint8Array;
  let checkpointSig: Uint8Array;
  let logLeaf: Uint8Array;
  let proofHashes: Uint8Array[];
  let logPubKey: Uint8Array;
  const trustedSigners: Uint8Array[] = [];
  try {
    signerKey = fromBase64Url(manifest.signer_public_key);
    signature = fromBase64Url(manifest.signature);
    merkleRoot = fromBase64Url(manifest.checkpoint.merkle_root);
    checkpointSig = fromBase64Url(manifest.checkpoint.signature);
    logLeaf = fromBase64Url(manifest.body.log_leaf);
    proofHashes = manifest.inclusion_proof.proof_hashes.map(fromBase64Url);
    logPubKey = fromBase64Url(input.logPublicKey);
    for (const k of input.trustedSignerPublicKeys) trustedSigners.push(fromBase64Url(k));
  } catch {
    return { trusted: false, reason: 'malformed_manifest' };
  }
  if (signerKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    return { trusted: false, reason: 'malformed_manifest' };
  }

  // 3. Signer trust + maintainer signature.  The signer key must be in the
  //    (possibly rotated) trusted set AND the signature must verify over the
  //    canonical body.  A trusted-set miss and a bad signature both ⇒ invalid.
  const signerTrusted = trustedSigners.some(
    (k) => k.length === signerKey.length && bytesEqual(k, signerKey),
  );
  if (!signerTrusted) return { trusted: false, reason: 'signature_invalid' };
  const bodyBytes = canonicalManifestBody(manifest.body);
  if (!(await verifyEd25519(signerKey, bodyBytes, signature))) {
    return { trusted: false, reason: 'signature_invalid' };
  }

  // 4. Digest binding: the manifest digest must equal the RUNNING bundle hash,
  //    and the running hash the caller passed must match the manifest field too.
  if (!digestsMatch(manifest.body.bundle_digest, input.runningBundleDigest)) {
    return { trusted: false, reason: 'digest_mismatch' };
  }

  // 5. The log leaf must be the domain-separated commitment of THIS digest, so a
  //    proof for an unrelated leaf cannot be reused for this bundle.
  let bundleDigestBytes: Uint8Array;
  try {
    bundleDigestBytes = fromBase64Url(manifest.body.bundle_digest);
  } catch {
    return { trusted: false, reason: 'malformed_manifest' };
  }
  const expectedLeaf = await sha256Concat(LOG_LEAF_DOMAIN, bundleDigestBytes);
  if (!bytesEqual(expectedLeaf, logLeaf)) {
    return { trusted: false, reason: 'not_in_transparency_log' };
  }

  // 6. Transparency-log membership.  The proof's tree size must match the
  //    checkpoint, the checkpoint must be signed by the log key, its log_id must
  //    match the body's, and the inclusion proof must reconstruct the signed
  //    Merkle root.  Any failure ⇒ not in the transparency log.
  if (manifest.inclusion_proof.tree_size !== manifest.checkpoint.tree_size) {
    return { trusted: false, reason: 'not_in_transparency_log' };
  }
  if (manifest.body.log_id !== manifest.checkpoint.log_id) {
    return { trusted: false, reason: 'not_in_transparency_log' };
  }
  const checkpointBytes = canonicalCheckpointBody(manifest.checkpoint);
  if (!(await verifyEd25519(logPubKey, checkpointBytes, checkpointSig))) {
    return { trusted: false, reason: 'not_in_transparency_log' };
  }
  const leaf = await leafHash(logLeaf);
  const included = await verifyInclusion(
    leaf,
    manifest.inclusion_proof.leaf_index,
    manifest.inclusion_proof.tree_size,
    proofHashes,
    merkleRoot,
  );
  if (!included) return { trusted: false, reason: 'not_in_transparency_log' };

  // 7. Anti-rollback: a manifest older than the last trusted release is stale.
  if (
    input.lastTrustedSequence !== undefined &&
    manifest.body.release_sequence < input.lastTrustedSequence
  ) {
    return { trusted: false, reason: 'stale' };
  }

  return {
    trusted: true,
    releaseSequence: manifest.body.release_sequence,
    bundleVersion: manifest.body.bundle_version,
  };
}

/**
 * Map a verifier verdict to the activation decision (PURE, deterministic).  This
 * is the single chokepoint the SW-pinning + room-lock glue consults: `activate`
 * only on a fully-trusted bundle; `lock-rooms` (with the typed reason) on every
 * untrusted verdict.
 */
export function decideUpdateActivation(verdict: TrustedBundleVerdict): UpdateActivationDecision {
  if (verdict.trusted) {
    return {
      action: 'activate',
      releaseSequence: verdict.releaseSequence,
      bundleVersion: verdict.bundleVersion,
    };
  }
  return { action: 'lock-rooms', reason: verdict.reason };
}
