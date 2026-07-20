// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — `PrivateRoomManifestPlainV1` (PRIVATE_SPEC §13.1): the decrypted
// room manifest.  It is itself an encrypted object (object_type `room_manifest`)
// and is content-addressed AFTER encryption; the server never sees it (§8.1).
import { roomTypeSchema } from '@licio/shared';
import { z } from 'zod';
import { base64UrlSchema, privateCidSchema, privateIdSchema } from './common.js';

/** §13.1 — the room profile (decrypted; never on the server). */
export const privateRoomProfileSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(2_000).optional(),
    room_type: roomTypeSchema,
    /** A CID over an ENCRYPTED avatar attachment (never a plaintext CID). */
    avatar_attachment_id: privateIdSchema.optional(),
  })
  .strict();

/** §13.1 — the room policy (membership/posting/transport/replication). */
export const privateRoomPolicySchema = z
  .object({
    directory_mode: z.enum(['listed', 'unlisted', 'detached']),
    membership_change: z.enum(['admin', 'threshold']),
    threshold: z
      .object({
        required: z.number().int().min(1).max(100),
        eligible_role: z.enum(['admin', 'recovery_admin']),
      })
      .strict()
      .optional(),
    posting_policy: z.enum(['all_members', 'role_gated']),
    role_gated_posters: z
      .array(z.enum(['moderator', 'admin']))
      .max(2)
      .optional(),
    allow_member_invites: z.boolean(),
    default_new_member_role: z.literal('member'),
    transport_mode: z.enum(['direct_allowed', 'relay_preferred', 'relay_only']),
    replication_target: z.number().int().min(0).max(1_000),
    small_op_padding: z.enum(['4k', '16k', 'off']),
    allow_blind_push: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A threshold membership policy MUST carry its threshold config (§12.6.1).
    if (value.membership_change === 'threshold' && value.threshold === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: 'threshold membership_change requires a threshold config',
      });
    }
    // role_gated posting MUST name the gated roles.
    if (value.posting_policy === 'role_gated' && value.role_gated_posters === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['role_gated_posters'],
        message: 'role_gated posting_policy requires role_gated_posters',
      });
    }
  });

/** §13.1 — the room crypto descriptor (commitments + pinned suite, no secrets). */
export const privateRoomCryptoSchema = z
  .object({
    room_public_key: base64UrlSchema,
    mls_group_id: base64UrlSchema,
    current_epoch: z.number().int().min(0),
    mls_cipher_suite: z.string().min(1).max(128),
    envelope_profile: z.literal('licio-private-envelope-v1'),
    cid_profile: z.literal('licio-private-cid-v1'),
  })
  .strict();

/** §13.1 — the log roots the manifest commits to (Merkle roots / latest snapshot). */
export const privateRoomRootsSchema = z
  .object({
    membership_log_root: base64UrlSchema,
    capability_log_root: base64UrlSchema,
    operation_log_root: base64UrlSchema,
    latest_snapshot: privateCidSchema.optional(),
  })
  .strict();

/** §13.1 — `PrivateRoomManifestPlainV1`. */
export const privateRoomFounderSchema = z
  .object({
    /** The §12.1 founder member + device — the ONLY identity permitted to author
     *  the genesis self-add.  Committed by the manifest commitment, so every
     *  device that verifies the manifest pins the same genesis author and a forged
     *  competing genesis is rejected network-wide (§14.2 genesis rule). */
    member_id: privateIdSchema,
    device_id: privateIdSchema,
  })
  .strict();

export const privateRoomManifestSchema = z
  .object({
    schema: z.literal('licio.private.room_manifest.v1'),
    room_id: privateIdSchema,
    created_at: z.string().min(1).max(64),
    founder: privateRoomFounderSchema,
    profile: privateRoomProfileSchema,
    policy: privateRoomPolicySchema,
    crypto: privateRoomCryptoSchema,
    roots: privateRoomRootsSchema,
  })
  .strict();
export type PrivateRoomManifest = z.infer<typeof privateRoomManifestSchema>;
