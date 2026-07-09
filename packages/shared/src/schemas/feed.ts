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

/** Rating labels describe conversation STATE, never popularity (WS-B.2.3).
 *  `new` is the neutral floor (SPEC §5.6): a story with no active-reading signal
 *  yet — so the default never falsely claims "Getting Attention" (reading is
 *  increasing) for a story nobody has read. */
export const RATING_LABEL_KINDS = [
  'new',
  'getting-attention',
  'deepening',
  'well-sourced',
  'needs-context',
  'under-review',
  'resolved-context',
  'bridge-active',
] as const;
export const ratingLabelKindSchema = z.enum(RATING_LABEL_KINDS);
export type RatingLabelKind = (typeof RATING_LABEL_KINDS)[number];

/** Source provenance — feeds the origin badge, never a ranking input. */
export const storyOriginSchema = z.enum(['independent', 'wire', 'official', 'aggregator']);

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

/**
 * Structured SCOI context card attached to feed items whose interpretations
 * diverge (WS-I.2.4c, SPEC §10.6). Informational ONLY: "Needs Context" never
 * means false or banned. Lens-map detail stays on the story read surface
 * (`GET /v1/stories/{id}/interpretations`); the card carries the compact
 * references the feed needs.
 */
export const feedContextCardSchema = z.object({
  scoi_level: z.enum(['medium', 'high', 'very_high']),
  /** Lenses with recorded interpretations on this story. */
  lens_count: z.number().int().nonnegative(),
  /** Open bridge attempts on the story's thread (WS-H.4.2d records). */
  bridge_attempts_open: z.number().int().nonnegative(),
  /** True ⇒ the story read surface has a lens map worth opening. */
  where_interpretations_differ: z.boolean(),
});
export type FeedContextCard = z.infer<typeof feedContextCardSchema>;

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
  origin: storyOriginSchema,
  url: httpUrlSchema.optional(),
  /** WS-Q.5.3b — item visibility tier; lets a room feed mark non-public items
   *  with the in-room chip. Absent ⇒ public (global feeds carry only public). */
  visibility: z.enum(['public', 'room_only']).optional(),
  /** WS-Q.5.2c native media (image/video posts); absent for non-media stories. */
  media: feedMediaSchema.nullish(),
  reading_minutes: z.number().int().nonnegative(),
  rating_label: ratingLabelKindSchema,
  /** Human-readable distribution reason; never a raw numeric score. */
  distribution_reason: z.string().min(1),
  context_chips: z.array(contextChipSchema).default([]),
  safety_state: safetyStateSchema.default('ok'),
  /** Same-cluster stories demoted by matroid dedup, available for the
   * "more on this story" expansion (WS-I.2.4a). */
  more_on_this_story: z.array(uuidSchema).max(12).default([]),
  /** SCOI context card when interpretations diverge (WS-I.2.4c). */
  context_card: feedContextCardSchema.nullable().default(null),
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
