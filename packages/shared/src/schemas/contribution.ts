// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical contribution contracts (WS-G.1.2b/c, SPEC §15.1/§22.1/§23.3).
// The comment-first contribution taxonomy — there is no "react/like/vote" type
// anywhere (no-applause doctrine, SIGNAL_MATRIX).  One discriminated union
// drives BOTH the Hono BFF validation and the client composer, so the
// per-type required-field rules cannot drift (WS-G definition of done #2).
//
// Field-name canon (WS-G plan preamble): per-type structured fields live in
// the `metadata` JSONB column at rest; the CREATE wire is flat per branch and
// the server assembles `metadata` from the designated fields.
import { z } from 'zod';
import { isModerationReasonCode } from '../constants/moderation.js';
import { httpUrlSchema, isoTimestampSchema, uuidSchema } from './common.js';

// ---------------------------------------------------------------------------
// The fixed contribution taxonomy (SPEC §15.1; order is the registry order).
// ---------------------------------------------------------------------------

export const CONTRIBUTION_TYPES = [
  'question',
  'answer',
  'correction',
  'synthesis',
  'counterexample',
  'explanation',
  'local_context',
  'direct_experience',
  'moderation_concern',
  'meta_discussion',
  'comment',
] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];
export const contributionTypeSchema = z.enum(CONTRIBUTION_TYPES);

/** Per-type body caps — the WS-G.3.4–3.6 composer limits, enforced server-side too. */
export const CONTRIBUTION_BODY_LIMITS: Readonly<Record<ContributionType, number>> = {
  question: 2_000,
  answer: 3_000,
  correction: 2_000,
  synthesis: 5_000,
  counterexample: 2_000,
  explanation: 3_000,
  local_context: 2_000,
  direct_experience: 2_000,
  moderation_concern: 2_000,
  meta_discussion: 2_000,
  comment: 5_000,
};

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

/** Flag urgency (WS-G.3.4c; `urgent` is reserved for imminent harm). */
export const moderationUrgencySchema = z.enum(['normal', 'urgent']);
export type ModerationUrgency = z.infer<typeof moderationUrgencySchema>;

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
  .max(2048)
  .refine((value) => DOI_PATTERN.test(value) || /^https?:\/\/\S+$/i.test(value), {
    message: 'Citation must be an http(s) URL or a doi: reference',
  });

export const citationSchema = z
  .object({
    url: citationUrlSchema,
    title: z.string().min(1).max(300).optional(),
    accessed_at: isoTimestampSchema.optional(),
    archive_url: httpUrlSchema.max(2048).optional(),
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
  /** General tree nesting (WS-G.1.2d-1: same-thread parent, depth ≤ 10).
   *  `answer` overrides this as REQUIRED (and the parent must be a question). */
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

/** @deprecated WS-T: use commentCreateSchema for new writes. */
export const questionCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('question'),
    body: bodySchema('question', 'Question text is required.'),
    target_claim_id: uuidSchema.optional(),
  })
  .strict();

/** @deprecated WS-T: legacy reads only; not part of contributionWriteCreateSchema. */
export const answerCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('answer'),
    body: bodySchema('answer', 'Answer text is required.'),
    /** Must reference a `question` contribution in the same thread (server-verified). */
    parent_contribution_id: uuidSchema,
    citations: z.array(citationSchema).max(MAX_CITATIONS).optional(),
  })
  .strict();

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

/** @deprecated WS-T: legacy reads only; not part of contributionWriteCreateSchema. */
export const synthesisCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('synthesis'),
    body: bodySchema('synthesis', 'Synthesis text is required.'),
    included_branch_ids: z
      .array(uuidSchema)
      .min(2, 'Synthesis requires at least two branches.')
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Synthesis branches must be distinct.',
      }),
    uncertainty_note: z.string().min(1).max(1_000).optional(),
  })
  .strict();

/** @deprecated WS-T: legacy reads only; not part of contributionWriteCreateSchema. */
export const counterexampleCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('counterexample'),
    body: bodySchema('counterexample', 'Example text is required.'),
    target_claim_id: uuidSchema,
    relevance_explanation: z
      .string()
      .trim()
      .min(1, 'A relevance explanation is required.')
      .max(500),
    source_url: httpUrlSchema.max(2048).optional(),
  })
  .strict();

/** @deprecated WS-T: legacy reads only; not part of contributionWriteCreateSchema. */
export const explanationCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('explanation'),
    body: bodySchema('explanation', 'Explanation text is required.'),
    assumptions: z.string().min(1).max(500).optional(),
    caveats: z.string().min(1).max(500).optional(),
  })
  .strict();

