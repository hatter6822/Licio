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
import { isSelectableTopicId, MAX_PROPOSED_TOPICS } from '../constants/topics.js';
import { STORY_LIFECYCLE_STATES, type StoryLifecycleState } from '../utils/story-lifecycle.js';
import { httpUrlSchema, isoTimestampSchema, uuidSchema } from './common.js';

/**
 * An author-PROPOSED topic: it must be a real, selectable catalog topic (never
 * the `UNCLASSIFIED` sentinel, never an off-catalog/random id). This is the
 * trust boundary for author input — the picks land in `proposed_topic_ids`
 * (untrusted) and only enter the story's TRUSTED `topic_ids` once the WS-K
 * validator confirms them against the content (SPEC §14.1/§24.1).
 */
export const proposedTopicIdSchema = z
  .string()
  .refine(isSelectableTopicId, { message: 'not a selectable catalog topic' });

import {
  STORY_VISIBILITIES,
  type StoryVisibility,
  SUBMISSION_TYPES,
  storyVisibilitySchema,
  submissionTypeSchema,
} from './events/content.js';
import type { RoomVisibility } from './room.js';

export type { StoryVisibility };
export { STORY_VISIBILITIES, SUBMISSION_TYPES, storyVisibilitySchema, submissionTypeSchema };
export const storyLifecycleStateSchema = z.enum(STORY_LIFECYCLE_STATES);
export type { StoryLifecycleState };

/**
 * WS-Q.1.3b — the SINGLE Section 14.5 visibility-forcing rule. A `private`
 * room ALWAYS forces `room_only` (silently — never an error, the composer
 * locks the control); a `public` room honors the author's request, defaulting
 * to `public`. This is the ONLY place the rule lives: the server guard
 * (WS-Q.2.1c) and the client composer (WS-Q.5.1b) both call it, so the shown
 * value always equals the stored value (parity-tested).
 */
export function deriveStoryVisibility(
  roomVisibility: RoomVisibility,
  requested?: StoryVisibility,
): StoryVisibility {
  if (roomVisibility === 'private') return 'room_only';
  return requested ?? 'public';
}

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
    url: httpUrlSchema,
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

// WS-Q.1.3c — native media posts. Both reference a previously-uploaded,
// EXIF-stripped, scan-gated object (the WS-G.4.4 upload pipeline) and carry NO
// canonical_url (exempt from URL normalization and crawling). Image posts
// REQUIRE alt text (WCAG); video posts take optional captions as text XOR an
// uploaded track (never both).
export const imageMetadataSchema = z
  .object({
    submission_type: z.literal('image_post'),
    /** The owned, scan-gated image upload this post renders. */
    upload_id: uuidSchema,
    /** REQUIRED accessibility text for the image (WCAG; §15.5). */
    alt_text: z.string().min(1).max(1_000),
  })
  .strict();

/** The video-post shape (reused by the create request after `.extend`). */
const videoMetadataShape = {
  submission_type: z.literal('video_post'),
  /** The owned, scan-gated video upload this post renders. */
  upload_id: uuidSchema,
  /** Optional inline caption text (mutually exclusive with the upload). */
  captions_text: z.string().min(1).max(20_000).optional(),
  /** Optional uploaded WebVTT caption track (mutually exclusive with the text). */
  captions_upload_id: uuidSchema.optional(),
  /** Optional poster image shown before playback (WS-Q.5.2c). */
  poster_upload_id: uuidSchema.optional(),
} as const;

/** captions are text XOR an uploaded track (both optional, never both). */
const captionsExclusive = (v: {
  captions_text?: string | undefined;
  captions_upload_id?: string | undefined;
}): boolean => !(v.captions_text !== undefined && v.captions_upload_id !== undefined);
const captionsExclusiveError: { message: string; path: string[] } = {
  message: 'Provide captions as text OR an uploaded track, not both',
  path: ['captions_text'],
};

export const videoMetadataSchema = z
  .object(videoMetadataShape)
  .strict()
  .refine(captionsExclusive, captionsExclusiveError);

/** The §14.1 per-type payload union — stored verbatim as submission_metadata. */
export const submissionMetadataSchema = z.discriminatedUnion('submission_type', [
  linkMetadataSchema,
  originalBriefMetadataSchema,
  imageMetadataSchema,
  videoMetadataSchema,
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
  /**
   * At least one author-PROPOSED topic (§14.1 requires a topic on every type).
   * These are PROPOSALS, not the story's trusted topics: the server stores
   * them as `proposed_topic_ids` and the WS-K validator decides which become
   * the trusted `topic_ids` (SPEC §24.1). Each must be a selectable catalog
   * topic — the sentinel and off-catalog ids are rejected at the boundary.
   */
  topic_ids: z.array(proposedTopicIdSchema).min(1).max(MAX_PROPOSED_TOPICS),
  language: bcp47Schema.optional(),
  sensitivity_labels: z.array(sensitivityLabelSchema).max(5).optional(),
  location_scope: locationScopeSchema.nullable().optional(),
  // WS-Q.1.3a — every content item is posted in exactly one home room
  // (§3.4): `room_id` is REQUIRED on every branch (the `.extend()` below
  // propagates it to every member). `visibility` is OPTIONAL on input — the
  // server DERIVES it via `deriveStoryVisibility` (a private room forces
  // `room_only`; a public room honors the request, default `public`).
  room_id: uuidSchema,
  visibility: storyVisibilitySchema.optional(),
} as const;

export const storyCreateRequestSchema = z.discriminatedUnion('submission_type', [
  linkMetadataSchema.extend(storyCreateBaseShape),
  originalBriefMetadataSchema.extend(storyCreateBaseShape),
  imageMetadataSchema.extend(storyCreateBaseShape),
  // The video branch is a refined object (captions XOR); `.extend` on a
  // ZodEffects is unavailable, so the base shape is spread before the refine.
  z
    .object({ ...videoMetadataShape, ...storyCreateBaseShape })
    .strict()
    .refine(captionsExclusive, captionsExclusiveError),
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
    /** WS-Q — the home room (NOT NULL) and item visibility (§3.4/§14.5). */
    room_id: uuidSchema,
    visibility: storyVisibilitySchema,
    /** WS-Q.2.3 — the scan-gated media upload (image/video posts); null else.
     *  The client builds the gated read URL from this id; `media_alt_text`
     *  carries the required accessibility text without a second round-trip. */
    media_upload_ref: uuidSchema.nullable(),
    media_alt_text: z.string().max(1_000).nullable(),
    /** WS-Q.2.2b — pointer to the canonical PUBLIC story for the same link,
     *  surfaced to room readers only; null when none / this IS public. */
    canonical_public_story_id: uuidSchema.nullable(),
    submitted_by: uuidSchema,
    language: bcp47Schema.nullable(),
    // Subject topics only — the wire strips the UNCLASSIFIED sentinel, so an
    // unclassified story carries NO topic here (the DB still holds the sentinel,
    // satisfying its own non-empty CHECK). Hence min 0, not 1.
    topic_ids: z.array(uuidSchema).max(20),
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

/** WS-Q.2.4 — PATCH /v1/stories/{id}/visibility request (author narrow/widen). */
export const storyVisibilityPatchRequestSchema = z
  .object({ visibility: storyVisibilitySchema })
  .strict();
export type StoryVisibilityPatchRequest = z.infer<typeof storyVisibilityPatchRequestSchema>;

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
