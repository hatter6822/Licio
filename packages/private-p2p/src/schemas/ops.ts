// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — the private operation log's op bodies + the op envelope plaintext
// (PRIVATE_SPEC §13.2–§13.6).  Content ops mirror Licio's taxonomy LOCALLY;
// contribution ops enforce the SAME typed requirements as the shipped WS-G
// server schema by REUSING the shared constants (`CONTRIBUTION_BODY_LIMITS`,
// `MAX_CITATIONS`, `citationSchema`, `contributionTypeSchema`,
// `submissionTypeSchema`, the thread state machines), so the two can never
// drift.  The structural reducer rules that need thread/room state
// (answer→question parent, depth ≤ 10, lens-in-room, client_draft dedup) are
// enforced in the reducer (WS-S.5.3c) on decrypted state; this card pins the
// SHAPE + the schema-checkable body caps / citation rules.
import {
  CONTRIBUTION_BODY_LIMITS,
  type ContributionType,
  citationSchema,
  contributionTypeSchema,
  MAX_CITATIONS,
  submissionTypeSchema,
  threadConversationStateSchema,
  threadSafetyStateSchema,
} from '@licio/shared';
import { z } from 'zod';
import {
  base64UrlSchema,
  lamportSchema,
  privateCapabilitySchema,
  privateCidSchema,
  privateIdSchema,
  privateRoleSchema,
  timeBucketSchema,
} from './common.js';

// ---------------------------------------------------------------------------
// Membership / authority ops (§13.2; WS-S.5.1).  Authorized by ROOM CAPABILITY
// state, never a platform role (§11.4) — the capability check is the reducer's
// (WS-S.5.3b); these schemas pin the op shapes.
// ---------------------------------------------------------------------------

export const memberAddOpSchema = z
  .object({
    type: z.literal('member.add'),
    member_id: privateIdSchema,
    device_id: privateIdSchema,
    signing_public_key: base64UrlSchema,
    hpke_public_key: base64UrlSchema,
    /** The MLS KeyPackage that the Add commit admits (§10.2). */
    mls_key_package: base64UrlSchema,
    granted_role: privateRoleSchema,
    /**
     * A NON-cryptographic, admin-chosen display name (carried into the signed
     * op so it converges across devices, §14.3.3).  It NEVER affects authority
     * (capability checks are by member id + role only, §11.3/§11.4); a UI MUST
     * render it as distinct from — and subordinate to — the cryptographic
     * member id.  Bounded like the §12.3 join `proposed_display_name`.
     */
    display_name: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const memberRemoveOpSchema = z
  .object({
    type: z.literal('member.remove'),
    member_id: privateIdSchema,
    reason: z.string().max(500).optional(),
  })
  .strict();

export const deviceRemoveOpSchema = z
  .object({
    type: z.literal('device.remove'),
    member_id: privateIdSchema,
    device_id: privateIdSchema,
    reason: z.string().max(500).optional(),
  })
  .strict();

export const roleGrantOpSchema = z
  .object({
    type: z.literal('role.grant'),
    member_id: privateIdSchema,
    /** A role grant implies its §11.3 capabilities; an explicit capability MAY
     *  also be granted directly (the reducer resolves role→capability). */
    role: privateRoleSchema.optional(),
    capability: privateCapabilitySchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.role === undefined && v.capability === undefined) {
      ctx.addIssue({ code: 'custom', path: ['role'], message: 'grant a role or a capability' });
    }
  });

export const roleRevokeOpSchema = z
  .object({
    type: z.literal('role.revoke'),
    member_id: privateIdSchema,
    role: privateRoleSchema.optional(),
    capability: privateCapabilitySchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.role === undefined && v.capability === undefined) {
      ctx.addIssue({ code: 'custom', path: ['role'], message: 'revoke a role or a capability' });
    }
  });

export const memberInviteCreateOpSchema = z
  .object({
    type: z.literal('member.invite.create'),
    /** The PUBLIC invite id (the SECRET never appears in an op, §10.3). */
    invite_id: privateIdSchema,
    granted_role: privateRoleSchema,
    expires_at: z.string().min(1).max(64),
    max_uses: z.number().int().min(1).max(10_000),
    requires_admin_approval: z.boolean(),
  })
  .strict();

/** §12.6.1 — one of M distinct admin authorizations toward a capability-based
 *  threshold recovery (NOT secret-sharing; no key material is reconstructed). */
