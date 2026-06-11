// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story wire contracts (WS-F.1.1b / WS-F.1.4b, SPEC §14.1/§22.1/§23.1).
// Runtime zod schemas co-located with the route types so compile-time and
// runtime contracts cannot diverge: the per-type submission payload is ONE
// discriminated union (`submissionMetadataSchema`) reused by the create
// request, the stored `submission_metadata` JSONB, and the client. Every
// member is `.strict()` — unknown keys are REJECTED at the boundary (a buggy
// or malicious client cannot smuggle fields downstream consumers might trust).
//
// `StoryPublic` is the ONLY story shape read endpoints return: internal
// extraction diagnostics, review flags, and moderation state never reach the
// wire (WS-F.1.1b security consideration).
import { z } from 'zod';
import { STORY_LIFECYCLE_STATES, type StoryLifecycleState } from '../utils/story-lifecycle.js';
import { httpUrlSchema, isoTimestampSchema, uuidSchema } from './common.js';
import { SUBMISSION_TYPES, submissionTypeSchema } from './events/content.js';

export { SUBMISSION_TYPES, submissionTypeSchema };
export const storyLifecycleStateSchema = z.enum(STORY_LIFECYCLE_STATES);
export type { StoryLifecycleState };

/** Sensitivity labels (SPEC §14.2 classification; content warnings + age gating). */
export const SENSITIVITY_LABELS = ['none', 'graphic', 'medical', 'political', 'crisis'] as const;
export type SensitivityLabel = (typeof SENSITIVITY_LABELS)[number];
export const sensitivityLabelSchema = z.enum(SENSITIVITY_LABELS);

/** Primary media types extractable from a linked document (WS-F.1.4e). */
export const MEDIA_TYPES = [
  'article',
  'video',
  'podcast',
  'dataset',
  'report',
  'document',
  'image',
] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const mediaTypeSchema = z.enum(MEDIA_TYPES);

/**
 * Structured CONTENT location (WS-F.1.1a) — where a news event happened, a
 * property of the event, never of the reader (SPEC §19.1: no reader
 * geolocation exists anywhere in the system). For `global` the value is the
 * literal `'global'` by convention.
 */
export const locationScopeSchema = z
  .object({
    type: z.enum(['global', 'country', 'region', 'city']),
    value: z.string().min(1).max(120),
  })
  .strict();
export type LocationScope = z.infer<typeof locationScopeSchema>;

/**
 * BCP 47 language tag — a strict practical subset of the RFC 5646 grammar:
 * `language(2-3) ["-" script(4)] ["-" region(2 alpha | 3 digit)]
 * ["-" variant(5-8 alnum | digit+3 alnum)]*`. Accepts `en`, `pt-BR`,
 * `zh-Hans`, `sr-Latn-RS`, `es-419`, `de-CH-1996`; rejects `english`,
 * `en_US`, bare digits, and empty/oversized tags. Case-insensitive per the
 * RFC; {@link canonicalizeBcp47} applies the conventional casing.
 */
const BCP47_PATTERN =
  /^[a-zA-Z]{2,3}(-[a-zA-Z]{4})?(-(?:[a-zA-Z]{2}|[0-9]{3}))?(-(?:[a-zA-Z0-9]{5,8}|[0-9][a-zA-Z0-9]{3}))*$/;
export const bcp47Schema = z
  .string()
  .min(2)
  .max(35)
  .regex(BCP47_PATTERN, { message: 'must be a valid BCP 47 language tag' });

/** Conventional BCP 47 casing: language lower, script Title, region UPPER. */
export function canonicalizeBcp47(tag: string): string {
  return tag
    .split('-')
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (part.length === 4 && /^[a-zA-Z]+$/.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      if (part.length === 2 && /^[a-zA-Z]+$/.test(part)) return part.toUpperCase();
      return part.toLowerCase();
    })
    .join('-');
}

// ---------------------------------------------------------------------------
// Per-type submission metadata (WS-F.1.4b) — the canonical §14.1 payloads.
// These exact objects are stored as `story.submission_metadata`, so the
// discriminated union is the single runtime definition of that JSONB shape.
// ---------------------------------------------------------------------------

export const linkMetadataSchema = z
  .object({
    submission_type: z.literal('link'),
    url: httpUrlSchema.max(2048),
    /** Short reason for submission (§14.1). */
    reason: z.string().min(1).max(500),
  })
  .strict();

export const originalBriefMetadataSchema = z
  .object({
    submission_type: z.literal('original_brief'),
    body: z.string().min(1).max(20_000),
    /** Disclosure if the brief reports personal experience (§14.1). */
    personal_experience_disclosure: z.boolean().optional(),
  })
  .strict();

export const questionMetadataSchema = z
  .object({
    submission_type: z.literal('question'),
    question: z.string().min(1).max(2_000),
    context: z.string().min(1).max(4_000).optional(),
  })
  .strict();

export const evidenceCardMetadataSchema = z
  .object({
    submission_type: z.literal('evidence_card'),
    /** Citation URL or a structured reference (book, filing, dataset id). */
    citation_url_or_ref: z.string().min(1).max(2048),
    /** Must reference an EXISTING claim — validated server-side (WS-F.1.2a). */
    claim_id: uuidSchema,
    relevance_note: z.string().min(1).max(2_000),
  })
  .strict();

