// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Feed contracts (SPEC §23.3 FeedItem). The wire shape is validated with zod
// before it can enter the TanStack Query cache (WS-C.1.2 boundary defense).
// It is no-applause BY CONSTRUCTION: there is deliberately no like/vote/score/
// reaction/follower field — only descriptive conversation-state signals.
import { z } from 'zod';
import { cursorSchema, httpUrlSchema, paginatedSchema, uuidSchema } from './common.js';
import { contributionDisputeStatusSchema } from './contribution.js';

/** Feed ranking/personalization modes (SPEC §6.4; WS-B.2.9 switcher). */
export const FEED_MODES = [
  'balanced',
  'chronological',
  'source-diverse',
  'local',
  'low-personalization',
] as const;
export type FeedMode = (typeof FEED_MODES)[number];
export const feedModeSchema = z.enum(FEED_MODES);

/**
 * Per-story corrections tally (SPEC §5.6) — the WS-T adjudication record of the
 * story's COMMENT section, surfaced as compact card signals. Counts describe
 * content-integrity outcomes, never popularity:
 *   `active`    — live debate arenas over the story's comments (corrections
 *                 currently being argued).
 *   `validated` — comments that were challenged and UPHELD (proven accurate).
 *   `incorrect` — comments a sourced correction PREVAILED against (kept
 *                 visible, demoted, tagged).
 * The story's OWN posture is deliberately excluded — it is carried separately
 * by `dispute_status`, so the two signals never double-report one debate.
 */
export const storyCorrectionsSchema = z.object({
  active: z.number().int().min(0),
  validated: z.number().int().min(0),
  incorrect: z.number().int().min(0),
});
export type StoryCorrections = z.infer<typeof storyCorrectionsSchema>;

export const EMPTY_STORY_CORRECTIONS: StoryCorrections = Object.freeze({
  active: 0,
  validated: 0,
  incorrect: 0,
});

/**
 * DEPRECATED — rollout compatibility only. The §5.6 rating-label pill was
 * removed (see `storyCorrectionsSchema` above), but a pre-redesign cached PWA
 * bundle still validates feed/detail responses against a schema that REQUIRES
 * `rating_label`; omitting it would hard-fail every stale bundle until its
 * service worker updates. The server therefore keeps emitting a legacy
 * approximation (`legacyRatingLabel` in utils/story-safety.ts) and the field
 * stays declared here as OPTIONAL so the route-level response validation does
 * not strip it. New clients never read it. Remove the field, the emitters,
 * and `legacyRatingLabel` once pre-redesign bundles have aged out (tracked in
 * docs/ranking/README.md).
 */
export const LEGACY_RATING_LABELS = [
  'new',
  'getting-attention',
  'deepening',
  'needs-context',
  'under-review',
  'resolved-context',
  'bridge-active',
] as const;
export type LegacyRatingLabel = (typeof LEGACY_RATING_LABELS)[number];

/** Story-level safety posture surfaced to readers (SPEC §22.1 safety_state). */
export const safetyStateSchema = z.enum(['ok', 'caution', 'under-review', 'restricted']);
export type StorySafetyState = z.infer<typeof safetyStateSchema>;

/**
 * A descriptive context chip ("3 lenses", "2 primary sources"). `icon` is an
 * opaque string on the wire; the route layer maps it to a known IconName and
 * drops anything unrecognised (icon names are a WS-B concern, not a wire one).
 */
export const contextChipSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  icon: z.string().optional(),
});

/** A same-origin, relative media read path the client renders directly. Public
 *  media is a bare `/v1/uploads/:id`; a `room_only` item carries a short-lived
 *  signed query (`?e=…&t=…`) minted per response (WS-Q.5.2c serving gate). It is
 *  validated as a same-origin `/v1/uploads/` path, so the wire can never carry an
 *  off-origin or script URL into an `<img>`/`<video>` `src`. */
export const mediaPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\/v1\/uploads\//, 'must be a same-origin /v1/uploads/ path');

/** WS-Q.5.2c — native image/video post media. Null for non-media stories. The
 *  server mints each read URL after the read-bar check (signed for room_only),
 *  so the client renders `url` directly. Images carry required alt text. */
export const feedMediaSchema = z.object({
  url: mediaPathSchema,
  kind: z.enum(['image', 'video']),
  alt_text: z.string().max(1_000).nullable(),
  /** Video captions as text (rendered beneath the player); null otherwise. */
  captions_text: z.string().max(20_000).nullable().default(null),
  /** Read URL for an uploaded WebVTT caption track; null otherwise. */
  captions_url: mediaPathSchema.nullable().default(null),
  /** Read URL for a video poster image; null otherwise. */
  poster_url: mediaPathSchema.nullable().default(null),
});
export type FeedMedia = z.infer<typeof feedMediaSchema>;

