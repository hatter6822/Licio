// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — invite + join schemas (PRIVATE_SPEC §10.3, §12.3).  The invite
// SECRET is HPKE-sealed and lives ONLY in a URL FRAGMENT (`…/private/join#invite=`
// — never the path/query, so ordinary HTTP never sends it to the server).
import { z } from 'zod';
import { base64UrlSchema, privateIdSchema, timeBucketSchema } from './common.js';

/** §10.3 — the role an invite may grant (no `recovery_admin` via invite). */
export const invitedRoleSchema = z.enum(['member', 'moderator', 'admin']);

/** §10.3 — `InviteSecretV1`: HPKE-sealed to the recipient before MLS join. */
export const inviteSecretSchema = z
  .object({
    schema: z.literal('licio.private.invite_secret.v1'),
    room_stub_ref: privateIdSchema.optional(),
    room_public_key: base64UrlSchema,
    invite_id: privateIdSchema,
    invite_secret: base64UrlSchema,
    expires_at: z.string().min(1).max(64),
    max_uses: z.number().int().min(1).max(10_000),
    granted_role: invitedRoleSchema,
    requires_admin_approval: z.boolean(),
  })
  .strict();
export type InviteSecret = z.infer<typeof inviteSecretSchema>;

/** §12.3 — `JoinRequestV1`: the recipient proves invite knowledge + offers an
 *  MLS KeyPackage; the blind invite id never reveals the room to the server. */
export const joinRequestSchema = z
  .object({
    schema: z.literal('licio.private.join_request.v1'),
    invite_id_blind: base64UrlSchema,
    /** The recipient's MLS KeyPackage the Add commit will admit. */
    recipient_device_key_package: base64UrlSchema,
    proposed_display_name: z.string().trim().min(1).max(100),
    proof_of_invite_secret: base64UrlSchema,
    requested_at_bucket: timeBucketSchema,
  })
  .strict();
export type JoinRequest = z.infer<typeof joinRequestSchema>;