export const localUpdateMetadataSchema = z
  .object({
    submission_type: z.literal('local_update'),
    location_scope: locationScopeSchema,
    time_reference: z.string().min(1).max(200).optional(),
    /** Source citation or first-hand experience disclosure (§14.1). */
    source_or_experience_disclosure: z.string().min(1).max(2_000),
  })
  .strict();

export const liveThreadMetadataSchema = z
  .object({
    submission_type: z.literal('live_thread'),
    event_description: z.string().min(1).max(2_000),
    time_reference: z.string().min(1).max(200),
    moderation_mode: z.enum(['standard', 'breaking', 'sensitive']),
  })
  .strict();

/** The §14.1 per-type payload union — stored verbatim as submission_metadata. */
export const submissionMetadataSchema = z.discriminatedUnion('submission_type', [
  linkMetadataSchema,
  originalBriefMetadataSchema,
  questionMetadataSchema,
  evidenceCardMetadataSchema,
  localUpdateMetadataSchema,
  liveThreadMetadataSchema,
]);
export type SubmissionMetadata = z.infer<typeof submissionMetadataSchema>;

// ---------------------------------------------------------------------------
// POST /v1/stories request (WS-F.1.4a) — shared fields + the per-type payload
// in one discriminated union so error messages name the missing field for the
// SUBMITTED type. `.extend()` preserves `.strict()`, so unknown keys are
// still rejected on every member.
// ---------------------------------------------------------------------------

const storyCreateBaseShape = {
  title: z.string().min(1).max(300),
  /** At least one topic (§14.1 requires a topic on every type). */
  topic_ids: z.array(uuidSchema).min(1).max(10),
  language: bcp47Schema.optional(),
  sensitivity_labels: z.array(sensitivityLabelSchema).max(5).optional(),
  location_scope: locationScopeSchema.nullable().optional(),
} as const;

export const storyCreateRequestSchema = z.discriminatedUnion('submission_type', [
  linkMetadataSchema.extend(storyCreateBaseShape),
  originalBriefMetadataSchema.extend(storyCreateBaseShape),
  questionMetadataSchema.extend(storyCreateBaseShape),
  evidenceCardMetadataSchema.extend(storyCreateBaseShape),
  // `location_scope` is REQUIRED for local updates (the base makes it
  // optional, so it is re-tightened after the extend).
  localUpdateMetadataSchema.extend(storyCreateBaseShape).extend({
    location_scope: locationScopeSchema,
  }),
  liveThreadMetadataSchema.extend(storyCreateBaseShape),
]);
export type StoryCreateRequest = z.infer<typeof storyCreateRequestSchema>;

// ---------------------------------------------------------------------------
// Public projection + create response.
// ---------------------------------------------------------------------------

/**
 * The API-safe story projection (WS-F.1.1b): everything a reader may see and
 * NOTHING internal (extraction diagnostics, review/moderation flags, raw
 * fetched text). The `excerpt` is the copyright-bounded display text
 * (WS-F.1.4f) — never the full article body.
 */
export const storyPublicSchema = z
  .object({
    story_id: uuidSchema,
    title: z.string().min(1).max(300),
    submission_type: submissionTypeSchema,
    canonical_url: httpUrlSchema.nullable(),
    source_id: uuidSchema.nullable(),
    submitted_by: uuidSchema,
    language: bcp47Schema.nullable(),
    topic_ids: z.array(uuidSchema).min(1).max(20),
    location_scope: locationScopeSchema.nullable(),
    sensitivity_labels: z.array(sensitivityLabelSchema).max(5),
    lifecycle_state: storyLifecycleStateSchema,
    thread_id: uuidSchema.nullable(),
    /** Copyright-bounded excerpt + attribution (WS-F.1.4f); null until extracted. */
    excerpt: z.string().max(2_000).nullable(),
    publisher: z.string().max(200).nullable(),
    author: z.string().max(200).nullable(),
    published_at: isoTimestampSchema.nullable(),
    media_type: mediaTypeSchema.nullable(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type StoryPublic = z.infer<typeof storyPublicSchema>;

/** Review-context flags surfaced to the SUBMITTER on creation (non-blocking). */
export const submissionReviewFlagSchema = z.enum(['near_duplicate', 'syndicated_copy_candidate']);

/** 201 response for POST /v1/stories (WS-F.1.4a acceptance shape). */
export const storyCreateResponseSchema = z
  .object({
    story: storyPublicSchema,
    story_id: uuidSchema,
    thread_id: uuidSchema,
    lifecycle_state: storyLifecycleStateSchema,
    /**
     * Stories similar to this submission (sync near-duplicate check on the
     * locally available text, WS-F.1.3c): the submitter is informed and can
     * choose to contribute to an existing thread instead. Link stories get a
     * second async check after extraction; those flags route to review.
     */
    similar_story_ids: z.array(uuidSchema).max(10),
    review_flags: z.array(submissionReviewFlagSchema).max(4),
  })
  .strict();
export type StoryCreateResponse = z.infer<typeof storyCreateResponseSchema>;

/** 409 body when the canonical URL already exists (WS-F.1.3b). */
export const storyDuplicateResponseSchema = z
  .object({
    error: z.object({
      code: z.literal('duplicate_story'),
      message: z.string().min(1),
    }),
    /** The existing story — the redirect suggestion for the submitter. */
    existing_story_id: uuidSchema,
  })
  .strict();
export type StoryDuplicateResponse = z.infer<typeof storyDuplicateResponseSchema>;