export const feedItemSchema = z.object({
  story_id: uuidSchema,
  title: z.string().min(1),
  source: z.string().min(1),
  url: httpUrlSchema.optional(),
  /** WS-Q.5.3b — item visibility tier; lets a room feed mark non-public items
   *  with the in-room chip. Absent ⇒ public (global feeds carry only public). */
  visibility: z.enum(['public', 'room_only']).optional(),
  /** WS-Q.5.2c native media (image/video posts); absent for non-media stories. */
  media: feedMediaSchema.nullish(),
  reading_minutes: z.number().int().nonnegative(),
  /** Published comments carrying ≥1 citation — the same count as the comment
   *  section's "Sources" view (`sources_count` on the WS-T overview), so the
   *  card number always matches what the reader finds inside. Defaults to 0 so
   *  producers/caches predating the signal stay valid on the wire. */
  sources_count: z.number().int().min(0).default(0),
  /** WS-T corrections tally for the comment section (see storyCorrectionsSchema). */
  corrections: storyCorrectionsSchema.default(EMPTY_STORY_CORRECTIONS),
  /** DEPRECATED — emitted for pre-redesign cached bundles only (see
   *  LEGACY_RATING_LABELS). New clients ignore it. */
  rating_label: z.enum(LEGACY_RATING_LABELS).optional(),
  /** Human-readable distribution reason; never a raw numeric score. */
  distribution_reason: z.string().min(1),
  context_chips: z.array(contextChipSchema).default([]),
  safety_state: safetyStateSchema.default('ok'),
  /** Same-cluster stories demoted by matroid dedup, available for the
   * "more on this story" expansion (WS-I.2.4a). */
  more_on_this_story: z.array(uuidSchema).max(12).default([]),
  /** SCOI context card when interpretations diverge (WS-I.2.4c). */
  /** Topic-cluster ids for the story (descriptive; never a ranking input).
   *  Powers the per-card "repeats on this topic" preference and WS-H.6.1a
   *  client loop tracking. Capped at 8; defaults to empty so producers that
   *  predate topic tagging stay valid on the wire. */
  topic_ids: z.array(z.string().min(1).max(128)).max(8).default([]),
  /** WS-T dispute posture (SPEC §15.4). `under_debate` ⇒ a sourced correction's
   *  debate is live ("Challenged"); `incorrect` ⇒ a correction prevailed
   *  ("Incorrect", and the story is demoted by the WS-I dispute ordering sink).
   *  Defaults to `none` so producers predating disputes stay valid on the wire.
   *  A content-integrity signal, never a popularity count. */
  dispute_status: contributionDisputeStatusSchema.default('none'),
});
export type FeedItem = z.infer<typeof feedItemSchema>;

/** Keyset-paginated feed page (read-only-offline cacheable, WS-C.1.2 table).
 *  `request_id` is the WS-I ranking decision id (SPEC §23.3 FeedResponse):
 *  present on pipeline-served feeds, absent on the legacy demo contract. */
export const feedResponseSchema = paginatedSchema(feedItemSchema).extend({
  request_id: uuidSchema.optional(),
});
export type FeedResponse = z.infer<typeof feedResponseSchema>;

/** Query params for the feed (mode switcher + keyset cursor + the optional
 *  topic scope: `?topic=` serves the WS-I TOPIC surface). */
export const feedQuerySchema = z.object({
  mode: feedModeSchema.optional(),
  cursor: cursorSchema.optional(),
  topic: z.string().min(1).max(128).optional(),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/** Story detail (SPEC §23.2 GET /stories/{id}). FeedItem plus a thread link. */
export const storyDetailSchema = feedItemSchema.extend({
  body_summary: z.string(),
  thread_id: uuidSchema.nullable(),
  /** The home room (WS-G.2.2): the client uses it to load the room's
   *  interpretation lenses for the comment composer + conversation filter.
   *  Optional so the legacy/demo detail contract stays valid on the wire. */
  room_id: uuidSchema.optional(),
  /** `topic_ids` is inherited from `feedItemSchema` (shared by the feed card
   *  and the detail read; powers WS-H.6.1a client loop tracking). */
  /** WS-Q.5.4a — true when the requesting user authored this story (gates the
   *  author visibility control). Absent ⇒ not the owner. */
  is_owner: z.boolean().optional(),
  /** WS-Q.5.4a — the home room's visibility (widen is impossible in a private
   *  room). Absent on the legacy demo contract. */
  room_visibility: z.enum(['public', 'private']).optional(),
});
export type StoryDetail = z.infer<typeof storyDetailSchema>;
