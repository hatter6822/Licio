// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public WS-H read surfaces (no auth; visibility-gated):
//
//   GET /v1/stories/:storyId/interpretations     — the "Where interpretations
//     differ" data (WS-H.4.3b): per-lens plain-language summaries + context
//     state from the latest SCOI output. NO interpretation is marked
//     correct; "needs context" never means false (SPEC §10.5).
//   GET /v1/stories/:storyId/independent-sources — the topic-page lineage
//     drawer (WS-H.2.3b): the story's exposure label, redundancy-class
//     grouping, and lineage co-members from the latest MERI output.
//
// Both read STORED shadow outputs only — a page load never triggers
// invariant computation (WS-H.2.3b acceptance).

import { estimateJaccard, lshBandHashes } from '@licio/invariants';
import type { MeriExposureLabelWire } from '@licio/shared';
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
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import { primarySourcesForStory } from '../moderation/evidence.js';
import { getModerationServices, type ModerationServices } from '../moderation/services.js';
import { usable } from '../pwatt/shadow.js';

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

const uuidSchema = z.string().uuid();

/** The §7.6 marginal-gain → exposure-label mapping (one place; the feed
 * route and the drawer route must agree). */
export function exposureLabelForGain(gain: number | null): MeriExposureLabelWire | null {
  if (gain === null) return null;
  if (gain >= 1) return 'independent_source';
  if (gain >= 0.5) return 'new_angle';
  if (gain > 0) return 'same_claim_new_evidence';
  return 'duplicate_context';
}

/** Marginal gains from the latest stored MERI output (empty when absent or
 *  degraded — the WS-H.1.2c `usable` rule every stored-output consumer applies:
 *  a TIMEOUT/COMPUTE_ERROR fallback row or a zero-coverage row is ABSENT, so a
 *  degraded batch can never label exposure off stale/fabricated gains). */
export async function latestMeriGains(
  events: EventPipelineServices,
): Promise<Record<string, number>> {
  const latest = usable(await events.invariantStore.latest('MERI', GLOBAL_FEED_TARGET_ID));
  const gains =
    latest &&
    typeof latest.scoreVector['marginal_gains'] === 'object' &&
    latest.scoreVector['marginal_gains'] !== null
      ? (latest.scoreVector['marginal_gains'] as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(gains).filter((entry): entry is [string, number] => {
      return typeof entry[1] === 'number';
    }),
  );
}

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
 * WS-Q.3.2 — the item read bar for the story-adjacent public reads. A story is
 * readable when it is not hidden AND the requester passes the room CONTENT bar
 * (a `room_only` story in a private room is 404 to non-members, no existence
 * oracle). Mirrors the story-detail read gate (routes/v1.ts) so these WS-H
 * drawers can never widen a read surface that a story-detail 404 already closed
 * — applied BOTH to the requested story and to every lineage co-member, so a
 * public story's drawer never leaks a contained co-member's id/title.
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
  resolveModeration: () => ModerationServices = getModerationServices,
) {
  return new Hono()
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
      const scoi = typeof latest.scoreVector['scoi'] === 'number' ? latest.scoreVector['scoi'] : 0;
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

    .get('/stories/:storyId/independent-sources', async (c) => {
      const storyId = c.req.param('storyId');
      if (!uuidSchema.safeParse(storyId).success) {
        return c.json(deny('invalid_story', 'storyId must be a UUID'), 422);
      }
      const ingestion = resolveIngestion();
      const story = await ingestion.stories.getById(storyId);
      if (!story || story.hiddenState !== null) {
        return c.json(deny('not_found', 'Story not found'), 404);
      }
      const forum = resolveForum();
      const userId = await resolveSoftUserId(resolveIdentity(), c.req.header('cookie'));
      if (!(await storyReadableTo(forum, story, userId))) {
        return c.json(deny('not_found', 'Story not found'), 404);
      }
      const events = resolveEvents();
      const latest = await events.invariantStore.latest('MERI', GLOBAL_FEED_TARGET_ID);
      const bounds =
        latest &&
        typeof latest.scoreVector['per_class_bounds'] === 'object' &&
        latest.scoreVector['per_class_bounds'] !== null
          ? (latest.scoreVector['per_class_bounds'] as Record<string, unknown>)
          : {};
      const gains = await latestMeriGains(events);
      const gain = typeof gains[storyId] === 'number' ? (gains[storyId] as number) : null;
      // Lineage context from the source model (always available, even
      // before the first MERI run): publisher + confirmed syndication.
      const source = story.sourceId ? await ingestion.sources.getById(story.sourceId) : null;
      const syndication = story.sourceId
        ? (await ingestion.syndications.listForSource(story.sourceId)).filter(
            (edge) => edge.status === 'confirmed',
          )
        : [];
      // Co-group members: which VISIBLE stories share this story's coverage
      // — near-duplicates by MinHash, plus stories from confirmed
      // syndication counterpart sources. Stored data only; no invariant
      // computation on page load.
      const threshold = resolveInvariants().config().meriNearDuplicateThreshold;
      const coGroup = new Map<string, 'near_duplicate' | 'syndicated'>();
      const signature = await ingestion.signatures.getByStoryId(storyId);
      if (signature) {
        const candidates = await ingestion.signatures.candidatesByBands(
          lshBandHashes(signature.minhash),
          storyId,
        );
        for (const candidateId of candidates) {
          const other = await ingestion.signatures.getByStoryId(candidateId);
          if (other && estimateJaccard(signature.minhash, other.minhash) >= threshold) {
            coGroup.set(candidateId, 'near_duplicate');
          }
        }
      }
      const counterpartSources = new Set(
        syndication.flatMap((edge) =>
          [edge.fromSourceId, edge.toSourceId].filter((id) => id !== story.sourceId),
        ),
      );
      if (counterpartSources.size > 0) {
        for (const recent of await ingestion.stories.listRecent(100)) {
          if (recent.storyId === storyId || !recent.sourceId) continue;
          if (counterpartSources.has(recent.sourceId) && !coGroup.has(recent.storyId)) {
            coGroup.set(recent.storyId, 'syndicated');
          }
        }
      }
      const coGroupStories = [];
      for (const [coStoryId, relationship] of coGroup) {
        if (coGroupStories.length >= 8) break;
        const member = await ingestion.stories.getById(coStoryId);
        if (!member || member.hiddenState !== null) continue;
        // Per-co-member read bar: a contained (room_only / private-room)
        // co-member never surfaces in a reader's lineage unless they can read it
        // directly — closes the cross-reference leak the raw MinHash/syndication
        // candidate sets would otherwise allow (NOT tier-scoped at the source).
        if (!(await storyReadableTo(forum, member, userId))) continue;
        coGroupStories.push({ story_id: coStoryId, title: member.title, relationship });
      }
      // Citations an evidence steward marked as PRIMARY SOURCES on this
      // story's conversation (STEWARD_ROLES.md ROLE_EVIDENCE) — reviewed
      // evidence metadata, deduplicated by URL.
      const primarySources = await primarySourcesForStory(resolveModeration(), storyId);
      return c.json({
        story_id: storyId,
        marginal_gain: gain,
        exposure_label: exposureLabelForGain(gain),
        redundancy_classes: Object.keys(bounds).length,
        source: source
          ? {
              name: source.name,
              publisher_lineage: (source.publisherLineage ?? []).map((entry) => entry.name),
            }
          : null,
        confirmed_syndication_count: syndication.length,
        co_group_stories: coGroupStories,
        primary_sources: primarySources,
      });
    });
}
