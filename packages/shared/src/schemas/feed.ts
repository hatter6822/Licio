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

export const feedItemSchema = z.object({
  story_id: uuidSchema,
  title: z.string().min(1),
  source: z.string().min(1),
  origin: storyOriginSchema,
  url: httpUrlSchema.optional(),
  reading_minutes: z.number().int().nonnegative(),
  rating_label: ratingLabelKindSchema,
  /** Human-readable distribution reason; never a raw numeric score. */
  distribution_reason: z.string().min(1),
  context_chips: z.array(contextChipSchema).default([]),
  safety_state: safetyStateSchema.default('ok'),
  /** MERI exposure label (SPEC §7.6, WS-H.2.3a) — null until a MERI shadow
   * run covers the story (honest absence; never implies truth). */
  exposure_label: z.enum(MERI_EXPOSURE_LABELS_WIRE).nullable().default(null),
});
export type FeedItem = z.infer<typeof feedItemSchema>;

/** Keyset-paginated feed page (read-only-offline cacheable, WS-C.1.2 table). */
export const feedResponseSchema = paginatedSchema(feedItemSchema);
export type FeedResponse = z.infer<typeof feedResponseSchema>;

/** Query params for the feed (mode switcher + keyset cursor). */
export const feedQuerySchema = z.object({
  mode: feedModeSchema.optional(),
  cursor: cursorSchema.optional(),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/** Story detail (SPEC §23.2 GET /stories/{id}). FeedItem plus a thread link. */
export const storyDetailSchema = feedItemSchema.extend({
  body_summary: z.string(),
  thread_id: uuidSchema.nullable(),
  /** Topic-cluster ids (WS-H.6.1a client loop tracking; descriptive only). */
  topic_ids: z.array(z.string().min(1).max(128)).max(8).default([]),
});
export type StoryDetail = z.infer<typeof storyDetailSchema>;
