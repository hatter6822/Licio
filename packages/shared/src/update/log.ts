// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.1 / WS-O.3.2b — the PRODUCING half of the code-transparency channel:
// a minimal, PURE, append-only RFC 9162 / RFC 6962 Merkle transparency log
// (PRIVATE_SPEC §20.6, §22.4; WS-O.3.2b "append-only code-transparency log +
// per-chunk attestation").  The verifier (`verifyUpdateManifest`) consumes an
// RFC 9162 §2.1.3 inclusion proof against a log-signed checkpoint; this module
// is the operator-side counterpart that BUILDS those artifacts:
//
//   * `appendLeaf(state, leaf)` — append a log-leaf input (the domain-separated
//     bundle-digest commitment) and return the NEW append-only state;
//   * `proveInclusion(state, index)` — the RFC 9162 §2.1.3.2 audit path for a
//     leaf already in the log (the same closest-sibling-first path the
//     verifier's `verifyInclusion` reconstructs);
//   * `merkleRoot(state)` — the RFC 6962 §2.1 tree head root (`MTH`);
//   * `signCheckpoint(state, sign)` — a SIGNED tree head (`(log_id, tree_size,
//     merkle_root)` over the canonical checkpoint body, RFC 9162 §4.5).
//
// The log STATE is an immutable, append-only list of leaf-hash bytes: appending
// only ever grows the list (a later append never rewrites an earlier leaf), so
// the inclusion proof a build emitted stays valid against every later
// checkpoint that contains it.  This is the in-process / file-backed Tier-1
// substrate (the build tool serializes/deserializes it as JSON); a
// production-ops deployment runs a standalone log SERVICE with witness/gossip
// (the prod-ops boundary is documented at the call site).  `@licio/shared` is a
// LEAF: the math is self-contained here, byte-identical to the audited LCAP
// checkpoint implementation and to this package's own `merkle.ts` verifier.

import { leafHash, nodeHash } from './merkle.js';
import { canonicalCheckpointBody, type TransparencyCheckpoint } from './schema.js';

/**
 * An append-only transparency-log state: the log id + the ordered leaf HASHES
 * (`MTH({d}) = SHA-256(0x00 || leaf_input)`, already domain-separated).  Storing
 * leaf hashes (not raw inputs) keeps the root/proof math allocation-free and
 * makes the serialized form a flat list of fixed-width digests.  Treat as
 * immutable: every producing function returns a NEW state, never mutating its
 * argument (append-only by construction).
 */
export interface TransparencyLogState {
  readonly logId: string;
  /** Leaf hashes in append order; index `i` is the `i`-th appended bundle. */
  readonly leafHashes: readonly Uint8Array[];
}

/** Create an empty append-only log for `logId`. */
export function emptyLog(logId: string): TransparencyLogState {
  if (logId.length === 0 || logId.length > 256) {
    throw new Error('transparency log id must be 1..256 chars');
  }
  return { logId, leafHashes: [] };
}

/** The number of leaves (the RFC 9162 tree size) at the current state. */
export function treeSize(state: TransparencyLogState): number {
  return state.leafHashes.length;
}

/**
 * Append a leaf INPUT (the domain-separated `"licio-update-v1:" || digest`
 * bytes the manifest carries as `log_leaf`) and return the new append-only
 * state plus the leaf's index.  The leaf input is hashed once here; the stored
 * state holds the leaf hash.  Appending never rewrites an existing leaf.
 */
export async function appendLeaf(
  state: TransparencyLogState,
  leafInput: Uint8Array,
): Promise<{ readonly state: TransparencyLogState; readonly index: number }> {
  const hash = await leafHash(leafInput);
  const index = state.leafHashes.length;
  return {
    state: { logId: state.logId, leafHashes: [...state.leafHashes, hash] },
    index,
  };
}

/** Largest power of two strictly less than `n` (RFC 6962 split point). */
function largestPow2LessThan(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** `MTH(leafHashes[lo..hi))` over the half-open range (RFC 6962 §2.1). */
async function mth(leafHashes: readonly Uint8Array[], lo: number, hi: number): Promise<Uint8Array> {
  const n = hi - lo;
  if (n === 1) return leafHashes[lo] as Uint8Array;
  const k = largestPow2LessThan(n);
  return nodeHash(await mth(leafHashes, lo, lo + k), await mth(leafHashes, lo + k, hi));
}

/**
 * The RFC 6962 §2.1 Merkle tree head root over all leaves.  An empty log has no
 * root (the verifier never accepts a zero-size checkpoint), so this throws on an
 * empty log rather than returning a degenerate value.
 */
export async function merkleRoot(state: TransparencyLogState): Promise<Uint8Array> {
  if (state.leafHashes.length === 0) {
    throw new Error('cannot compute a Merkle root over an empty transparency log');
  }
  return mth(state.leafHashes, 0, state.leafHashes.length);
}

/**
 * The RFC 9162 §2.1.3.2 inclusion (audit) path for leaf `index`: the
 * closest-sibling-first list of node hashes the verifier folds with the leaf to
 * reconstruct the root.  Throws on an out-of-range index.  The proof is
 * computed against the CURRENT tree size; because the log is append-only, a
 * proof for an earlier index against the current size still folds to the
 * current root (the verifier checks the proof against the matching checkpoint).
 */
export async function proveInclusion(
  state: TransparencyLogState,
  index: number,
): Promise<readonly Uint8Array[]> {
  const size = state.leafHashes.length;
  if (!Number.isInteger(index) || index < 0 || index >= size) {
    throw new Error(`leaf index ${index} out of range for tree size ${size}`);
  }
  const path = async (m: number, lo: number, hi: number): Promise<Uint8Array[]> => {
    if (hi - lo === 1) return [];
    const k = largestPow2LessThan(hi - lo);
    if (m - lo < k) {
      const sub = await path(m, lo, lo + k);
      sub.push(await mth(state.leafHashes, lo + k, hi));
      return sub;
    }
    const sub = await path(m, lo + k, hi);
    sub.push(await mth(state.leafHashes, lo, lo + k));
    return sub;
  };
  return path(index, 0, size);
}

/** A detached signer over the canonical checkpoint bytes (the log's key). */
export type CheckpointSigner = (canonicalBody: Uint8Array) => Promise<Uint8Array>;

/**
 * Produce a SIGNED tree head (RFC 9162 §4.5): `(log_id, tree_size, merkle_root)`
 * over the canonical checkpoint body, detached-signed by the log key.  The
 * verifier reconstructs the same body via `canonicalCheckpointBody` and checks
 * the signature under the configured log public key.  Throws on an empty log
 * (there is no root to sign).
 */
export async function signCheckpoint(
  state: TransparencyLogState,
  sign: CheckpointSigner,
  toBase64Url: (bytes: Uint8Array) => string,
): Promise<TransparencyCheckpoint> {
  const root = await merkleRoot(state);
  const partial = {
    log_id: state.logId,
    tree_size: state.leafHashes.length,
    merkle_root: toBase64Url(root),
  };
  // The checkpoint body covers (log_id, tree_size, merkle_root); `signature` is
  // excluded from its own input (an empty string at sign time, matching the
  // verifier which never feeds the signature back into the body).
  const signature = await sign(canonicalCheckpointBody({ ...partial, signature: '' }));
  return { ...partial, signature: toBase64Url(signature) };
}
