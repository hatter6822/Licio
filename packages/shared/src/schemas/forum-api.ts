// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Forum endpoint wire contracts (WS-G.3, SPEC §23.2/§23.3): contributions,
// feed preferences, uploads, and the link-safety blocklist.  Validated on
// ingress AND re-validated on egress (the WS-C.1.2 boundary guarantee).
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { commentItemSchema, contributionPublicSchema } from './contribution.js';
import { feedModeCompatSchema } from './feed.js';
import {
  attentionRetentionPreferenceSchema,
  MAX_TOPIC_PREFERENCES,
  privacyNotificationPreferencesSchema,
} from './privacy-settings.js';

// ---------------------------------------------------------------------------
// POST /v1/contributions (WS-G.3.1) — response.
// ---------------------------------------------------------------------------

export const contributionCreateResponseSchema = z
  .object({
    contribution: contributionPublicSchema,
    /** True when this request matched an existing client_draft_id (dedup). */
    deduplicated: z.boolean(),
  })
  .strict();
export type ContributionCreateResponse = z.infer<typeof contributionCreateResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/stories/:storyId/comments (WS-T.3.1b).
// ---------------------------------------------------------------------------

export const storyCommentsResponseSchema = z
  .object({
    comments: z.array(commentItemSchema).max(100),
    next_cursor: z.string().min(1).max(512).nullable(),
    /**
     * WS-T.7.2 focused (rooted) reads only: the comment the page is anchored to,
     * rendered as a read-only context header above its paginated replies (which
     * are `comments`).  Null for the unrooted thread view (story-page section and
     * the dedicated "all comments" page).  `parent_contribution_id` drives the
     * dedicated page's one-level-up breadcrumb.
     */
    anchor: commentItemSchema.nullable().default(null),
    overview: z
      .object({
        comment_count: z.number().int().min(0),
        sources_count: z.number().int().min(0),
        corrections_count: z.number().int().min(0),
        /** Open debate arenas challenging this story's content (display only). */
        debates_count: z.number().int().min(0).default(0),
        /** Contributions tagged `incorrect` by a resolved correction (display only). */
        incorrect_count: z.number().int().min(0).default(0),
      })
      .strict(),
  })
  .strict();
export type StoryCommentsResponse = z.infer<typeof storyCommentsResponseSchema>;

// ---------------------------------------------------------------------------
// GET/PATCH /v1/feed/preferences (WS-G.3.8, SPEC §13/§23.2).  A canonical
// veneer over the WS-D settings stores (single source of truth: the identity
// store's privacy/personalization blobs) — feed modes are the five §11.6
// sort orders and NONE of them introduces popularity ordering (no-applause
// invariant).  `feed_mode` is compat-accepting on BOTH directions of the
// wire: a stored legacy value is echoed unchanged (pre-redesign bundles keep
// parsing) and a legacy PATCH is still accepted; consumers normalize via
// `normalizeFeedMode` (see LEGACY_FEED_MODES in feed.ts).
// ---------------------------------------------------------------------------

export const feedPreferencesSchema = z
  .object({
    feed_mode: feedModeCompatSchema,
    topic_preferences: z.array(z.string().min(1).max(128)).max(MAX_TOPIC_PREFERENCES),
    personalization_enabled: z.boolean(),
    attention_retention_preference: attentionRetentionPreferenceSchema,
    notification_preferences: privacyNotificationPreferencesSchema,
  })
  .strict();
export type FeedPreferences = z.infer<typeof feedPreferencesSchema>;

export const feedPreferencesPatchSchema = z
  .object({
    feed_mode: feedModeCompatSchema.optional(),
    topic_preferences: z.array(z.string().min(1).max(128)).max(MAX_TOPIC_PREFERENCES).optional(),
    personalization_enabled: z.boolean().optional(),
    notification_preferences: privacyNotificationPreferencesSchema.partial().optional(),
  })
  .strict();
export type FeedPreferencesPatch = z.infer<typeof feedPreferencesPatchSchema>;

// ---------------------------------------------------------------------------
// POST /v1/uploads (WS-G.3.7b).
// ---------------------------------------------------------------------------

export const UPLOAD_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
] as const;
/** WS-Q.2.3c native video containers (mp4/webm only; the DB CHECK mirrors this). */
export const UPLOAD_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
/** WS-Q.5.2c WebVTT caption tracks for video posts (text; no metadata to strip). */
export const UPLOAD_CAPTION_TYPES = ['text/vtt'] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_GIF_BYTES = 8 * 1024 * 1024;
export const MAX_CAPTION_BYTES = 1 * 1024 * 1024;
/** WS-Q.2.3c hard ceiling (mirrors the DB `uploads_byte_size_range` CHECK);
 *  the steward-tunable `ingestion.video_max_bytes` may only LOWER it. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export const uploadPublicSchema = z
  .object({
    upload_id: uuidSchema,
    content_type: z.enum([...UPLOAD_IMAGE_TYPES, ...UPLOAD_VIDEO_TYPES, ...UPLOAD_CAPTION_TYPES]),
    byte_size: z.number().int().min(1).max(MAX_VIDEO_BYTES),
    /** Required for images (WCAG); null for video/caption uploads. */
    alt_text: z.string().min(1).max(500).nullable(),
    /** Same-origin serving path (`/v1/uploads/:id`). */
    url: z.string().min(1).max(512),
    /** True once metadata stripping ran (images; EXIF/GPS removed). */
    metadata_stripped: z.boolean(),
    /** Intrinsic pixel dimensions, so the renderer reserves the image's real
     *  box and the LCP surface stops shifting on load.  ABSENT (not zero, not a
     *  default) when unknown — video/caption uploads, AVIF, and rows written
     *  before the columns existed — because an image told the wrong size shifts
     *  the layout just as badly, only wrongly. */
    image_width: z.number().int().min(1).max(65_535).optional(),
    image_height: z.number().int().min(1).max(65_535).optional(),
    /** WS-J.2.6b gate: `pending` cannot attach or serve yet (flagged
     *  uploads are rejected at creation and never appear on the wire). */
    scan_state: z.enum(['clear', 'pending']),
    created_at: isoTimestampSchema,
  })
  .strict()
  .refine(
    (value) =>
      !UPLOAD_IMAGE_TYPES.includes(value.content_type as (typeof UPLOAD_IMAGE_TYPES)[number]) ||
      value.alt_text !== null,
    { message: 'alt_text is required for image uploads.', path: ['alt_text'] },
  );
export type UploadPublic = z.infer<typeof uploadPublicSchema>;

export function isAnimatableImage(contentType: string): boolean {
  return contentType === 'image/gif';
}

// ---------------------------------------------------------------------------
// GET /v1/security/link-blocklist (WS-G.4.2c) — updatable without deploys.
// ---------------------------------------------------------------------------

export const linkBlocklistResponseSchema = z
  .object({
    /** Opaque version for cache-busting (changes on every update). */
    version: z.string().min(1).max(64),
    domains: z.array(z.string().min(4).max(253)).max(5_000),
  })
  .strict();
export type LinkBlocklistResponse = z.infer<typeof linkBlocklistResponseSchema>;
