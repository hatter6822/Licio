// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Feed contracts (SPEC §23.3 FeedItem). The wire shape is validated with zod
// before it can enter the TanStack Query cache (WS-C.1.2 boundary defense).
// It is no-applause BY CONSTRUCTION: there is deliberately no like/vote/score/
// reaction/follower field — only descriptive conversation-state signals.
import { z } from 'zod';
import { cursorSchema, httpUrlSchema, paginatedSchema, uuidSchema } from './common.js';
import { contributionDisputeStatusSchema } from './contribution.js';

/**
 * Feed sort modes (SPEC §11.6; WS-B.2.9 switcher). Every mode is an OBJECTIVE,
 * content-derived ordering — never popularity, never a like/vote count:
 *   `best`    — highest participation-weighted attention right now (the full
 *               WS-I ranked pipeline; PWAtt is the ordering objective).
 *   `rising`  — fastest-INCREASING participation-weighted attention (the
 *               per-item PWAtt window-over-window velocity).
 *   `sources` — most sourced (published comments carrying ≥1 citation — the
 *               same count as the card's `sources_count`).
 *   `debates` — most WS-T debates (the corrections tally: live arenas +
 *               validated + incorrect adjudications).
 *   `new`     — most recent (strict chronological).
 */
export const FEED_MODES = ['best', 'rising', 'sources', 'debates', 'new'] as const;
export type FeedMode = (typeof FEED_MODES)[number];

/** Default mode when the reader has expressed no preference. */
export const DEFAULT_FEED_MODE: FeedMode = 'best';

/**
 * DEPRECATED — rollout compatibility only. The pre-redesign mode set
 * (`local` was removed outright: the platform collects no user location, so a
 * location-sorted feed was never honest; the rest were replaced by the
 * explicit sort orders above). Pre-redesign cached PWA bundles still SEND
 * these values (`?mode=` requests, settings PATCHes) and hold them in stored
 * personalization blobs, so the wire/storage boundaries keep ACCEPTING them
 * via {@link feedModeCompatSchema} and every consumer normalizes through
 * {@link normalizeFeedMode}. Remove together with `rating_label` once
 * pre-redesign bundles have aged out (tracked in docs/ranking/README.md).
 */
export const LEGACY_FEED_MODES = [
  'balanced',
  'chronological',
  'source-diverse',
  'local',
  'low-personalization',
] as const;
export type LegacyFeedMode = (typeof LEGACY_FEED_MODES)[number];

/**
 * Wire/storage-compat mode schema: accepts canonical AND legacy values,
 * output UNCHANGED (no transform — a stored legacy value round-trips as-is so
 * pre-redesign bundles reading the same blob keep parsing; consumers
 * normalize explicitly at the point of use).
 */
export const feedModeCompatSchema = z.enum([...FEED_MODES, ...LEGACY_FEED_MODES]);
export type FeedModeCompat = z.infer<typeof feedModeCompatSchema>;

const LEGACY_FEED_MODE_MAP: Record<LegacyFeedMode, FeedMode> = {
  // The default ranked pipeline is the direct successor of `balanced`; the
  // removed pipeline MODULATIONS (the `source-diverse` balancing override and
  // the `local` quota boost) fold into it — `sources` is a citation count,
  // NOT outlet diversity, so `source-diverse` must not map there.
  // `chronological` maps exactly onto `new`. `low-personalization` ALSO maps
  // to `new`: the user chose LESS personalization, and `new` is the redesign's
  // reduce-personalization affordance (strict chronological — no relevance
  // term, no attention ranking; the PHI-4 "Reduce personalization" control
  // sets the same mode). Mapping it to `best` would silently re-enable
  // personalized ranking for that user the moment an updated client
  // normalizes and re-sends the canonical mode.
  balanced: 'best',
  chronological: 'new',
  'source-diverse': 'best',
  local: 'best',
  'low-personalization': 'new',
};

/**
 * Canonical mode for any wire/storage value. TOTAL over `string` — an
 * absent, unknown, or corrupted stored value resolves to the default (never
 * `undefined` leaking into an ordering decision), a legacy value maps per
 * {@link LEGACY_FEED_MODES}, and a canonical value passes through.
 */
