// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Witness statements + checkpoint-fork evidence (OFFLINE_SPEC §19.5, §19.6,
// WS-R.9.4).  A witness statement is a signed independent observation of a
// checkpoint — it raises confidence the authority is not silently equivocating
// but creates NO canonical state and never substitutes for inclusion/consistency
// verification.  Two signed checkpoints for the same room and `tree_size` with
// different roots is fork evidence: C0/P0, gossiped, a severe consistency
// warning.

import { buildAndSign, type DetachedProofV2, verifyDetached } from '../cose/sign1.js';
import { CONTROL_PRIORITY, type LcapPriority } from '../priority.js';
import {
  type WitnessStatementRecordV2,
  witnessStatementRecordV2Schema,
} from '../schemas/checkpoint.js';
import { encodeWithSchema } from '../schemas/codec.js';
import { type ForkEvidenceV2, forkEvidenceV2Schema } from '../schemas/records.js';
import { bytesEqual } from './merkle.js';

export interface WitnessBundle {
  readonly statement: WitnessStatementRecordV2;
  readonly body: Uint8Array;
  readonly proof: DetachedProofV2;
}

/** Encode + sign a witness statement (a `witness_signature` proof). */
export async function signWitnessStatement(params: {
  witnessPrivateKey: CryptoKey;
  witnessSignerKeyId: string;
  statement: WitnessStatementRecordV2;
  networkId: string;
}): Promise<WitnessBundle> {
  const body = encodeWithSchema(witnessStatementRecordV2Schema, params.statement);
  const proof = await buildAndSign({
    privateKey: params.witnessPrivateKey,
    signerKeyId: params.witnessSignerKeyId,
    proofKind: 'witness_signature',
    recordKind: 'witness_statement',
    recordBody: body,
    networkId: params.networkId,
  });
  return { statement: params.statement, body, proof };
}

export type WitnessVerifyStatus = 'rejected_wrong_proof_kind' | 'rejected_bad_signature';

export type WitnessVerification =
  | { readonly ok: true; readonly statement: WitnessStatementRecordV2 }
  | { readonly ok: false; readonly status: WitnessVerifyStatus };

/** Verify a witness statement against the witness's public key. */
export async function verifyWitnessStatement(
  bundle: WitnessBundle,
  witnessPublicKey: CryptoKey,
  ctx: { networkId: string },
): Promise<WitnessVerification> {
  if (bundle.proof.proof_kind !== 'witness_signature') {
    return { ok: false, status: 'rejected_wrong_proof_kind' };
  }
  const verified = await verifyDetached(bundle.proof, bundle.body, witnessPublicKey, {
    networkId: ctx.networkId,
    expectedRecordKind: 'witness_statement',
  });
  if (!verified.ok) return { ok: false, status: 'rejected_bad_signature' };
  return { ok: true, statement: bundle.statement };
}

/** Checkpoint fork evidence always schedules at P0 / lane C0. */
export function checkpointForkPriority(): LcapPriority {
  return CONTROL_PRIORITY;
}

/** A detected checkpoint fork (two roots at the same room + tree size). */
export interface CheckpointForkObservation {
  readonly roomId: string;
  readonly treeSize: number;
  readonly checkpointCidA: string;
  readonly checkpointCidB: string;
}

/**
 * Detects checkpoint forks as signed checkpoints are observed: two checkpoints
 * for the same `(room_id, tree_size)` with different Merkle roots are
 * equivocation.  An identical re-observation (same root) is idempotent.
 */
export class CheckpointForkDetector {
  private readonly seen = new Map<string, { root: Uint8Array; checkpointCid: string }>();

  observe(
    roomId: string,
    treeSize: number,
    merkleRoot: Uint8Array,
    checkpointCid: string,
  ): CheckpointForkObservation | undefined {
    const key = `${roomId}:${treeSize}`;
    const existing = this.seen.get(key);
    if (!existing) {
      this.seen.set(key, { root: merkleRoot, checkpointCid });
      return undefined;
    }
    if (bytesEqual(existing.root, merkleRoot)) return undefined; // same checkpoint
    const [a, b] =
      existing.checkpointCid < checkpointCid
        ? [existing.checkpointCid, checkpointCid]
        : [checkpointCid, existing.checkpointCid];
    return { roomId, treeSize, checkpointCidA: a, checkpointCidB: b };
  }
}

export interface BuildCheckpointForkEvidenceParams {
  readonly observation: CheckpointForkObservation;
  readonly observedAtClaimMs?: number;
  readonly observedContext?: ForkEvidenceV2['observed_context'];
}

/** Build a `fork_evidence` record for a detected checkpoint fork. */
export function buildCheckpointForkEvidence(
  params: BuildCheckpointForkEvidenceParams,
): ForkEvidenceV2 {
  const { observation } = params;
  return forkEvidenceV2Schema.parse({
    record_version: 2,
    kind: 'fork_evidence',
    fork_kind: 'checkpoint',
    object_cid_a: observation.checkpointCidA,
    object_cid_b: observation.checkpointCidB,
    room_id: observation.roomId,
    tree_size: observation.treeSize,
    ...(params.observedAtClaimMs !== undefined
      ? { observed_at_claim_ms: params.observedAtClaimMs }
      : {}),
    ...(params.observedContext !== undefined ? { observed_context: params.observedContext } : {}),
  });
}
