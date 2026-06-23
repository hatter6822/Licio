// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.1 — `produceSignedManifest`: the PRODUCING counterpart of
// `verifyUpdateManifest` (PRIVATE_SPEC §1, §3.2, §20.6, §22.4; WS-O.3.2b).  A
// maintainer release process hands this the RUNNING private-mode chunk bytes, a
// maintainer release SIGNER, and an append-only transparency LOG; it:
//
//   1. computes the bundle DIGEST — SHA-256 over the chunk bytes (the same hash
//      the client's `bundle-digest.ts` computes over the served chunk);
//   2. builds the domain-separated LOG LEAF (`"licio-update-v1:" || digest`)
//      and APPENDS it to the append-only log (a new committed leaf);
//   3. produces the RFC 9162 inclusion proof + the log-signed checkpoint for
//      that leaf against the grown tree;
//   4. assembles + maintainer-SIGNS the canonical manifest body (Ed25519).
//
// The output `UpdateManifest` is exactly what the verifier accepts: re-running
// `verifyUpdateManifest` over it (with the running digest + the signer/log
// public keys) returns `{ trusted: true }`.  This module is PURE over injected
// crypto (a `ManifestSigner` carrying the Ed25519 sign closures + base64url
// codec) — no WebCrypto import here, so it builds in any environment and the
// build tool supplies the platform `crypto.subtle` wiring.

import { sha256Concat } from './crypto.js';
import { appendLeaf, proveInclusion, signCheckpoint, type TransparencyLogState } from './log.js';
import {
  canonicalManifestBody,
  type InclusionProof,
  type UpdateManifest,
  type UpdateManifestBody,
} from './schema.js';

/** The domain separator for the transparency-log leaf input (§22.4). */
const LOG_LEAF_DOMAIN = new TextEncoder().encode('licio-update-v1:');

/**
 * The injected signing context.  Both signers produce a DETACHED Ed25519
 * signature over the given message bytes; the maintainer signer's public key is
 * the one a verifier pins, the log signer's public key signs the checkpoint.
 */
export interface ManifestSigner {
  /** The maintainer release key's raw public key, base64url (the verifier's pin). */
  readonly signerPublicKeyB64: string;
  /** Detached Ed25519 signature over `message` by the maintainer release key. */
  readonly signManifest: (message: Uint8Array) => Promise<Uint8Array>;
  /** Detached Ed25519 signature over `message` by the transparency-log key. */
  readonly signCheckpoint: (message: Uint8Array) => Promise<Uint8Array>;
  /** Base64url encoder (unpadded) shared by every byte field. */
  readonly toBase64Url: (bytes: Uint8Array) => string;
}

/** The release metadata the manifest body records. */
export interface ManifestReleaseInfo {
  /** Human-readable release version (e.g. the app `package.json` version). */
  readonly bundleVersion: string;
  /** Monotonic release sequence (anti-rollback floor for the verifier). */
  readonly releaseSequence: number;
  /** The protected artifact's stable id (the private-mode chunk name). */
  readonly artifactId: string;
}

export interface ProduceManifestInput {
  /** The raw bytes of the built private-mode chunk (its SHA-256 is the digest). */
  readonly bundleBytes: Uint8Array;
  /** The append-only transparency log to commit the bundle leaf into. */
  readonly log: TransparencyLogState;
  readonly release: ManifestReleaseInfo;
  readonly signer: ManifestSigner;
}

export interface ProducedManifest {
  /** The signed, log-included manifest the client fetches + verifies. */
  readonly manifest: UpdateManifest;
  /** The GROWN append-only log state (with the new leaf committed). */
  readonly log: TransparencyLogState;
  /** The bundle digest (base64url) — the value the running client must match. */
  readonly bundleDigest: string;
  /** The leaf index the bundle occupies in the log. */
  readonly leafIndex: number;
}

/**
 * Produce a fully-valid signed update manifest for `bundleBytes`, committing its
 * digest into the append-only transparency `log`.  Returns the manifest, the
 * grown log state (which the caller persists back), and the digest/index for
 * bookkeeping.  Deterministic given the inputs + the signer's keys (Ed25519 over
 * WebCrypto is deterministic per RFC 8032).
 */
export async function produceSignedManifest(
  input: ProduceManifestInput,
): Promise<ProducedManifest> {
  const { bundleBytes, signer, release } = input;
  if (bundleBytes.length === 0) throw new Error('cannot attest an empty private-mode bundle');

  // 1. Digest + the domain-separated log leaf input.
  const digest = await sha256Concat(bundleBytes);
  const digestB64 = signer.toBase64Url(digest);
  const logLeafInput = await sha256Concat(LOG_LEAF_DOMAIN, digest);
  const logLeafB64 = signer.toBase64Url(logLeafInput);

  // 2. Append the leaf to the append-only log (a NEW committed leaf).
  const appended = await appendLeaf(input.log, logLeafInput);
  const grown = appended.state;
  const leafIndex = appended.index;

  // 3. Inclusion proof + signed checkpoint against the grown tree.
  const proofHashes = await proveInclusion(grown, leafIndex);
  const checkpoint = await signCheckpoint(grown, signer.signCheckpoint, signer.toBase64Url);
  const inclusionProof: InclusionProof = {
    leaf_index: leafIndex,
    tree_size: checkpoint.tree_size,
    proof_hashes: proofHashes.map((h) => signer.toBase64Url(h)),
  };

  // 4. Build + maintainer-sign the canonical manifest body.
  const body: UpdateManifestBody = {
    manifest_version: 1,
    bundle_version: release.bundleVersion,
    release_sequence: release.releaseSequence,
    artifact_id: release.artifactId,
    bundle_digest: digestB64,
    log_id: grown.logId,
    log_leaf: logLeafB64,
  };
  const signature = await signer.signManifest(canonicalManifestBody(body));

  const manifest: UpdateManifest = {
    body,
    signature: signer.toBase64Url(signature),
    signer_public_key: signer.signerPublicKeyB64,
    inclusion_proof: inclusionProof,
    checkpoint,
  };
  return { manifest, log: grown, bundleDigest: digestB64, leafIndex };
}

export { LOG_LEAF_DOMAIN };
