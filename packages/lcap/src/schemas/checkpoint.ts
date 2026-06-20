// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Room-log checkpoint + proof + witness records (OFFLINE_SPEC §19.2-§19.5).
// All `.strict()` closed schemas, paired with LDC decode/encode like every
// other record.  The `tree_algorithm` named in a checkpoint is the only rule a
// verifier may apply against it (no per-proof override), so a checkpoint and its
// proofs cannot disagree on the hashing rule.

import { z } from 'zod';
import { bytesSchema, epochMsSchema, recordCidSchema, uintSchema } from './common.js';
import { gossipContextSchema } from './records.js';

/** Hashing/proof rule selector (§19.1.1). */
export const treeAlgorithmSchema = z.enum(['RFC9162_SHA256', 'LCAP_MERKLE_V2']);

export const roomCheckpointRecordV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('room_checkpoint'),
    room_id: z.string().min(1),
    tree_algorithm: treeAlgorithmSchema,
    tree_size: uintSchema,
    merkle_root: bytesSchema,
    previous_checkpoint_cid: recordCidSchema.optional(),
    accepted_record_range: z
      .object({ first_seq: uintSchema, last_seq: uintSchema })
      .strict()
      .optional(),
    policy_epoch: uintSchema,
    revocation_epoch: uintSchema,
    issued_at_ms: epochMsSchema,
    signer_authority_id: z.string().min(1),
  })
  .strict();

export type RoomCheckpointRecordV2 = z.infer<typeof roomCheckpointRecordV2Schema>;

export const inclusionProofRecordV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('inclusion_proof'),
    room_id: z.string().min(1),
    checkpoint_cid: recordCidSchema,
    target_record_cid: recordCidSchema,
    leaf_index: uintSchema,
    tree_size: uintSchema,
    proof_hashes: z.array(bytesSchema),
  })
  .strict();

export type InclusionProofRecordV2 = z.infer<typeof inclusionProofRecordV2Schema>;

export const consistencyProofRecordV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('consistency_proof'),
    room_id: z.string().min(1),
    old_checkpoint_cid: recordCidSchema,
    new_checkpoint_cid: recordCidSchema,
    old_tree_size: uintSchema,
    new_tree_size: uintSchema,
    proof_hashes: z.array(bytesSchema),
  })
  .strict();

export type ConsistencyProofRecordV2 = z.infer<typeof consistencyProofRecordV2Schema>;

export const witnessStatementRecordV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('witness_statement'),
    witness_id: z.string().min(1),
    observed_checkpoint_cid: recordCidSchema,
    observed_tree_size: uintSchema,
    observed_merkle_root: bytesSchema,
    observed_at_claim_ms: epochMsSchema.optional(),
    gossip_context: gossipContextSchema.optional(),
  })
  .strict();

export type WitnessStatementRecordV2 = z.infer<typeof witnessStatementRecordV2Schema>;
