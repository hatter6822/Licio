// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Type-safe search-param schemas (WS-C.1.1b). Invalid values are rejected and
// coerced to the route default via `.catch(...)` — never silently accepted as
// arbitrary input. These drive the feed-mode switcher and the thread branch tab
// from shareable URLs.
import { feedModeSchema, uuidSchema } from '@licio/shared';
import { z } from 'zod';

/**
 * Front-page feed search: `?mode=` ∈ feed modes. Optional so visiting `/` with no
 * param uses the reader's saved mode; an invalid value coerces to undefined (the
 * front page then falls back to the UI store), never silently accepted.
 */
export const feedSearchSchema = z.object({
  mode: feedModeSchema.optional().catch(undefined),
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
 * Dedicated comment-centric page (WS-T.7.2): `?root=` focuses the view on one
 * comment's replies (the drill-down anchor).  An invalid/absent value coerces to
 * undefined — the unrooted "all comments" view — never silently accepted.
 */
export const storyCommentsSearchSchema = z.object({
  root: uuidSchema.optional().catch(undefined),
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
