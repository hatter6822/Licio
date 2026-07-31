// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical contribution contracts (WS-T, SPEC §15.1/§22.1/§23.3).
// The comment-first taxonomy is exactly TWO types — `comment` (sourcing rides
// its citations) and `correction` (a sourced challenge) — and there is no
// "react/like/vote" type anywhere (no-applause doctrine, SIGNAL_MATRIX).  One
// discriminated union drives BOTH the Hono BFF validation and the client
// composer, so the per-type required-field rules cannot drift.  The nine
// WS-G-era types (question/answer/synthesis/counterexample/explanation/
// local_context/direct_experience/moderation_concern/meta_discussion) were
// retired by the SPEC §15.1 doctrine and REMOVED outright — no production row
// ever carried them (migration 0076 maps stray dev rows to comments), and
// moderation concerns live in the §18.4 report flow.
//
// Field-name canon: per-type structured fields live in the `metadata` JSONB
// column at rest; the CREATE wire is flat per branch and the server assembles
// `metadata` from the designated fields.
import { z } from 'zod';
import { isModerationReasonCode } from '../constants/moderation.js';
import { MAX_URL_LENGTH } from '../utils/url.js';
import { httpUrlSchema, isoTimestampSchema, uuidSchema } from './common.js';

// ---------------------------------------------------------------------------
// The fixed contribution taxonomy (SPEC §15.1; order is the registry order).
// ---------------------------------------------------------------------------

export const CONTRIBUTION_TYPES = ['comment', 'correction'] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];
export const contributionTypeSchema = z.enum(CONTRIBUTION_TYPES);

/** Per-type body caps — the WS-T composer limits, enforced server-side too. */
export const CONTRIBUTION_BODY_LIMITS: Readonly<Record<ContributionType, number>> = {
  comment: 5_000,
  correction: 2_000,
};

/**
 * Wire bound for a body: the largest per-type cap, DERIVED rather than
 * restated.  The coarse outer bound the update/public schemas carry (the exact
 * per-type cap is re-checked server-side against the STORED type), so a literal
 * here would 422 an edit and fail the read-side parse of a body the create
 * schema had just accepted.  `Object.values` over the
 * `Record<ContributionType, number>` means adding a type — or raising
 * `correction` above `comment` — cannot leave the maximum stale.  Declared here
 * rather than beside the schemas that use it because `contributionUpdateSchema`
 * evaluates its initializer at module-evaluation time and would otherwise hit
 * the `const` TDZ.
 */
export const MAX_CONTRIBUTION_BODY_WIRE_LENGTH = Math.max(
  ...Object.values(CONTRIBUTION_BODY_LIMITS),
);

/** Moderation lifecycle of a contribution (WS-G.1.2a; auditable, WS-J). */
export const CONTRIBUTION_MODERATION_STATES = [
  'published',
  'under_review',
  'hidden',
  'removed',
] as const;
export type ContributionModerationState = (typeof CONTRIBUTION_MODERATION_STATES)[number];
export const contributionModerationStateSchema = z.enum(CONTRIBUTION_MODERATION_STATES);

/**
 * Dispute posture of a contribution (the sourced-correction debate outcome).
 * ORTHOGONAL to `moderation_state`: an `incorrect` contribution stays fully
 * VISIBLE (it is not hidden/removed) but sinks to the bottom of its comment
 * section and carries an "incorrect" tag — the transparency remedy, never a
 * tombstone.  `under_debate` means an open debate arena is challenging it
 * ("Challenged").  `validated` means a challenge was raised and the debate
 * UPHELD the content — challenged and proven accurate ("Validated"); it carries
 * no penalty (a positive signal, never applause) and remains re-challengeable if
 * new evidence emerges.  An inconclusive verdict clears back to `none`.
 */
export const CONTRIBUTION_DISPUTE_STATES = [
  'none',
  'under_debate',
  'incorrect',
  'validated',
] as const;
export type ContributionDisputeStatus = (typeof CONTRIBUTION_DISPUTE_STATES)[number];
export const contributionDisputeStatusSchema = z.enum(CONTRIBUTION_DISPUTE_STATES);

