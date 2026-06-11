// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical contribution contracts (WS-G.1.2b/c, SPEC §15.1/§22.1/§23.3).
// The ELEVEN typed contributions — there is no "react/like/vote" type
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
// The fixed 11-member taxonomy (SPEC §15.1; order is the registry order).
// ---------------------------------------------------------------------------

export const CONTRIBUTION_TYPES = [
  'question',
  'answer',
  'evidence',
  'correction',
  'synthesis',
  'counterexample',
  'explanation',
  'local_context',
  'direct_experience',
  'moderation_concern',
  'meta_discussion',
] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];
export const contributionTypeSchema = z.enum(CONTRIBUTION_TYPES);

/** Per-type body caps — the WS-G.3.4–3.6 composer limits, enforced server-side too. */
export const CONTRIBUTION_BODY_LIMITS: Readonly<Record<ContributionType, number>> = {
  question: 2_000,
  answer: 3_000,
  evidence: 500,
  correction: 2_000,
  synthesis: 5_000,
  counterexample: 2_000,
  explanation: 3_000,
  local_context: 2_000,
  direct_experience: 2_000,
  moderation_concern: 2_000,
  meta_discussion: 2_000,
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

export const questionCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('question'),
    body: bodySchema('question', 'Question text is required.'),
    target_claim_id: uuidSchema.optional(),
  })
  .strict();

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

export const evidenceCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('evidence'),
    /** The relevance note (the evidence contribution's body, WS-G.3.5a). */
    body: bodySchema('evidence', 'A relevance note is required.'),
    citations: z
      .array(citationSchema)
      .min(1, 'Evidence contributions require at least one citation.')
      .max(MAX_CITATIONS),
    target_claim_id: uuidSchema,
    /** Evidence-card material type (WS-G.1.3); defaults to `report` at rest. */
    evidence_type: z
      .enum([
        'primary_source',
        'dataset',
        'transcript',
        'legal_text',
        'report',
        'expert_reference',
        'fact_check',
      ])
      .optional(),
  })
  .strict();

export const correctionCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('correction'),
    body: bodySchema('correction', 'Correction text is required.'),
    target_claim_id: uuidSchema,
    citations: z
      .array(citationSchema)
      .min(1, 'Corrections require at least one supporting citation.')
      .max(5, 'Corrections take at most five supporting citations.'),
    target_text_excerpt: z.string().min(1).max(500).optional(),
  })
  .strict();

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

export const explanationCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('explanation'),
    body: bodySchema('explanation', 'Explanation text is required.'),
    assumptions: z.string().min(1).max(500).optional(),
    caveats: z.string().min(1).max(500).optional(),
  })
  .strict();

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

export const metaDiscussionCreateSchema = z
  .object({
    ...createBaseShape,
    type: z.literal('meta_discussion'),
    body: bodySchema('meta_discussion', 'Discussion text is required.'),
    target_contribution_id: uuidSchema.optional(),
  })
  .strict();

/** WS-G.1.2c: the single create contract (11 branches, shared client+server). */
export const contributionCreateSchema = z.discriminatedUnion('type', [
  questionCreateSchema,
  answerCreateSchema,
  evidenceCreateSchema,
  correctionCreateSchema,
  synthesisCreateSchema,
  counterexampleCreateSchema,
  explanationCreateSchema,
  localContextCreateSchema,
  directExperienceCreateSchema,
  moderationConcernCreateSchema,
  metaDiscussionCreateSchema,
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
    evidence_type: z.string().min(1).max(64).optional(),
    /** Co-created evidence card (WS-G.3.2 atomic creation). */
    evidence_id: uuidSchema.optional(),
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
    attachment_ids: z.array(uuidSchema).max(4).optional(),
    lens_id: uuidSchema.optional(),
  })
  .strict();
export type ContributionMetadata = z.infer<typeof contributionMetadataSchema>;

/** Wire bound for a body (the largest per-type cap). */
export const MAX_CONTRIBUTION_BODY_WIRE_LENGTH = 5_000;

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
    edited: z.boolean(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type ContributionPublic = z.infer<typeof contributionPublicSchema>;

/** Anchor resolution for deep links (WS-G.3.3 semantic anchoring). */
export const contributionAnchorSchema = z
  .object({
    contribution_id: uuidSchema,
    thread_id: uuidSchema,
    /** The structured section this contribution renders under. */
    branch: z.enum(['overview', 'questions', 'evidence', 'challenges', 'lenses', 'chronology']),
    /** The subtree root whose page contains the contribution. */
    root_contribution_id: uuidSchema,
  })
  .strict();
export type ContributionAnchor = z.infer<typeof contributionAnchorSchema>;

// ---------------------------------------------------------------------------
// Reports (SPEC §23.2 /reports — §18.4 report mechanism; unchanged contract).
// ---------------------------------------------------------------------------

/** Safety report (SPEC §23.2 /reports; topic moderation.case.created). */
export const createReportRequestSchema = z.object({
  target_type: z.enum(['story', 'thread', 'contribution', 'account']),
  target_id: uuidSchema,
  reason: z.string().min(1).max(2_000),
  local_operation_id: z.string().min(1),
});
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;

/** Acknowledgement that a safety report was received (queued for review). */
export const reportAckSchema = z.object({
  status: z.literal('received'),
  local_operation_id: z.string().min(1),
});
export type ReportAck = z.infer<typeof reportAckSchema>;
