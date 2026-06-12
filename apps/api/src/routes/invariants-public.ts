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
import { type ForumServices, getForumServices } from '../forum/services.js';
import { getIngestionServices, type IngestionServices } from '../ingestion/services.js';
import { getInvariantServices, type InvariantPlatformServices } from '../invariants/services.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';

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

/** Marginal gains from the latest stored MERI output (null when absent). */
export async function latestMeriGains(
  events: EventPipelineServices,
): Promise<Record<string, number>> {
  const latest = await events.invariantStore.latest('MERI', GLOBAL_FEED_TARGET_ID);
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

export function createInvariantsPublicRoutes(
  resolveEvents: () => EventPipelineServices = getEventPipelineServices,
  resolveIngestion: () => IngestionServices = getIngestionServices,
  resolveInvariants: () => InvariantPlatformServices = getInvariantServices,
  resolveForum: () => ForumServices = getForumServices,
) {
  return new Hono()
    .get('/stories/:storyId/interpretations', async (c) => {
      const storyId = c.req.param('storyId');
      if (!uuidSchema.safeParse(storyId).success) {
        return c.json(deny('invalid_story', 'storyId must be a UUID'), 422);
      }
      const ingestion = resolveIngestion();
      const story = await ingestion.stories.getById(storyId);
      // 404-over-403 + visibility gating: hidden stories expose nothing.
      if (!story || story.hiddenState !== null) {
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
        if (!member || member.hiddenState !== null) continue; // visibility-gated
        coGroupStories.push({ story_id: coStoryId, title: member.title, relationship });
      }
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
      });
    });
}