/** Maximum tree depth (WS-G.1.2d-1).  Roots are depth 0; a parent at depth
 *  MAX yields a child at MAX+1 → rejected. */
export const MAX_CONTRIBUTION_DEPTH = 10;

/**
 * WS-A.1.2 reason codes — EXACT membership in the 51 ratified codes (incl.
 * the 15 crypto-abuse codes).  Stricter than the events-pipeline
 * `moderationReasonCodeSchema`, which validates shape + core-category
 * namespace only.
 */
export const contributionReasonCodeSchema = z
  .string()
  .refine(isModerationReasonCode, { message: 'reason_code must be a ratified WS-A.1.2 code' });

// ---------------------------------------------------------------------------
// Citations (WS-G.1.2c CitationSchema).
// ---------------------------------------------------------------------------

const DOI_PATTERN = /^doi:10\.\d{4,9}\/\S{1,200}$/i;

/** http(s) URL or `doi:10.…` reference; dangerous schemes cannot parse. */
export const citationUrlSchema = z
  .string()
  .min(1)
  .max(MAX_URL_LENGTH)
  .refine((value) => DOI_PATTERN.test(value) || /^https?:\/\/\S+$/i.test(value), {
    message: 'Citation must be an http(s) URL or a doi: reference',
  });

export const citationSchema = z
  .object({
    url: citationUrlSchema,
    title: z.string().min(1).max(300).optional(),
    accessed_at: isoTimestampSchema.optional(),
    archive_url: httpUrlSchema.optional(),
  })
  .strict();
export type Citation = z.infer<typeof citationSchema>;

/** Global per-contribution citation bound (corrections are tighter: ≤ 5). */
export const MAX_CITATIONS = 10;

// ---------------------------------------------------------------------------
// Create — discriminated union on `type` (WS-G.1.2c), one branch per type,
// each encoding the WS-G.1.2b required/optional rules with SPECIFIC errors.
// ---------------------------------------------------------------------------

function bodySchema(type: ContributionType, requiredMessage: string) {
  return z
    .string()
    .trim()
    .min(1, requiredMessage)
    .max(
      CONTRIBUTION_BODY_LIMITS[type],
      `Maximum length is ${CONTRIBUTION_BODY_LIMITS[type]} characters.`,
    );
}

/** Fields shared by every create branch. */
const createBaseShape = {
  thread_id: uuidSchema,
  /** Client-generated idempotency key (offline draft id; server dedup, WS-G.3.1). */
  client_draft_id: z.string().min(1).max(128),
  /** General tree nesting (WS-G.1.2d-1: same-thread parent, depth ≤ 10). */
  parent_contribution_id: uuidSchema.optional(),
  /** Optional interpretation context (validated against the thread's room). */
  lens_id: uuidSchema.optional(),
  /** Uploaded attachments (WS-G.3.7b); stored in metadata.attachment_ids. */
  attachment_ids: z.array(uuidSchema).max(4).optional(),
} as const;

export const commentCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('comment'),
    body: z.string().trim().max(CONTRIBUTION_BODY_LIMITS.comment).optional().default(''),
    /**
     * Attached source links (WS-T sourced comments).  OPTIONAL — a comment may
     * carry none — but a sourced comment counts as strictly greater
     * participation than an unsourced one (the PWAtt citation weight).  Never a
     * requirement on a plain comment (availability > friction); the composer
     * simply encourages it.
     */
    citations: z.array(citationSchema).max(MAX_CITATIONS).optional(),
  })
  .strict()
  .transform((value) => ({ ...value, body: value.body.trim() }))
  .superRefine((value, ctx) => {
    const hasBody = value.body.length > 0;
    const hasMedia = (value.attachment_ids?.length ?? 0) > 0;
    if (!hasBody && !hasMedia) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'Comment text or at least one attachment is required.',
      });
    }
  });
export type CommentCreate = z.infer<typeof commentCreateSchema>;

