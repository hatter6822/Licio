// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.1 / WS-S.10.2a — the signed update-manifest schema (PRIVATE_SPEC §1,
// §3.2, §20.6; WS-O.3.2b transparency log).  A maintainer release process
// produces, for the reproducible private-mode bundle (the lazily code-split
// `private-p2p` chunk, WS-S.2.1):
//
//   1. the bundle DIGEST — SHA-256 over the built chunk bytes (the artifact the
//      transparency log and SW pinning attest);
//   2. a VERSION + monotonically increasing release sequence (anti-rollback);
//   3. a detached SIGNATURE over the canonical manifest body by a maintainer
//      release key (Ed25519, matching the WS-S signing suite);
//   4. a TRANSPARENCY-LOG inclusion-proof reference — the RFC 9162 §2.1.3 path
//      placing the bundle digest's log-leaf in the maintainers' append-only
//      code-transparency log (WS-O.3.2b), against a SIGNED log checkpoint.
//
// All fields are base64url-encoded byte strings (the wire form); the verifier
// (`verifyUpdateManifest`) decodes + validates them.  The schema is STRICT
// (`.strict()`): an unknown field is a hard parse failure (fail-closed — a
// tampered manifest with an extra "trusted: true" field cannot slip past).

import { z } from 'zod';

/** A required, non-empty base64url byte string (digest / signature / key / hash). */
const base64UrlBytes = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'must be base64url');

/**
 * The signed transparency-log checkpoint a manifest's inclusion proof verifies
 * against: a tree size + Merkle root + a detached maintainer signature over
 * `(logId, treeSize, merkleRoot)`.  This is the WS-O.3.2b append-only log's
 * signed tree head (RFC 9162 §4.5).
 */
export const transparencyCheckpointSchema = z
  .object({
    /** Stable identifier of the code-transparency log (domain-separates roots). */
    log_id: z.string().min(1).max(256),
    /** Number of leaves in the log at this checkpoint (RFC 9162 tree size). */
    tree_size: z.number().int().nonnegative(),
    /** The Merkle tree root at `tree_size` (base64url SHA-256, 32 bytes decoded). */
    merkle_root: base64UrlBytes,
    /** Detached signature over the canonical checkpoint body by the log's key. */
    signature: base64UrlBytes,
  })
  .strict();
export type TransparencyCheckpoint = z.infer<typeof transparencyCheckpointSchema>;

/**
 * The inclusion proof placing the bundle-digest leaf in the log (RFC 9162
 * §2.1.3): the leaf index, the tree size it was proven against (MUST equal the
 * checkpoint's), and the audit path (sibling hashes, closest-first).
 */
export const inclusionProofSchema = z
  .object({
    leaf_index: z.number().int().nonnegative(),
    tree_size: z.number().int().positive(),
    /** Audit path: closest-sibling-first SHA-256 hashes (base64url). May be empty
     *  only for a single-leaf tree. */
    proof_hashes: z.array(base64UrlBytes),
  })
  .strict();
export type InclusionProof = z.infer<typeof inclusionProofSchema>;

/** The signed manifest body (the bytes the maintainer signature covers). */
export const updateManifestBodySchema = z
  .object({
    /** Manifest schema version (forward-compat guard). */
    manifest_version: z.literal(1),
    /** Human-readable release version (e.g. the app `package.json` version). */
    bundle_version: z.string().min(1).max(64),
    /** Monotonic release sequence: a verifier rejects a manifest older than the
     *  one it last trusted (anti-rollback / "stale" verdict). */
    release_sequence: z.number().int().nonnegative(),
    /** The protected artifact's stable id (the private-mode chunk name). */
    artifact_id: z.string().min(1).max(256),
    /** SHA-256 over the built bundle bytes (base64url, 32 bytes decoded). */
    bundle_digest: base64UrlBytes,
    /** The transparency log the inclusion proof references. */
    log_id: z.string().min(1).max(256),
    /** The log-leaf input that was committed for this bundle: domain-separated
     *  `"licio-update-v1:" || bundle_digest` bytes (base64url).  The verifier
     *  recomputes the leaf hash from this and checks the inclusion proof. */
    log_leaf: base64UrlBytes,
  })
  .strict();
export type UpdateManifestBody = z.infer<typeof updateManifestBodySchema>;

/** The full signed update manifest: body + maintainer signature + log proof. */
export const updateManifestSchema = z
  .object({
    body: updateManifestBodySchema,
    /** Detached signature over `canonicalManifestBody(body)` by a maintainer
     *  release key whose raw public key is in the trusted signer set. */
    signature: base64UrlBytes,
    /** Which trusted signer produced `signature` (raw Ed25519 public key,
     *  base64url) — the verifier checks it is in the configured signer set AND
     *  that the signature verifies under it. */
    signer_public_key: base64UrlBytes,
    /** The inclusion proof + the signed checkpoint it verifies against. */
    inclusion_proof: inclusionProofSchema,
    checkpoint: transparencyCheckpointSchema,
  })
  .strict();
export type UpdateManifest = z.infer<typeof updateManifestSchema>;

/**
 * The canonical signing input for the manifest body: a deterministic, sorted-key
 * JSON encoding.  Both the signer and the verifier produce these exact bytes, so
 * the signature binds every body field (digest, version, sequence, log id, leaf)
 * with no ambiguity.  Keys are emitted in a FIXED order (not `JSON.stringify`'s
 * insertion order) so re-serialization is byte-stable across engines.
 */
export function canonicalManifestBody(body: UpdateManifestBody): Uint8Array {
  const ordered: Record<string, string | number> = {
    manifest_version: body.manifest_version,
    bundle_version: body.bundle_version,
    release_sequence: body.release_sequence,
    artifact_id: body.artifact_id,
    bundle_digest: body.bundle_digest,
    log_id: body.log_id,
    log_leaf: body.log_leaf,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * The canonical signing input for the transparency checkpoint: `(log_id,
 * tree_size, merkle_root)` in fixed key order.  The log signs these bytes; the
 * verifier reconstructs them to check the checkpoint signature.
 */
export function canonicalCheckpointBody(checkpoint: TransparencyCheckpoint): Uint8Array {
  const ordered: Record<string, string | number> = {
    log_id: checkpoint.log_id,
    tree_size: checkpoint.tree_size,
    merkle_root: checkpoint.merkle_root,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}