export const recoveryAuthorizeOpSchema = z
  .object({
    type: z.literal('recovery.authorize'),
    recovery_request_id: privateIdSchema,
    recovering_member_id: privateIdSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Content ops (§13.3–§13.5).
// ---------------------------------------------------------------------------

export const storyCreateOpSchema = z
  .object({
    type: z.literal('story.create'),
    story_id: privateIdSchema,
    thread_id: privateIdSchema,
    title: z.string().trim().min(1).max(300),
    submission_type: submissionTypeSchema,
    topic_ids: z.array(z.string().min(1).max(64)).max(10),
    language: z.string().min(2).max(35).optional(),
    sensitivity_labels: z.array(z.string().min(1).max(64)).max(16).optional(),
    /** Local-only scope object (a user-chosen content region, never detected). */
    location_scope: z.unknown().optional(),
    /** Validates against a PRIVATE equivalent of the story schema; link URL
     *  normalization is LOCAL (never the server normalizer/safety service). */
    submission_metadata: z.unknown(),
    /** CIDs of ENCRYPTED attachment manifests (never plaintext CIDs). */
    attachment_refs: z.array(privateCidSchema).max(16).optional(),
  })
  .strict();

export const storyEditOpSchema = z
  .object({
    type: z.literal('story.edit'),
    story_id: privateIdSchema,
    title: z.string().trim().min(1).max(300).optional(),
    topic_ids: z.array(z.string().min(1).max(64)).max(10).optional(),
    sensitivity_labels: z.array(z.string().min(1).max(64)).max(16).optional(),
    language: z.string().min(2).max(35).optional(),
    submission_metadata: z.unknown().optional(),
  })
  .strict();

export const storyTombstoneOpSchema = z
  .object({
    type: z.literal('story.tombstone'),
    story_id: privateIdSchema,
    reason: z.string().max(500).optional(),
  })
  .strict();

export const threadStateOpSchema = z
  .object({
    type: z.literal('thread.state'),
    thread_id: privateIdSchema,
    /** Room-LOCAL states — NOT platform moderation decisions (§13.4). */
    conversation_state: threadConversationStateSchema,
    safety_state: threadSafetyStateSchema,
    reason: z.string().max(500).optional(),
  })
  .strict();

/**
 * §13.5 — the contribution create op.  WS-G PARITY: the per-type body cap is
 * `CONTRIBUTION_BODY_LIMITS[contribution_type]` (the shared constant) and
 * evidence/correction citation rules mirror the shipped server schema exactly.
 */
export const contributionCreateOpSchema = z
  .object({
    type: z.literal('contribution.create'),
    contribution_id: privateIdSchema,
    thread_id: privateIdSchema,
    contribution_type: contributionTypeSchema,
    body_markdown_lite: z.string().default(''),
    citations: z.array(citationSchema).max(MAX_CITATIONS).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
    target_claim_id: privateIdSchema.optional(),
    parent_contribution_id: privateIdSchema.optional(),
    lens_id: privateIdSchema.optional(),
    attachment_refs: z.array(privateCidSchema).max(4).optional(),
    client_draft_id: z.string().min(1).max(128),
  })
  .strict()
  .superRefine((v, ctx) => {
    const type = v.contribution_type as ContributionType;
    const cap = CONTRIBUTION_BODY_LIMITS[type];
    const body = v.body_markdown_lite.trim();
    if (body.length > cap) {
      ctx.addIssue({
        code: 'custom',
        path: ['body_markdown_lite'],
        message: `Maximum length is ${cap} characters.`,
      });
    }
    const hasAttachment = (v.attachment_refs?.length ?? 0) > 0;
    if (type === 'comment') {
      // WS-T comment-first: body OR at least one attachment is required.
      if (body.length === 0 && !hasAttachment) {
        ctx.addIssue({
          code: 'custom',
          path: ['body_markdown_lite'],
          message: 'Comment text or at least one attachment is required.',
        });
      }
    } else if (body.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['body_markdown_lite'],
        message: 'Body text is required.',
      });
    }
    if (type === 'evidence') {
      if (v.citations.length < 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['citations'],
          message: 'Evidence contributions require at least one citation.',
        });
      }
      if (v.target_claim_id === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['target_claim_id'],
          message: 'Evidence contributions require a target claim.',
        });
      }
    }
    if (type === 'correction') {
      if (v.citations.length < 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['citations'],
          message: 'Corrections require at least one supporting citation.',
        });
      }
      if (v.citations.length > 5) {
        ctx.addIssue({
          code: 'custom',
          path: ['citations'],
          message: 'Corrections take at most five supporting citations.',
        });
      }
      if (v.target_claim_id === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['target_claim_id'],
          message: 'Corrections require a target claim.',
        });
      }
    }
  });

