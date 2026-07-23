// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Type-safe search-param schemas (WS-C.1.1b). Invalid values are rejected and
// coerced to the route default via `.catch(...)` — never silently accepted as
// arbitrary input. These drive the feed-mode switcher and the thread branch tab
// from shareable URLs.
import { feedModeCompatSchema, normalizeFeedMode, uuidSchema } from '@licio/shared';
import { z } from 'zod';

/**
 * Front-page feed search: `?mode=` ∈ feed modes. Optional so visiting `/` with no
 * param uses the reader's saved mode; an invalid value coerces to undefined (the
 * front page then falls back to the UI store), never silently accepted. A legacy
 * mode in a pre-redesign shared URL normalizes to its canonical successor
 * instead of being dropped (the link keeps working).
 */
export const feedSearchSchema = z.object({
  mode: feedModeCompatSchema
    .transform((mode) => normalizeFeedMode(mode))
    .optional()
    .catch(undefined),
});
export type FeedSearch = z.infer<typeof feedSearchSchema>;

/** Post-login redirect target, preserved across the login flow.  The optional
 *  `cancel_token` carries the emailed single-use deletion-cancellation token
 *  (WS-D.2.4a) — the email's link lands on /login?cancel_token=… . */
export const loginSearchSchema = z.object({
  redirect: z.string().optional().catch(undefined),
  cancel_token: z.string().optional().catch(undefined),
});
export type LoginSearch = z.infer<typeof loginSearchSchema>;

/** Submit composer: story submission only; share-target params seed the story composer. */
export const submitSearchSchema = z.object({
  /** Share-target intake (WS-G.3.7a): citation pre-population. */
  share_url: z.string().url().max(2048).optional().catch(undefined),
  share_title: z.string().max(300).optional().catch(undefined),
});
export type SubmitSearch = z.infer<typeof submitSearchSchema>;

/** Validate (and coerce) the feed search params. Never throws. */
export function parseFeedSearch(search: Record<string, unknown>): FeedSearch {
  return feedSearchSchema.parse(search);
}

/**
 * WS-T: `?debates` deep-links the LIVE-DEBATES LIST modal (search + sort over
 * the story's arenas), and `?debate=<id>` the FULL ARENA for one of them (a
 * shareable link; the legacy `/stories/:id/debate/:id` route redirects here —
 * the room-governance modal's pattern).  They nest rather than stack: while a
 * `?debate` is present the host renders the arena alone, so closing it drops
 * back into the list that is still in the URL.  Absent ⇒ no modal; an invalid
 * value coerces to undefined, never silently accepted.  Closing each modal
 * CLEARS its param, so back/refresh behave honestly.
 */
export const storyDetailSearchSchema = z.object({
  debates: z.boolean().optional().catch(undefined),
  debate: uuidSchema.optional().catch(undefined),
});
export type StoryDetailSearch = z.infer<typeof storyDetailSearchSchema>;

/**
 * Dedicated comment-centric page (WS-T.7.2): `?root=` focuses the view on one
 * comment's replies (the drill-down anchor); `?debates` / `?debate=` open the
 * live-debates list and the arena modal exactly as on the story page.  An
 * invalid/absent value coerces to undefined — the unrooted "all comments"
 * view — never silently accepted.
 */
export const storyCommentsSearchSchema = z.object({
  root: uuidSchema.optional().catch(undefined),
  debates: z.boolean().optional().catch(undefined),
  debate: uuidSchema.optional().catch(undefined),
});
export type StoryCommentsSearch = z.infer<typeof storyCommentsSearchSchema>;

/**
 * Room detail (WS-U §24.6): `?governance=<tab>` deep-links the room-governance
 * modal OPEN to a tab (a shareable link; the legacy `/rooms/:id/governance` route
 * redirects here). Absent ⇒ the modal starts closed; an unknown value coerces to
 * undefined, never silently accepted.
 */
export const roomGovernanceTabSchema = z.enum(['overview', 'models', 'settings']);
export type RoomGovernanceTab = z.infer<typeof roomGovernanceTabSchema>;
export const roomDetailSearchSchema = z.object({
  governance: roomGovernanceTabSchema.optional().catch(undefined),
});
export type RoomDetailSearch = z.infer<typeof roomDetailSearchSchema>;

/**
 * Operator consoles (WS-J.2 moderation, WS-N.2.1c compliance): `?tab=` deep-links
 * a console section, so an operator can bookmark or share their queue (a
 * navigation hint only — every console endpoint re-authorizes server-side).
 * Absent ⇒ the first tab; an unknown value coerces to undefined, never silently
 * accepted.
 */
export const moderationConsoleSearchSchema = z.object({
  tab: z.enum(['queue', 'sources', 'appeals', 'integrity', 'audit']).optional().catch(undefined),
});
export type ModerationConsoleSearch = z.infer<typeof moderationConsoleSearchSchema>;

export const complianceConsoleSearchSchema = z.object({
  tab: z.enum(['cases', 'fraud', 'declarations']).optional().catch(undefined),
});
export type ComplianceConsoleSearch = z.infer<typeof complianceConsoleSearchSchema>;