/** @deprecated WS-T: legacy reads only; not part of contributionWriteCreateSchema. */
export const localContextCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('local_context'),
    body: bodySchema('local_context', 'Context text is required.'),
    scope: z.string().trim().min(1, 'Scope is required.').max(200),
    location: z.string().min(1).max(200).optional(),
    time_context: z.string().min(1).max(200).optional(),
  })
  .strict();

/** @deprecated WS-T: legacy reads only; not part of contributionWriteCreateSchema. */
export const directExperienceCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('direct_experience'),
    body: bodySchema('direct_experience', 'Experience text is required.'),
    scope: z.string().trim().min(1, 'Scope is required.').max(200),
    location: z.string().min(1).max(200).optional(),
    time_context: z.string().min(1).max(200).optional(),
    /** The §19 privacy acknowledgment — literally true, or the branch fails. */
    privacy_acknowledged: z.literal(true, {
      message: 'Direct experience requires the privacy acknowledgment.',
    }),
  })
  .strict();

/** @deprecated WS-T: legacy reads only; not part of contributionWriteCreateSchema. */
export const moderationConcernCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('moderation_concern'),
    body: bodySchema('moderation_concern', 'A description of the concern is required.'),
    target_contribution_id: uuidSchema,
    reason_code: contributionReasonCodeSchema,
    urgency: moderationUrgencySchema.optional(),
  })
  .strict();

/** @deprecated WS-T: legacy reads only; not part of contributionWriteCreateSchema. */
export const metaDiscussionCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('meta_discussion'),
    body: bodySchema('meta_discussion', 'Discussion text is required.'),
    target_contribution_id: uuidSchema.optional(),
  })
  .strict();

/** WS-T.1.2b: live create contract; legacy create schemas stay exported for one release.
 *  Sourcing is comment-centric: a comment carries its sources as `citations`
 *  (inline links) — there is no separate evidence contribution type. */
export const contributionWriteCreateSchema = z.discriminatedUnion('type', [
  commentCreateSchema,
  correctionCreateSchema,
]);
export type ContributionWriteCreate = z.infer<typeof contributionWriteCreateSchema>;

/**
 * Back-compat full create contract retained for legacy clients/tests until the
 * WS-T.3.2a route cutover moves the endpoint to contributionWriteCreateSchema.
 * New code MUST use contributionWriteCreateSchema.
 */
export const contributionCreateSchema = z.discriminatedUnion('type', [
  questionCreateSchema,
  answerCreateSchema,
  correctionCreateSchema,
  synthesisCreateSchema,
  counterexampleCreateSchema,
  explanationCreateSchema,
  localContextCreateSchema,
  directExperienceCreateSchema,
  moderationConcernCreateSchema,
  metaDiscussionCreateSchema,
  commentCreateSchema,
]);
export type ContributionCreate = z.infer<typeof contributionCreateSchema>;

// ---------------------------------------------------------------------------
// Update — body/citations/metadata only; `type` is structurally absent so it
// can never change (WS-G.1.2c compile-time guarantee).  Per-type body caps
// and metadata rules are re-validated server-side against the stored type.
// ---------------------------------------------------------------------------

export const contributionUpdateSchema = z
  .object({
    contribution_id: uuidSchema,
    body: z.string().trim().min(1).max(5_000).optional(),
    citations: z.array(citationSchema).max(MAX_CITATIONS).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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
    included_branch_ids: z.array(uuidSchema).max(20).optional(),
    uncertainty_note: z.string().min(1).max(1_000).optional(),
    relevance_explanation: z.string().min(1).max(500).optional(),
    source_url: z.string().min(1).max(2048).optional(),
    assumptions: z.string().min(1).max(500).optional(),
    caveats: z.string().min(1).max(500).optional(),
    scope: z.string().min(1).max(200).optional(),
    location: z.string().min(1).max(200).optional(),
    time_context: z.string().min(1).max(200).optional(),
    privacy_acknowledged: z.literal(true).optional(),
    reason_code: contributionReasonCodeSchema.optional(),
    urgency: moderationUrgencySchema.optional(),
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

/** Wire bound for a body (the largest per-type cap). */
export const MAX_CONTRIBUTION_BODY_WIRE_LENGTH = 5_000;

export const contributionMediaSchema = z
  .object({
    upload_id: uuidSchema,
    url: z.string().min(1).max(512),
    kind: z.enum(['image']),
    content_type: z.string().min(1).max(128),
    alt_text: z.string().min(1).max(500),
    animatable: z.boolean(),
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
    /** The open debate arena challenging this contribution, if any. */
    active_debate_id: uuidSchema.nullable().default(null),
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
