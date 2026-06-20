// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Consistency proof record + verifier + the equivocation signal (OFFLINE_SPEC
// §19.1.2, §19.4, WS-R.9.3b).  Verification requires that the second (larger)
// tree provably EXTENDS the first with no leaf rewritten, reordered, or removed.
// A failure between two checkpoints the same authority signed is equivocation;
// it returns a typed `consistency_failed` signal carrying both checkpoints,
// never a silent pass (WS-R.9.4 turns that signal into C0/P0 fork evidence).

import type { ConsistencyProofRecordV2, RoomCheckpointRecordV2 } from '../schemas/checkpoint.js';
import { verifyConsistency } from './merkle.js';
import type { CheckpointBundle } from './record.js';

export type ConsistencyVerifyStatus = 'algorithm_mismatch' | 'size_mismatch' | 'inconsistent';

export type ConsistencyVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: ConsistencyVerifyStatus };

/**
 * Verify a consistency proof links the old → new checkpoint of one room.  Both
 * checkpoints must name the same `tree_algorithm`, the proof's sizes must match
 * the checkpoints, and the new root must provably extend the old root.
 */
export async function verifyConsistencyProof(
  proof: ConsistencyProofRecordV2,
  oldCheckpoint: RoomCheckpointRecordV2,
  newCheckpoint: RoomCheckpointRecordV2,
): Promise<ConsistencyVerification> {
  if (oldCheckpoint.tree_algorithm !== newCheckpoint.tree_algorithm) {
    return { ok: false, status: 'algorithm_mismatch' };
  }
  if (
    proof.old_tree_size !== oldCheckpoint.tree_size ||
    proof.new_tree_size !== newCheckpoint.tree_size
  ) {
    return { ok: false, status: 'size_mismatch' };
  }
  const ok = await verifyConsistency(
    proof.old_tree_size,
    proof.new_tree_size,
    proof.proof_hashes,
    oldCheckpoint.merkle_root,
    newCheckpoint.merkle_root,
  );
  return ok ? { ok: true } : { ok: false, status: 'inconsistent' };
}

/** Equivocation evidence: a failed consistency check between two same-authority checkpoints. */
export interface ConsistencyFailedSignal {
  readonly kind: 'consistency_failed';
  readonly status: ConsistencyVerifyStatus;
  readonly oldCheckpoint: CheckpointBundle;
  readonly newCheckpoint: CheckpointBundle;
}

/**
 * Check consistency between two verified same-authority checkpoint bundles,
 * returning either `ok` or a `consistency_failed` signal (with both bundles) for
 * WS-R.9.4 to package as fork evidence.
 */
export async function checkCheckpointConsistency(
  proof: ConsistencyProofRecordV2,
  oldCheckpoint: CheckpointBundle,
  newCheckpoint: CheckpointBundle,
): Promise<{ ok: true } | ConsistencyFailedSignal> {
  const result = await verifyConsistencyProof(
    proof,
    oldCheckpoint.checkpoint,
    newCheckpoint.checkpoint,
  );
  if (result.ok) return { ok: true };
  return {
    kind: 'consistency_failed',
    status: result.status,
    oldCheckpoint,
    newCheckpoint,
  };
}
