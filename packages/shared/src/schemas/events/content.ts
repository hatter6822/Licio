// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Content lifecycle events (WS-E.1.1a, SPEC §21.3/§14.1/§14.5). A content
// event describes what an author submitted; strict parsing prevents a buggy or
// malicious client from smuggling extra fields (e.g. raw URLs of off-app
// browsing) into a registered topic.
//
// WS-Q.1.7c — content events carry the home `room_id` and the item
// `visibility`, and the privacy CLASSIFICATION TRACKS that visibility:
//   • `public`   content → `privacy_classification: 'public'`   (unchanged)
//   • `room_only` content → `privacy_classification: 'restricted'`
// The coupling is enforced structurally by `superRefine` so a buggy emitter
// can never label an in-room submission `public`; combined with the router's
// per-event classification routing (events/router.ts), an in-room story's
// URL/topics/submitter never flow to a consumer that treats the event as
// public, while the visibility-aware internal consumers (extraction, search,
// embeddings) hold `restricted` access and receive both tiers, honoring the
// room read bar. Retention stays `public_contribution` for both tiers — a
// room_only post is still a first-party contribution, retained until deleted.
import { z } from 'zod';
import { httpUrlSchema, uuidSchema } from '../common.js';
import { eventBaseShape } from './envelope.js';

/** The eight submission types (SPEC §14.1; WS-Q.1.3c added the two media types). */
export const SUBMISSION_TYPES = [
  'link',
  'original_brief',
  'question',
  'evidence_card',
  'local_update',
  'live_thread',
  // WS-Q.1.3c — native media posts (appended; existing values keep their order
  // so the DB enum `ADD VALUE`s line up).
  'image_post',
  'video_post',
] as const;
export type SubmissionType = (typeof SUBMISSION_TYPES)[number];
export const submissionTypeSchema = z.enum(SUBMISSION_TYPES);

/**
 * Item-level content visibility (SPEC §14.5; WS-Q). Defined here — alongside
 * the submission-type SSOT the events layer needs — and re-exported from
 * `story.ts` to avoid an import cycle (story.ts already re-exports SUBMISSION_TYPES).
 *   • `public`    — visible on global surfaces (only ever set in a public room).
 *   • `room_only` — visible only inside the home room, behind the read bar.
 */
export const STORY_VISIBILITIES = ['public', 'room_only'] as const;
export type StoryVisibility = (typeof STORY_VISIBILITIES)[number];
export const storyVisibilitySchema = z.enum(STORY_VISIBILITIES);

/**
 * The privacy classification a content event MUST carry for a given item
 * visibility (WS-Q.1.7c). Emitters compute the event's classification through
 * this single helper so producer and the structural coupling never drift.
 */
export function contentEventClassification(visibility: StoryVisibility): 'public' | 'restricted' {
  return visibility === 'public' ? 'public' : 'restricted';
}

/** Fields shared by `content.submitted` and `content.normalized`. */
const contentShape = {
  ...eventBaseShape,
  story_id: uuidSchema,
  /** The submitting user. */
  submitted_by: uuidSchema,
  submission_type: submissionTypeSchema,
  /** Canonical URL for link stories; null for original/media content. */
  canonical_url: httpUrlSchema.nullable(),
  topic_ids: z.array(z.string().min(1).max(64)).max(20),
  /** WS-Q.1.7c — the home room every content item belongs to (§3.4). */
  room_id: uuidSchema,
  /** WS-Q.1.7c — item visibility; couples to `privacy_classification`. */
  visibility: storyVisibilitySchema,
  /** Public content is `public`; room_only content is the restricted
   *  first-party tier (coupling enforced by superRefine below). */
  privacy_classification: z.enum(['public', 'restricted']),
  retention_tier: z.literal('public_contribution'),
} as const;

/**
 * WS-Q.1.7c coupling refinement: a content event's classification MUST match
 * its visibility (public⟺public, room_only⟺restricted). zod v4's
 * discriminatedUnion accepts refined object members, so the registry union
 * still parses these by `event_type` while the coupling is structural.
 */
function coupleVisibilityClassification(
  value: { visibility: StoryVisibility; privacy_classification: 'public' | 'restricted' },
  ctx: z.RefinementCtx,
): void {
  const expected = contentEventClassification(value.visibility);
  if (value.privacy_classification !== expected) {
    ctx.addIssue({
      code: 'custom',
      message: `content visibility "${value.visibility}" requires privacy_classification "${expected}"`,
      path: ['privacy_classification'],
    });
  }
}

/** Emitted when a user submits a story via `POST /v1/stories` (SPEC §23.2). */
export const contentSubmittedEventSchema = z
  .object({
    ...contentShape,
    event_type: z.literal('content.submitted'),
  })
  .strict()
  .superRefine(coupleVisibilityClassification);
export type ContentSubmittedEvent = z.infer<typeof contentSubmittedEventSchema>;

/**
 * Emitted after ingestion-pipeline processing (SPEC §14.2): all submission
 * fields plus the normalization outputs (source resolution, language,
 * sensitivity labels, dedup grouping, extracted claims, embedding reference).
 */
export const contentNormalizedEventSchema = z
  .object({
    ...contentShape,
    event_type: z.literal('content.normalized'),
    /**
     * Resolved source profile (WS-F.2.2a). Null for non-link submission types
     * (original brief, question, local update, live thread, media): the author
     * IS the submitter and no web source exists to resolve — normalization
     * still runs (language, sensitivity, claims) and still emits this event.
     */
    source_id: uuidSchema.nullable(),
    /** BCP-47 language tag of the normalized content. */
    language: z.string().min(2).max(35),
    sensitivity_labels: z.array(z.string().min(1).max(64)).max(20),
    /** Duplicate group when MERI/dedup linked this story to earlier copies. */
    duplicate_group_id: uuidSchema.nullable(),
    /** Claims extracted by the ingestion pipeline (candidate claim list). */
    claim_ids: z.array(uuidSchema).max(100),
    /** Opaque reference to the stored embedding; null when not computed. */
    embedding_ref: z.string().min(1).max(256).nullable(),
  })
  .strict()
  .superRefine(coupleVisibilityClassification);
export type ContentNormalizedEvent = z.infer<typeof contentNormalizedEventSchema>;

/** What triggered a content-visibility transition (WS-Q.1.7a). */
export const CONTENT_VISIBILITY_TRIGGERS = [
  'author',
  'room_visibility_change',
  'migration',
] as const;
export type ContentVisibilityTrigger = (typeof CONTENT_VISIBILITY_TRIGGERS)[number];
export const contentVisibilityTriggerSchema = z.enum(CONTENT_VISIBILITY_TRIGGERS);

/**
 * Emitted on an actual content-visibility transition (WS-Q.1.7a, SPEC §14.5.2):
 * author narrow/widen, a room public⇄private cascade, or the migration backfill.
 * It carries the story/room ids and the from/to visibilities (NOT the content
 * metadata), so it is classified `public` — it never discloses a room_only
 * story's URL/topics/submitter. Retention rides the content tier.
 */
export const contentVisibilityChangedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('content.visibility.changed'),
    story_id: uuidSchema,
    room_id: uuidSchema,
    from: storyVisibilitySchema,
    to: storyVisibilitySchema,
    trigger: contentVisibilityTriggerSchema,
    /** The acting user (author/steward); null for migration/system triggers. */
    actor_ref: uuidSchema.nullable(),
    privacy_classification: z.literal('public'),
    retention_tier: z.literal('public_contribution'),
  })
  .strict();
export type ContentVisibilityChangedEvent = z.infer<typeof contentVisibilityChangedEventSchema>;