/**
 * A correction is a sourced challenge to a specific comment or to the story
 * root.  It MUST carry at least one supporting citation (a source is
 * mandatory — the whole point) and MUST target EXACTLY ONE of a comment
 * (`target_contribution_id`, same thread) or the story (`target_story_id`).
 * A successful correction opens a live debate arena; the target's author is
 * the incumbent, the correction's author the challenger.  `target_claim_id`
 * stays as an OPTIONAL extra linkage to a specific claim, never the primary
 * target (WS-T corrections retarget from claims to comments/stories).
 */
export const correctionCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('correction'),
    body: bodySchema('correction', 'Correction text is required.'),
    /** The challenged comment (in the same thread). */
    target_contribution_id: uuidSchema.optional(),
    /** The challenged story root (the correction targets the story itself). */
    target_story_id: uuidSchema.optional(),
    /** Optional additional linkage to a specific claim (context, not the target). */
    target_claim_id: uuidSchema.optional(),
    citations: z
      .array(citationSchema)
      .min(1, 'Corrections require at least one supporting source.')
      .max(5, 'Corrections take at most five supporting sources.'),
    target_text_excerpt: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const targets = [value.target_contribution_id, value.target_story_id].filter(
      (id): id is string => id !== undefined,
    );
    if (targets.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['target_contribution_id'],
        message: 'A correction must target exactly one comment or story.',
      });
    }
  });

/** THE create contract (WS-T.1.2b).  Sourcing is comment-centric: a comment
 *  carries its sources as `citations` (inline links). */
export const contributionWriteCreateSchema = z.discriminatedUnion('type', [
  commentCreateSchema,
  correctionCreateSchema,
]);
export type ContributionWriteCreate = z.infer<typeof contributionWriteCreateSchema>;

/** The single create union (the WS-G-era eleven-type union is gone). */
export const contributionCreateSchema = contributionWriteCreateSchema;
export type ContributionCreate = ContributionWriteCreate;

// ---------------------------------------------------------------------------
// Update — body/citations only; `type` AND structured metadata are
// structurally absent, so both are immutable (WS-G.1.2c compile-time
// guarantee).  Changing metadata is a NEW contribution, not an edit; the
// `.strict()` schema below rejects any metadata key with a 422.  Per-type body
// caps are re-validated server-side against the stored type.
// ---------------------------------------------------------------------------

export const contributionUpdateSchema = z
  .object({
    contribution_id: uuidSchema,
    body: z.string().trim().min(1).max(MAX_CONTRIBUTION_BODY_WIRE_LENGTH).optional(),
    citations: z.array(citationSchema).max(MAX_CITATIONS).optional(),
  })
  .strict();
export type ContributionUpdate = z.infer<typeof contributionUpdateSchema>;

// ---------------------------------------------------------------------------
// Public projection (WS-G.1.2c ContributionPublic).
// ---------------------------------------------------------------------------

/** The canonical metadata object at rest (all fields optional; strict). */
export const contributionMetadataSchema = z
  .object({
    target_text_excerpt: z.string().min(1).max(500).optional(),
    target_contribution_id: uuidSchema.optional(),
    /** A correction that targets the story root (rather than a comment). */
    target_story_id: uuidSchema.optional(),
    /** The debate arena a correction opened (back-reference for the challenger). */
    debate_arena_id: uuidSchema.optional(),
    attachment_ids: z.array(uuidSchema).max(4).optional(),
    lens_id: uuidSchema.optional(),
  })
  .strict();
export type ContributionMetadata = z.infer<typeof contributionMetadataSchema>;

