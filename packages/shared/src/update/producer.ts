// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.1 — the PRODUCER barrel: the build-tool-only surface for BUILDING the
// signed code-transparency update manifest (the append-only RFC 9162 log + the
// manifest signer).  Kept SEPARATE from the client `index.ts` so the
// manifest-producing code is never re-exported through the `@licio/shared` root
// index into the client bundle — only the build tooling (`scripts/
// build-update-manifest.ts`) and the `check:update-channel` gate import it.
//
// It still depends only on the same browser-safe primitives (WebCrypto SHA-256,
// the pure Merkle math, the canonical schema), so the build runs it under Node's
// `crypto.subtle` with no extra deps.

export {
  appendLeaf,
  type CheckpointSigner,
  emptyLog,
  merkleRoot,
  proveInclusion,
  signCheckpoint,
  type TransparencyLogState,
  treeSize,
} from './log.js';
export {
  LOG_LEAF_DOMAIN,
  type ManifestReleaseInfo,
  type ManifestSigner,
  type ProducedManifest,
  type ProduceManifestInput,
  produceSignedManifest,
} from './produce.js';
// Re-export the manifest type for the producer's consumers.
export type { UpdateManifest } from './schema.js';
