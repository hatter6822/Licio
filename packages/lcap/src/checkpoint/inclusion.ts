// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Inclusion proof record + verifier (OFFLINE_SPEC §19.1.2, §19.3, WS-R.9.3a).
// Verification recomputes a candidate root from
// `(leaf_index, tree_size, proof_hashes, target_record_cid)` using the
// CHECKPOINT's named `tree_algorithm` only (no per-proof override) and requires
// byte equality with the checkpoint's `merkle_root`.

import { parseCid } from '../cid/index.js';
import type { InclusionProofRecordV2, RoomCheckpointRecordV2 } from '../schemas/checkpoint.js';
import { leafHash, verifyInclusion } from './merkle.js';

export type InclusionVerifyStatus =
  | 'tree_size_mismatch'
  | 'leaf_index_out_of_range'
  | 'root_mismatch';

export type InclusionVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: InclusionVerifyStatus };

/**
 * Verify an inclusion proof against a checkpoint.  The proof's `tree_size` must
 * match the checkpoint's; the leaf is hashed under the checkpoint's
 * `tree_algorithm`; the recomputed root must equal `checkpoint.merkle_root`.
 * (The caller is responsible for having resolved the checkpoint named by
 * `proof.checkpoint_cid`.)
 */
export async function verifyInclusionProof(
  proof: InclusionProofRecordV2,
  checkpoint: RoomCheckpointRecordV2,
  networkId: string,
): Promise<InclusionVerification> {
  if (proof.tree_size !== checkpoint.tree_size) return { ok: false, status: 'tree_size_mismatch' };
  if (proof.leaf_index >= proof.tree_size) return { ok: false, status: 'leaf_index_out_of_range' };
  const leaf = await leafHash(
    parseCid(proof.target_record_cid).bytes,
    checkpoint.tree_algorithm,
    networkId,
  );
  const ok = await verifyInclusion(
    leaf,
    proof.leaf_index,
    proof.tree_size,
    proof.proof_hashes,
    checkpoint.merkle_root,
  );
  return ok ? { ok: true } : { ok: false, status: 'root_mismatch' };
}
