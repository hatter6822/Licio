// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Packfile / `.licio-bundle` schemas (OFFLINE_SPEC §14.4-§14.8).  The object
// table appears before the frames so a receiver can decide to import, skip, or
// range-fetch before reading any payload; a bundle manifest is a record body
// (it authenticates the preparer, NOT the trust of the contained records).

import { z } from 'zod';
import {
  anyCidSchema,
  bytesSchema,
  cidKindSchema,
  epochMsSchema,
  lcapLaneSchema,
  lcapRecordKindSchema,
  prioritySchema,
  uintSchema,
} from './common.js';

export const transportProfileSchema = z.enum([
  'https',
  'manual_bundle',
  'qr',
  'relay',
  'courier',
  'test',
]);

export const packPrivacyLabelSchema = z.enum([
  'public',
  'contains_in_room_metadata',
  'contains_private_encrypted',
  'manual_user_selected',
]);

export const packHeaderV2Schema = z
  .object({
    pack_version: z.literal(2),
    created_by_node_id: z.string().min(1).optional(),
    created_at_claim_ms: epochMsSchema.optional(),
    transport_profile: transportProfileSchema,
    privacy_label: packPrivacyLabelSchema,
    compression: z.enum(['none', 'gzip', 'deflate', 'zstd']).optional(),
    max_uncompressed_bytes: uintSchema,
    contains_lanes: z.array(lcapLaneSchema),
    critical_cids: z.array(anyCidSchema).optional(),
    manifest_record_cid: anyCidSchema.optional(),
  })
  .strict();

export type PackHeaderV2 = z.infer<typeof packHeaderV2Schema>;

export const packTableEntryV2Schema = z
  .object({
    cid: anyCidSchema,
    cid_kind: cidKindSchema,
    record_kind: lcapRecordKindSchema.optional(),
    lane: lcapLaneSchema,
    priority: prioritySchema,
    offset: uintSchema,
    length: uintSchema,
    uncompressed_length: uintSchema.optional(),
    deps: z.array(anyCidSchema).optional(),
    provides_proof_for: anyCidSchema.optional(),
    room_id_hash: bytesSchema.optional(),
    flags: z
      .object({
        critical: z.boolean().optional(),
        renderable_without_media: z.boolean().optional(),
        encrypted: z.boolean().optional(),
        private_metadata: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PackTableEntryV2 = z.infer<typeof packTableEntryV2Schema>;

/** The pack object table (a closed wrapper so it is a single LDC map). */
export const packTableV2Schema = z.object({ entries: z.array(packTableEntryV2Schema) }).strict();
export type PackTableV2 = z.infer<typeof packTableV2Schema>;

/** A streamed frame header (the payload bytes follow the LDC header on the wire). */
export const packFrameHeaderV2Schema = z
  .object({
    frame_kind: z.enum(['record_body', 'proof', 'block', 'chunk']),
    cid: anyCidSchema,
    payload_len: uintSchema,
  })
  .strict();

export type PackFrameHeaderV2 = z.infer<typeof packFrameHeaderV2Schema>;

export const bundleManifestRecordV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('bundle_manifest'),
    entries: z.array(packTableEntryV2Schema),
    purpose: z.enum([
      'manual_export',
      'relay_offer',
      'courier_transfer',
      'server_response',
      'qr_microbundle',
    ]),
    export_scope: z
      .object({
        room_ids: z.array(z.string().min(1)).optional(),
        priority_floor: prioritySchema.optional(),
        include_private_encrypted: z.boolean().optional(),
        include_media: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type BundleManifestRecordV2 = z.infer<typeof bundleManifestRecordV2Schema>;
