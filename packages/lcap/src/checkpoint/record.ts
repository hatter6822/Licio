// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `room_checkpoint` build / sign / verify (OFFLINE_SPEC §19.2, WS-R.9.2b).  The
// checkpoint body is signed by the room authority; `tree_algorithm`,
// `tree_size`, `merkle_root`, `policy_epoch`, `revocation_epoch`, and
// `previous_checkpoint_cid` all live inside the SIGNED body.  A checkpoint is
// untrusted without a valid authority proof, and a holder of the room log can
// additionally confirm the `merkle_root` matches the log prefix it claims.

import { buildAndSign, type DetachedProofV2, verifyDetached } from '../cose/sign1.js';
import {
  type RoomCheckpointRecordV2,
  roomCheckpointRecordV2Schema,
} from '../schemas/checkpoint.js';
import { encodeWithSchema } from '../schemas/codec.js';
import type { RoomLog } from './log.js';
import { bytesEqual } from './merkle.js';

export interface CheckpointBundle {
  readonly checkpoint: RoomCheckpointRecordV2;
  readonly body: Uint8Array;
  readonly proof: DetachedProofV2;
}

export interface BuildCheckpointParams {
  readonly roomId: string;
  readonly treeSize: number;
  readonly policyEpoch: number;
  readonly revocationEpoch: number;
  readonly issuedAtMs: number;
  readonly signerAuthorityId: string;
  readonly previousCheckpointCid?: string;
}

/** Build a checkpoint record whose `merkle_root` is the log prefix root. */
export async function buildCheckpoint(
  log: RoomLog,
  params: BuildCheckpointParams,
): Promise<RoomCheckpointRecordV2> {
  const merkleRoot = await log.rootAt(params.treeSize);
  return roomCheckpointRecordV2Schema.parse({
    record_version: 2,
    kind: 'room_checkpoint',
    room_id: params.roomId,
    tree_algorithm: log.algorithm,
    tree_size: params.treeSize,
    merkle_root: merkleRoot,
    policy_epoch: params.policyEpoch,
    revocation_epoch: params.revocationEpoch,
    issued_at_ms: params.issuedAtMs,
    signer_authority_id: params.signerAuthorityId,
    ...(params.previousCheckpointCid !== undefined
      ? { previous_checkpoint_cid: params.previousCheckpointCid }
      : {}),
  });
}

/** Encode + room-authority-sign a checkpoint, returning the full bundle. */
export async function signCheckpoint(params: {
  authorityPrivateKey: CryptoKey;
  authoritySignerKeyId: string;
  checkpoint: RoomCheckpointRecordV2;
  networkId: string;
}): Promise<CheckpointBundle> {
  const body = encodeWithSchema(roomCheckpointRecordV2Schema, params.checkpoint);
  const proof = await buildAndSign({
    privateKey: params.authorityPrivateKey,
    signerKeyId: params.authoritySignerKeyId,
    proofKind: 'authority_signature',
    recordKind: 'room_checkpoint',
    recordBody: body,
    networkId: params.networkId,
  });
  return { checkpoint: params.checkpoint, body, proof };
}

export type CheckpointVerifyStatus =
  | 'rejected_wrong_proof_kind'
  | 'rejected_bad_authority_proof'
  | 'rejected_checkpoint_body_mismatch';

export type CheckpointVerification =
  | { readonly ok: true; readonly checkpoint: RoomCheckpointRecordV2 }
  | { readonly ok: false; readonly status: CheckpointVerifyStatus };

/** Verify a checkpoint's room-authority proof. */
export async function verifyCheckpoint(
  bundle: CheckpointBundle,
  authorityPublicKey: CryptoKey,
  ctx: { networkId: string },
): Promise<CheckpointVerification> {
  if (bundle.proof.proof_kind !== 'authority_signature') {
    return { ok: false, status: 'rejected_wrong_proof_kind' };
  }
  const verified = await verifyDetached(bundle.proof, bundle.body, authorityPublicKey, {
    networkId: ctx.networkId,
    expectedRecordKind: 'room_checkpoint',
  });
  if (!verified.ok) return { ok: false, status: 'rejected_bad_authority_proof' };
  // BIND the parsed checkpoint to the SIGNED bytes: the authority proof covers
  // `body`, not `bundle.checkpoint`.  Without this an attacker could pair a genuine
  // proof+body from ANY real checkpoint with a forged `checkpoint` carrying a chosen
  // `merkle_root`, then supply a self-consistent inclusion proof.  Re-encoding is
  // deterministic + injective, so a mismatch means `checkpoint` is not what was signed.
  if (!bytesEqual(encodeWithSchema(roomCheckpointRecordV2Schema, bundle.checkpoint), bundle.body)) {
    return { ok: false, status: 'rejected_checkpoint_body_mismatch' };
  }
  return { ok: true, checkpoint: bundle.checkpoint };
}

/**
 * For a holder of the room log: confirm the checkpoint's `merkle_root` equals
 * the recomputed root of the log prefix `[0, tree_size)` it claims.  Independent
 * of (and complementary to) the authority-proof check.
 */
export async function checkpointRootMatchesLog(
  checkpoint: RoomCheckpointRecordV2,
  log: RoomLog,
): Promise<boolean> {
  if (checkpoint.tree_algorithm !== log.algorithm) return false;
  if (checkpoint.tree_size > log.size) return false;
  return bytesEqual(checkpoint.merkle_root, await log.rootAt(checkpoint.tree_size));
}
