// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Feed contracts (SPEC §23.3 FeedItem). The wire shape is validated with zod
// before it can enter the TanStack Query cache (WS-C.1.2 boundary defense).
// It is no-applause BY CONSTRUCTION: there is deliberately no like/vote/score/
// reaction/follower field — only descriptive conversation-state signals.
import { z } from 'zod';
import { cursorSchema, httpUrlSchema, paginatedSchema, uuidSchema } from './common.js';
import { MERI_EXPOSURE_LABELS_WIRE } from './invariants-api.js';

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

/** Rating labels describe conversation STATE, never popularity (WS-B.2.3). */
export const RATING_LABEL_KINDS = [
  'getting-attention',
  'deepening',
  'well-sourced',
  'needs-context',
  'under-review',
  'resolved-context',
  'bridge-active',
] as const;
export const ratingLabelKindSchema = z.enum(RATING_LABEL_KINDS);

/** Source provenance — feeds the origin badge, never a ranking input. */
export const storyOriginSchema = z.enum(['independent', 'wire', 'official', 'aggregator']);

/** Story-level safety posture surfaced to readers (SPEC §22.1 safety_state). */
export const safetyStateSchema = z.enum(['ok', 'caution', 'under-review', 'restricted']);

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

/** WS-Q.5.2c — native image/video post media (the scan-gated upload + alt text).
 *  Null for non-media stories; the client builds the gated read URL from
 *  `upload_ref`. Images carry required alt text; videos carry none here. */
export const feedMediaSchema = z.object({
  upload_ref: uuidSchema,
  kind: z.enum(['image', 'video']),
  alt_text: z.string().max(1_000).nullable(),
  /** Video captions as text (rendered beneath the player); null otherwise. */
  captions_text: z.string().max(20_000).nullable().default(null),
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
  /** MERI exposure label (SPEC §7.6, WS-H.2.3a) — null until a MERI shadow
   * run covers the story (honest absence; never implies truth). */
  exposure_label: z.enum(MERI_EXPOSURE_LABELS_WIRE).nullable().default(null),
  /** Same-cluster stories demoted by matroid dedup, available for the
   * "more on this story" expansion (WS-I.2.4a). */
  more_on_this_story: z.array(uuidSchema).max(12).default([]),
  /** SCOI context card when interpretations diverge (WS-I.2.4c). */
  context_card: feedContextCardSchema.nullable().default(null),
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
  /** Topic-cluster ids (WS-H.6.1a client loop tracking; descriptive only). */
  topic_ids: z.array(z.string().min(1).max(128)).max(8).default([]),
  /** WS-Q.5.4a — true when the requesting user authored this story (gates the
   *  author visibility control). Absent ⇒ not the owner. */
  is_owner: z.boolean().optional(),
  /** WS-Q.5.4a — the home room's visibility (widen is impossible in a private
   *  room). Absent on the legacy demo contract. */
  room_visibility: z.enum(['public', 'private']).optional(),
});
export type StoryDetail = z.infer<typeof storyDetailSchema>;
