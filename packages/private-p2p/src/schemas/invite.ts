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
    /** The §21 `room_server_id` of the room's directory record, when it has one. */
    room_stub_ref: privateIdSchema.optional(),
    /**
     * The §21.2 bootstrap capability for that record.
     *
     * It rides the SEALED invite because the recipient needs it BEFORE they are
     * admitted: an `unlisted` record answers `not_found` to every reader without
     * the token, so an invitee who received it only in the post-admission grant
     * could not check what Licio publishes about the room they were about to
     * join.  Carrying it here is safe for the same reason it is stable — it
     * resolves a record of commitments and bootstrap policy, never content, and
     * the invite itself is HPKE-sealed to one recipient and lives only in a URL
     * fragment.  Absent ⇒ a `detached` room, or one that registered no stub.
     */
    bootstrap_blind_id: base64UrlSchema.optional(),
    room_public_key: base64UrlSchema,
    invite_id: privateIdSchema,
    invite_secret: base64UrlSchema,
    expires_at: z.string().min(1).max(64),
    max_uses: z.number().int().min(1).max(10_000),
    granted_role: invitedRoleSchema,
    requires_admin_approval: z.boolean(),
  })
  .strict()
  // BOTH directory fields or NEITHER. A ref without a capability cannot open the
  // record, and a capability without a ref has nothing to open — either way the
  // join path silently treats the room as detached, so the member is admitted
  // and then cannot resolve an unlisted record or pass a working reference on.
  // Half a handle is not a weaker handle.
  .refine(
    (invite) => (invite.room_stub_ref === undefined) === (invite.bootstrap_blind_id === undefined),
    {
      message: 'room_stub_ref and bootstrap_blind_id must be supplied together',
      path: ['bootstrap_blind_id'],
    },
  );
export type InviteSecret = z.infer<typeof inviteSecretSchema>;

/** §12.3 — `JoinRequestV1`: the recipient proves invite knowledge + offers an
 *  MLS KeyPackage; the blind invite id never reveals the room to the server. */
export const joinRequestSchema = z
  .object({
    schema: z.literal('licio.private.join_request.v1'),
    invite_id_blind: base64UrlSchema,
    /** The recipient's MLS KeyPackage the Add commit will admit. */
    recipient_device_key_package: base64UrlSchema,
    /** The recipient's LONG-TERM device signing public key (Ed25519, raw, base64url) —
     *  the key it will AUTHOR ops with (separate from the MLS leaf signature key, so no
     *  cross-protocol key reuse, symmetric with the founder).  Bound into
     *  `proof_of_invite_secret`, so a relay cannot substitute a key it controls. */
    device_signing_public_key: base64UrlSchema,
    proposed_display_name: z.string().trim().min(1).max(100),
    proof_of_invite_secret: base64UrlSchema,
    requested_at_bucket: timeBucketSchema,
  })
  .strict();
export type JoinRequest = z.infer<typeof joinRequestSchema>;
