// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Strict closed-schema record bodies (OFFLINE_SPEC §11-§13).  Every schema is
// `.strict()` — an unknown map key is rejected (`rejected_bad_schema`, §9.1.4),
// never silently accepted — so a verifier that parses a body has, by
// construction, fully understood it before computing trust.  Forward
// compatibility is introduced by bumping `record_version` (a new closed
// schema), never by adding stray keys to an existing version.

import { z } from 'zod';
import {
  anyCidSchema,
  blockCidSchema,
  bytesSchema,
  chunkCidSchema,
  compressionIdSchema,
  epochMsSchema,
  lcapOperationSchema,
  prioritySchema,
  recordCidSchema,
  uintSchema,
  visibilityScopeSchema,
} from './common.js';

// ---------------------------------------------------------------------------
// Device certificate (§11.2)
// ---------------------------------------------------------------------------

export const deviceCertificateRecordV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('device_certificate'),
    account_id: z.string().min(1),
    device_id: z.string().min(1),
    device_key_id: z.string().min(1),
    public_key_cose: bytesSchema,
    issued_at_ms: epochMsSchema,
    not_before_ms: epochMsSchema,
    not_after_ms: epochMsSchema,
    issuer: z.literal('licio_account_authority'),
    account_epoch: uintSchema,
    flags: z
      .object({
        offline_signing_allowed: z.boolean().optional(),
        courier_allowed: z.boolean().optional(),
        high_risk: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DeviceCertificateRecordV2 = z.infer<typeof deviceCertificateRecordV2Schema>;

// ---------------------------------------------------------------------------
// Room capability (§11.3)
// ---------------------------------------------------------------------------

export const capabilityRecordV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('room_capability'),
    capability_id: z.string().min(1),
    subject_account_id: z.string().min(1),
    subject_device_id: z.string().min(1),
    subject_device_key_id: z.string().min(1),
    room_id: z.string().min(1),
    visibility_scope: visibilityScopeSchema,
    operations: z.array(lcapOperationSchema),
    policy_epoch: uintSchema,
    revocation_epoch_floor: uintSchema,
    not_before_ms: epochMsSchema,
    not_after_ms: epochMsSchema,
    quotas: z
      .object({
        max_offline_events: uintSchema,
        max_total_payload_bytes: uintSchema,
        max_single_event_bytes: uintSchema,
        max_media_bytes: uintSchema,
        max_export_count: uintSchema.optional(),
      })
      .strict(),
    transfer_policy: z
      .object({
        may_export_bundle: z.boolean(),
        may_share_with_relay: z.boolean(),
        may_share_with_courier: z.boolean(),
        may_share_with_unknown_peer: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type CapabilityRecordV2 = z.infer<typeof capabilityRecordV2Schema>;

// ---------------------------------------------------------------------------
// Revocation (§11.5)
// ---------------------------------------------------------------------------

export const revocationRecordV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('revocation'),
    revocation_id: z.string().min(1),
    revoked_kind: z.enum(['device', 'capability', 'account', 'room_policy', 'proof']),
    revoked_id: z.string().min(1),
    room_id: z.string().min(1).optional(),
    account_id: z.string().min(1).optional(),
    effective_at_ms: epochMsSchema,
    revocation_epoch: uintSchema,
    reason_code: z.string().min(1).optional(),
    replacement_cid: anyCidSchema.optional(),
  })
  .strict();

export type RevocationRecordV2 = z.infer<typeof revocationRecordV2Schema>;

// ---------------------------------------------------------------------------
// Contribution event (§12.1)
// ---------------------------------------------------------------------------

export const contributionEventTypeSchema = z.enum([
  'post',
  'question',
  'answer',
  'evidence',
  'correction',
  'synthesis',
  'counterexample',
  'clarification',
  'edit',
  'tombstone',
  'moderation_action',
  'source_snapshot_ref',
]);

export const contributionEventRecordV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('contribution_event'),
    event_type: contributionEventTypeSchema,
    home_room_id: z.string().min(1),
    visibility_scope: visibilityScopeSchema,
    author_account_id: z.string().min(1),
    author_device_id: z.string().min(1),
    author_device_key_id: z.string().min(1),
    device_seq: uintSchema,
    prev_device_record_cid: recordCidSchema.optional(),
    capability_cid: recordCidSchema,
    policy_epoch_claim: uintSchema,
    revocation_epoch_claim: uintSchema,
    parent_record_cids: z.array(recordCidSchema).optional(),
    replaces_record_cid: recordCidSchema.optional(),
    // §12.3: a tombstone / moderation_action references its target record; a
    // source correction references the target source snapshot.  (The §12.1 type
    // sketch omits these; they are required to express the §12.3 semantics and
    // are added as optional fields, so existing record bytes are unaffected.)
    target_record_cid: recordCidSchema.optional(),
    target_source_snapshot_cid: anyCidSchema.optional(),
    thread_root_cid: recordCidSchema.optional(),
    body_block_cid: blockCidSchema.optional(),
    attachment_manifest_cid: anyCidSchema.optional(),
    source_snapshot_cids: z.array(anyCidSchema).optional(),
    created_at_claim_ms: epochMsSchema.optional(),
    client_nonce: bytesSchema,
    priority: prioritySchema,
    licio_contribution_type: z.string().min(1).optional(),
    markdown_profile: z.literal('licio_markdown_lite_v1').optional(),
    privacy_flags: z
      .object({
        contains_private_room_metadata: z.boolean().optional(),
        safe_for_unknown_relay: z.boolean().optional(),
        safe_for_manual_export: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ContributionEventRecordV2 = z.infer<typeof contributionEventRecordV2Schema>;

// ---------------------------------------------------------------------------
// Block + chunk descriptors (§13.1, §13.2)
// ---------------------------------------------------------------------------

export const blockRoleSchema = z.enum([
  'body_text',
  'source_snapshot_text',
  'thumbnail',
  'image',
  'video',
  'encrypted_payload',
  'proof_blob',
  'misc',
]);

export const chunkingDescriptorV2Schema = z
  .object({
    chunk_size: uintSchema,
    chunk_count: uintSchema,
    chunk_cids: z.array(chunkCidSchema),
  })
  .strict();

export const compressionDescriptorV2Schema = z
  .object({
    algorithm: compressionIdSchema,
    compressed_size: uintSchema,
    uncompressed_size: uintSchema,
    uncompressed_sha256: bytesSchema,
    // No floats (§9.1.2): the expansion cap is an integer ratio.
    max_expansion_ratio: uintSchema,
  })
  .strict();

export const blockDescriptorV2Schema = z
  .object({
    block_cid: blockCidSchema,
    role: blockRoleSchema,
    media_type: z.string().min(1),
    size_bytes: uintSchema,
    sha256: bytesSchema,
    priority: prioritySchema,
    chunking: chunkingDescriptorV2Schema.optional(),
    compression: compressionDescriptorV2Schema.optional(),
  })
  .strict();

export type BlockDescriptorV2 = z.infer<typeof blockDescriptorV2Schema>;

export const chunkDescriptorV2Schema = z
  .object({
    parent_block_cid: blockCidSchema,
    chunk_index: uintSchema,
    offset: uintSchema,
    length: uintSchema,
    chunk_sha256: bytesSchema,
  })
  .strict();

export type ChunkDescriptorV2 = z.infer<typeof chunkDescriptorV2Schema>;

// ---------------------------------------------------------------------------
// Fork evidence (§12.2 device-sequence fork, §19.6 checkpoint fork)
// ---------------------------------------------------------------------------

/** Where a forked object pair was observed (mirrors the witness-statement set). */
export const gossipContextSchema = z.enum(['https', 'manual_bundle', 'qr', 'relay', 'courier']);

export const forkEvidenceV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('fork_evidence'),
    fork_kind: z.enum(['device_sequence', 'checkpoint']),
    // The two distinct objects observed under one identity (sorted by CID).
    object_cid_a: anyCidSchema,
    object_cid_b: anyCidSchema,
    // Device-sequence fork: the colliding (device_key_id, device_seq).
    device_key_id: z.string().min(1).optional(),
    device_seq: uintSchema.optional(),
    // Checkpoint fork: the colliding (room_id, tree_size).
    room_id: z.string().min(1).optional(),
    tree_size: uintSchema.optional(),
    observed_at_claim_ms: epochMsSchema.optional(),
    observed_context: gossipContextSchema.optional(),
  })
  .strict();

export type ForkEvidenceV2 = z.infer<typeof forkEvidenceV2Schema>;