export function normalizeFeedMode(mode: string | null | undefined): FeedMode {
  if (mode === null || mode === undefined) return DEFAULT_FEED_MODE;
  if ((FEED_MODES as readonly string[]).includes(mode)) return mode as FeedMode;
  return (LEGACY_FEED_MODE_MAP as Record<string, FeedMode | undefined>)[mode] ?? DEFAULT_FEED_MODE;
}

/**
 * The at-rest spelling for a DURABLE feed-mode write (rollout compat): the
 * settings responses echo the stored value, and a pre-redesign cached bundle
 * on the SAME account (another device, an un-refreshed tab) validates them
 * against the old mode enum alone. `best` and `new` have LOSSLESS legacy
 * spellings (`balanced` / `chronological` — {@link normalizeFeedMode} maps
 * them straight back), so durable writes store those and stale bundles keep
 * parsing. The three genuinely NEW sorts (`rising`/`sources`/`debates`) have
 * no legacy spelling — any downgrade would LOSE the preference for updated
 * devices — so they store canonically, and a stale sibling bundle's settings
 * read fails until its service worker updates (narrow, self-healing;
 * documented in docs/ranking/README.md). Every write boundary that persists
 * a feed mode applies this; remove together with {@link LEGACY_FEED_MODES}.
 */
export function legacyPreservingFeedMode(mode: FeedModeCompat): FeedModeCompat {
  if (mode === 'best') return 'balanced';
  if (mode === 'new') return 'chronological';
  return mode;
}

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

/**
 * DEPRECATED — rollout compatibility only (see `distribution_reason` on
 * `feedItemSchema`). The one string every server emitter sends for the
 * removed per-card distribution reason: universally true, never score-like,
 * and clean against the §13.6/§30.6 prohibited vocabulary, because
 * pre-removal cached bundles RENDER it on every card until they age out.
 */
export const LEGACY_DISTRIBUTION_REASON = 'Shown in your feed.';

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
  /** Intrinsic pixel dimensions of `url`, so the renderer reserves the image's
   *  real box and the LCP surface stops shifting on load.  NULL — never a
   *  default — when unknown (video, AVIF, or a row predating the columns): an
   *  image told the WRONG size shifts the layout just as badly, only wrongly,
   *  so the renderer reserves nothing rather than reserving a guess. */
  width: z.number().int().min(1).max(65_535).nullable().default(null),
  height: z.number().int().min(1).max(65_535).nullable().default(null),
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
  /** DEPRECATED — rollout compatibility only. The per-card distribution
   *  reason (the WS-I.2.6 explanation line) was removed from the product, but
   *  a pre-removal cached PWA bundle still validates feed/detail responses
   *  against a schema that REQUIRES a non-empty `distribution_reason`. The
   *  server therefore keeps emitting `LEGACY_DISTRIBUTION_REASON` (above) and
   *  the field stays declared OPTIONAL here so response validation does not
   *  strip it. New clients never read it. Remove the field and the emitters
   *  together with `rating_label` once pre-removal bundles have aged out
   *  (tracked in docs/ranking/README.md). */
  distribution_reason: z.string().min(1).optional(),
  context_chips: z.array(contextChipSchema).default([]),
  safety_state: safetyStateSchema.default('ok'),
  /** Same-cluster stories demoted by matroid dedup, available for the
   * "more on this story" expansion (WS-I.2.4a). */
  more_on_this_story: z.array(uuidSchema).max(12).default([]),
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
  /** WS-T — the story prevailed in enough sourced debates (the settle threshold,
   *  SPEC §15.4) that it can no longer be challenged ("Settled"). A PRESENCE
   *  marker: emitted only when TRUE, so a pre-settle cached bundle keeps parsing
   *  every response that carries no settled story. Always co-occurs with
   *  `dispute_status: 'validated'`. A content-integrity terminal, never a count. */
  dispute_settled: z.boolean().optional(),
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
 *  topic scope: `?topic=` serves the WS-I TOPIC surface). `mode` accepts the
 *  legacy values (pre-redesign cached bundles still send them); the server
 *  normalizes via `normalizeFeedMode` — the mapping is total, so no legacy
 *  value carries extra out-of-band semantics. */
export const feedQuerySchema = z.object({
  mode: feedModeCompatSchema.optional(),
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