export const contributionMediaSchema = z
  .object({
    upload_id: uuidSchema,
    url: z.string().min(1).max(512),
    kind: z.enum(['image']),
    content_type: z.string().min(1).max(128),
    alt_text: z.string().min(1).max(500),
    animatable: z.boolean(),
    /** Intrinsic pixel dimensions, so the renderer can reserve the box BEFORE
     *  the bytes arrive (the CLS half of WS-G.4.2b).  Both present or both
     *  absent — the upload row stores them that way — and absent means UNKNOWN,
     *  never a default: reserving a guess moves the layout twice instead of
     *  once.  The upload response has always carried them; the projection that
     *  serves the comment did not, so the fix stopped at the composer preview
     *  and the posted image still reflowed the thread. */
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();
export type ContributionMedia = z.infer<typeof contributionMediaSchema>;

export const contributionPublicSchema = z
  .object({
    contribution_id: uuidSchema,
    thread_id: uuidSchema,
    type: contributionTypeSchema,
    /** Raw Markdown-lite (rendered client-side via renderUGC, WS-G.4.2b).
     *  Empty for tombstoned (hidden/removed) placeholders. */
    body: z.string().max(MAX_CONTRIBUTION_BODY_WIRE_LENGTH),
    citations: z.array(citationSchema).max(MAX_CITATIONS),
    metadata: contributionMetadataSchema,
    target_claim_id: uuidSchema.nullable(),
    parent_contribution_id: uuidSchema.nullable(),
    /** Null when the author's account was deleted (tombstone, WS-G.1.2a). */
    author_handle: z.string().min(1).nullable(),
    author_display_name: z.string().min(1).nullable(),
    /** True when the requesting session authored this contribution. */
    is_author: z.boolean(),
    depth: z.number().int().min(0).max(MAX_CONTRIBUTION_DEPTH),
    child_count: z.number().int().min(0),
    moderation_state: contributionModerationStateSchema,
    /** Dispute posture (default `none`).  `incorrect` stays visible-but-sunk. */
    dispute_status: contributionDisputeStatusSchema.default('none'),
    /** WS-T — the content prevailed in enough sourced debates (the settle
     *  threshold, SPEC §15.4) that it can no longer be challenged.  A PRESENCE
     *  marker: emitted only when TRUE (never `false`), so a pre-settle cached
     *  bundle validating against a schema without this key keeps parsing every
     *  response that carries no settled row.  Always co-occurs with
     *  `dispute_status: 'validated'` — only an upheld defense settles.  A
     *  content-integrity terminal, never a popularity count. */
    dispute_settled: z.boolean().optional(),
    /** The open debate arena challenging this contribution, if any. */
    active_debate_id: uuidSchema.nullable().default(null),
    /** WS-T — true only for a STORY-target correction that is the story's
     *  CURRENT challenge: live (arena open) or prevailed (story `incorrect`).
     *  Absent/false for a comment, a non-challenge, or a settled
     *  inconclusive/withdrawn story challenge, so the UI renders those as a
     *  closed challenge rather than an active one. */
    story_challenge_active: z.boolean().optional(),
    edited: z.boolean(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    media: z.array(contributionMediaSchema).max(4).optional(),
  })
  .strict();
export type ContributionPublic = z.infer<typeof contributionPublicSchema>;

/** Anchor resolution for deep links (WS-G.3.3 semantic anchoring). */
export const contributionAnchorSchema = z
  .object({
    contribution_id: uuidSchema,
    thread_id: uuidSchema,
    /** The subtree root whose page contains the contribution. */
    root_contribution_id: uuidSchema,
  })
  .strict();
export type ContributionAnchor = z.infer<typeof contributionAnchorSchema>;

export type CommentItem = ContributionPublic & {
  replies: CommentItem[];
  reply_count: number;
  has_more_replies: boolean;
};
export const commentItemSchema: z.ZodType<CommentItem> = contributionPublicSchema.extend({
  replies: z.lazy(() => z.array(commentItemSchema)),
  reply_count: z.number().int().min(0),
  has_more_replies: z.boolean(),
});

// ---------------------------------------------------------------------------
// Reports (SPEC §23.2 /reports — §18.4 report mechanism).
//
// The canonical report contract now lives in `moderation-api.ts` (WS-J.1.1a):
// it is taxonomy-bound (`reason_code`) and returns a `report_id`/severity/
// routing.  The WS-C-era free-text stub that lived here was replaced when WS-J
// took ownership of the report mechanism (the offline-queue idempotency key
// `local_operation_id` carried forward into the new contract).
// ---------------------------------------------------------------------------
