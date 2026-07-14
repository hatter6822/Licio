// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public WS-H read surface (no auth; visibility-gated):
//
//   GET /v1/stories/:storyId/interpretations — the "Where interpretations
//     differ" data (WS-H.4.3b): per-lens plain-language summaries + context
//     state from the latest SCOI output. NO interpretation is marked
//     correct; "needs context" never means false (SPEC §10.5).
//
// Reads STORED shadow outputs only — a page load never triggers invariant
// computation. (The former GET /stories/:storyId/independent-sources MERI
// lineage drawer was removed: comment-centric sourcing superseded story-level
// lineage as the reader-facing surface. MERI itself is unaffected — it stays
// the WS-I `exposure_independence` ranking input and the §13.2 quota's
// independence signal. The path survives ONLY as the inert rollout-compat
// stub at the bottom of this file, serving the honest-absence payload to
// pre-removal cached bundles until they age out.)

import { Hono } from 'hono';
import { z } from 'zod';
import { type EventPipelineServices, getEventPipelineServices } from '../events/services.js';
import { storyReadableByUser } from '../forum/rooms.js';
import type { ForumServices } from '../forum/services.js';
import { getForumServices } from '../forum/services.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { readSessionToken, validateSession } from '../identity/sessions.js';
import { getIngestionServices, type IngestionServices } from '../ingestion/services.js';
import type { StoryRecord } from '../ingestion/stores.js';
import { getInvariantServices, type InvariantPlatformServices } from '../invariants/services.js';

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

const uuidSchema = z.string().uuid();

/** Soft session resolution (anonymous on any failure; never an error/access). */
async function resolveSoftUserId(
  identity: IdentityServices,
  cookieHeader: string | undefined,
): Promise<string | null> {
  const token = readSessionToken(cookieHeader);
  if (!token) return null;
  try {
    return (await validateSession(identity.sessions, token))?.record.user_id ?? null;
  } catch {
    return null;
  }
}

/**
 * WS-Q.3.2 — the item read bar for the story-adjacent public read. A story is
 * readable when it is not hidden AND the requester passes the room CONTENT bar
 * (a `room_only` story in a private room is 404 to non-members, no existence
 * oracle). Mirrors the story-detail read gate (routes/v1.ts) so this WS-H
 * read can never widen a surface that a story-detail 404 already closed.
 */
async function storyReadableTo(
  forum: ForumServices,
  story: Pick<StoryRecord, 'hiddenState' | 'visibility' | 'roomId'>,
  userId: string | null,
): Promise<boolean> {
  const room = await forum.rooms.getById(story.roomId);
  if (room === null) return false; // fail closed (unknown room ⇒ unreadable)
  return storyReadableByUser(forum, story, room, userId);
}

export function createInvariantsPublicRoutes(
  resolveEvents: () => EventPipelineServices = getEventPipelineServices,
  resolveIngestion: () => IngestionServices = getIngestionServices,
  resolveInvariants: () => InvariantPlatformServices = getInvariantServices,
  resolveForum: () => ForumServices = getForumServices,
  resolveIdentity: () => IdentityServices = getIdentityServices,
) {
  return (
    new Hono()
      .get('/stories/:storyId/interpretations', async (c) => {
        const storyId = c.req.param('storyId');
        if (!uuidSchema.safeParse(storyId).success) {
          return c.json(deny('invalid_story', 'storyId must be a UUID'), 422);
        }
        const ingestion = resolveIngestion();
        const story = await ingestion.stories.getById(storyId);
        // 404-over-403 + the item read bar: a hidden story OR a room_only story in
        // a private room is 404 to non-members (no existence oracle, WS-Q.3.2).
        if (!story || story.hiddenState !== null) {
          return c.json(deny('not_found', 'Story not found'), 404);
        }
        const forum = resolveForum();
        const userId = await resolveSoftUserId(resolveIdentity(), c.req.header('cookie'));
        if (!(await storyReadableTo(forum, story, userId))) {
          return c.json(deny('not_found', 'Story not found'), 404);
        }
        const latest = await resolveEvents().invariantStore.latest('SCOI', storyId);
        if (!latest || latest.reasonCodes.includes('INSUFFICIENT_COVERAGE')) {
          return c.json({
            story_id: storyId,
            context_state: null,
            interpretations: [],
            needs_context: false,
          });
        }
        const config = resolveInvariants().config();
        const scoi =
          typeof latest.scoreVector['scoi'] === 'number' ? latest.scoreVector['scoi'] : 0;
        const state =
          typeof latest.scoreVector['context_state'] === 'string'
            ? latest.scoreVector['context_state']
            : null;
        const perOverlap =
          typeof latest.scoreVector['per_overlap_energy'] === 'object' &&
          latest.scoreVector['per_overlap_energy'] !== null
            ? (latest.scoreVector['per_overlap_energy'] as Record<string, unknown>)
            : {};
        // Resolve human lens names through the story's room (ids stay the
        // stable keys; names are presentation data).
        const lensNames = new Map<string, string>();
        const thread = await ingestion.stories.getThreadByStoryId(storyId);
        if (thread?.roomId) {
          for (const lens of await resolveForum().lenses.listByRoom(thread.roomId)) {
            lensNames.set(lens.lensId, lens.name);
          }
        }
        const interpretations = Object.entries(perOverlap)
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([pair, energy]) => {
            const [lensA, lensB] = pair.split('~');
            const nameA = lensNames.get(lensA ?? '');
            const nameB = lensNames.get(lensB ?? '');
            return {
              lens_a: lensA ?? '',
              lens_b: lensB ?? '',
              ...(nameA ? { lens_a_name: nameA } : {}),
              ...(nameB ? { lens_b_name: nameB } : {}),
              // Plain language, never raw technical data (WS-H.4.3b) — and no
              // side is presented as correct.
              summary:
                energy < 1e-9
                  ? 'These two lenses currently read this story the same way.'
                  : 'These two lenses currently read this story differently; both readings are shown to their communities.',
              disagreement: Math.min(1, energy / 4),
            };
          });
        return c.json({
          story_id: storyId,
          context_state: state,
          interpretations,
          needs_context: scoi >= config.scoiNeedsContextThreshold,
        });
      })

      // DEPRECATED — rollout compatibility only. Pre-removal cached PWA bundles
      // still render the removed independent-sources drawer, whose lazy read
      // calls this path on open; a 404 would surface an error line in that
      // stale UI. Serve the drawer's designed HONEST-ABSENCE payload (every
      // field the old response schema required, all empty/null) UNIFORMLY for
      // any UUID-shaped story id — constant output reveals no story existence
      // and carries no content. Remove together with `rating_label` /
      // LEGACY_FEED_MODES once pre-removal bundles have aged out of
      // service-worker caches (tracked in docs/ranking/README.md).
      .get('/stories/:storyId/independent-sources', (c) => {
        const storyId = c.req.param('storyId');
        if (!uuidSchema.safeParse(storyId).success) {
          return c.json(deny('invalid_story', 'storyId must be a UUID'), 422);
        }
        return c.json({
          story_id: storyId,
          marginal_gain: null,
          exposure_label: null,
          redundancy_classes: 0,
          source: null,
          confirmed_syndication_count: 0,
          co_group_stories: [],
          primary_sources: [],
        });
      })
  );
}