export const contributionEditOpSchema = z
  .object({
    type: z.literal('contribution.edit'),
    contribution_id: privateIdSchema,
    // An edit op carries no `contribution_type` (only the id), so the per-type
    // cap is the reducer's (WS-S.5.3c) against the known type from state.  The
    // schema-level bound mirrors the WS-G server edit schema EXACTLY — the
    // shared `CONTRIBUTION_BODY_LIMITS.comment` (the max across all types), never
    // a literal, so the two can never drift (the card's stated contract).
    body_markdown_lite: z.string().max(CONTRIBUTION_BODY_LIMITS.comment).optional(),
    citations: z.array(citationSchema).max(MAX_CITATIONS).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const contributionTombstoneOpSchema = z
  .object({
    type: z.literal('contribution.tombstone'),
    contribution_id: privateIdSchema,
    reason: z.string().max(500).optional(),
  })
  .strict();

export const summaryCreateOpSchema = z
  .object({
    type: z.literal('summary.create'),
    summary_id: privateIdSchema,
    thread_id: privateIdSchema,
    body_markdown_lite: z.string().trim().min(1).max(5_000),
    cited_contribution_ids: z.array(privateIdSchema).max(100).default([]),
    uncertainty_note: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export const attachmentAddOpSchema = z
  .object({
    type: z.literal('attachment.add'),
    attachment_id: privateIdSchema,
    /** The CID of the ENCRYPTED attachment manifest (§13.6). */
    manifest_cid: privateCidSchema,
    /** The attachment object key WRAPPED under the epoch `content_wrap_key`
     *  (§10.5).  Distributed WITH the manifest reference so any member can unwrap
     *  it + open the sealed manifest/chunks — without it a peer can fetch the
     *  manifest CID but holds no key material to decrypt it. */
    wrapped_object_key: base64UrlSchema,
  })
  .strict();

/** §14.5 — a snapshot is a trusted-only-after-verification optimization hint. */
export const snapshotCommitOpSchema = z
  .object({
    type: z.literal('snapshot.commit'),
    snapshot_id: privateIdSchema,
    /** The op heads this snapshot includes up to. */
    includes_ops_up_to: z.array(privateIdSchema).min(1).max(4_096),
    state_merkle_root: base64UrlSchema,
    /** The CID of the encrypted snapshot body. */
    snapshot_body_cid: privateCidSchema,
  })
  .strict();

/** The §13.2 op-body discriminated union (every op type, by `type`). */
export const privateOpBodySchema = z.discriminatedUnion('type', [
  memberAddOpSchema,
  memberRemoveOpSchema,
  deviceRemoveOpSchema,
  roleGrantOpSchema,
  roleRevokeOpSchema,
  memberInviteCreateOpSchema,
  recoveryAuthorizeOpSchema,
  storyCreateOpSchema,
  storyEditOpSchema,
  storyTombstoneOpSchema,
  threadStateOpSchema,
  contributionCreateOpSchema,
  contributionEditOpSchema,
  contributionTombstoneOpSchema,
  summaryCreateOpSchema,
  attachmentAddOpSchema,
  snapshotCommitOpSchema,
]);
export type PrivateOpBody = z.infer<typeof privateOpBodySchema>;

/**
 * §13.2 — `PrivateRoomOpPlainV1`: the decrypted operation envelope.  `lamport`
 * is a DECIMAL STRING (exact beyond 2^53, §14.3.1); `parents` are the causal
 * predecessor op ids.  `.strict()`: unknown fields reject; forward compat by
 * schema bump.
 */
export const privateRoomOpSchema = z
  .object({
    schema: z.literal('licio.private.op.v1'),
    room_id: privateIdSchema,
    epoch: z.number().int().min(0),
    op_id: privateIdSchema,
    author_member_id: privateIdSchema,
    author_device_id: privateIdSchema,
    author_seq: z.number().int().min(0),
    created_at: z.string().min(1).max(64),
    created_at_bucket: timeBucketSchema,
    lamport: lamportSchema,
    parents: z.array(privateIdSchema).max(64),
    body: privateOpBodySchema,
  })
  .strict();
export type PrivateRoomOp = z.infer<typeof privateRoomOpSchema>;
