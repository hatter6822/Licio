// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.2.4 — author-driven content-visibility transitions (SPEC §14.5.2).
//
//   • NARROW (public → room_only): always available to the author; idempotent;
//     audited; emits `content.visibility.changed` (trigger=author) only on a
//     real change. The serving-side distribution gate (WS-Q.4.2a) makes any
//     async reindex gap safe, so the change takes effect on the next serve.
//   • WIDEN (room_only → public): allowed ONLY when the home room is public
//     (private-room widen ⇒ 422, §14.5.1). Widening re-runs the FULL public
//     admission path the item skipped while in-room — the canonical-URL
//     takedown denylist, tier-scoped exact-URL dedup (409 + pointer on
//     collision), and the public near-dup cluster (its stored signature makes
//     this a query, not a recompute) — so an item never enters the public tier
//     unscreened.

import { randomUUID } from 'node:crypto';
import {
  type ContentVisibilityChangedEvent,
  contentVisibilityChangedEventSchema,
  type StoryVisibility,
  TOPIC_REGISTRY,
} from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import type { ForumServices } from '../forum/services.js';
import type { IdentityServices } from '../identity/services.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/pg-errors.js';
import { findNearDuplicates, loadStoredSignature, signatureStory } from './dedup.js';
import { submissionText } from './pipeline.js';
import type { IngestionServices } from './services.js';

/** Extra attempts when a tier-unique refusal names no readable winner — the
 *  incumbent vanished between the refusal and the lookup, so the write can now
 *  succeed. */
const VISIBILITY_COLLISION_RETRIES = 2;

export type VisibilityChangeOutcome =
  | { ok: true; changed: boolean; visibility: StoryVisibility }
  | { ok: false; status: 404; code: 'not_found'; message: string }
  | { ok: false; status: 422; code: 'private_room_widen'; message: string }
  | {
      ok: false;
      status: 409;
      code: 'duplicate_story';
      message: string;
      existingStoryId: string;
    };

/** Emit `content.visibility.changed` durably, then publish (detached-safe). */
async function emitVisibilityChanged(
  events: EventPipelineServices,
  event: ContentVisibilityChangedEvent,
): Promise<void> {
  const entry = TOPIC_REGISTRY['content.visibility.changed'];
  await events.eventStore.insertMany([
    {
      eventId: event.event_id,
      eventType: event.event_type,
      topic: event.event_type,
      timestamp: event.timestamp,
      privacyClassification: entry.privacy_classification,
      retentionTier: entry.retention_tier,
      payload: event as unknown as Record<string, unknown>,
      ownerUserId: event.actor_ref,
      purgeAfter: null,
    },
  ]);
  await events.router.publish(event);
}

export async function changeStoryVisibility(
  ingestion: IngestionServices,
  events: EventPipelineServices,
  identity: IdentityServices,
  forum: ForumServices,
  userId: string,
  storyId: string,
  target: StoryVisibility,
): Promise<VisibilityChangeOutcome> {
  const story = await ingestion.stories.getById(storyId);
  // Author-only (404-over-403): a non-author / unknown story gets 404 (no
  // ownership oracle); editors/stewards do NOT narrow another author's item.
  if (story === null || story.submittedBy !== userId || story.hiddenState !== null) {
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  }
  // Idempotent: a no-op change emits no event.
  if (story.visibility === target) {
    return { ok: true, changed: false, visibility: target };
  }
  const nowIso = new Date(ingestion.now()).toISOString();

  if (target === 'public') {
    // WIDEN — only in a public room (§14.5.1).
    const room = await forum.rooms.getById(story.roomId);
    if (room === null || room.visibility !== 'public') {
      return {
        ok: false,
        status: 422,
        code: 'private_room_widen',
        message: 'A story in a private room cannot become public (§14.5.1)',
      };
    }
    if (story.canonicalUrl !== null) {
      // Takedown denylist + tier-scoped public exact-URL dedup (re-screen).
      if (await ingestion.stories.hasHiddenForUrl(story.canonicalUrl)) {
        return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
      }
      const existingPublic = await ingestion.stories.getByCanonicalUrl(story.canonicalUrl, {
        visibility: 'public',
      });
      if (existingPublic !== null) {
        ingestion.metrics.increment('visibility.widen_url_collision');
        return {
          ok: false,
          status: 409,
          code: 'duplicate_story',
          message: 'A public story already exists for this link',
          existingStoryId: existingPublic.storyId,
        };
      }
    }
  } else if (story.canonicalUrl !== null) {
    // NARROW — the SAME admission screen, against the room-scoped tier.
    //
    // `stories_canonical_url_room_uq` is a partial unique on
    // `(canonical_url, room_id) where visibility = 'room_only' and hidden_state
    // is null`, so flipping a public story to `room_only` inserts it into an
    // index a pre-existing room_only twin of the same URL already occupies.
    // The widen branch above screens for exactly this and answers 409; the
    // narrow branch screened for nothing, so the same collision surfaced as an
    // unhandled 23505 — a 500 — and the story stayed PUBLIC. A story the author
    // asked to take out of public view remaining public is the wrong direction
    // for a failure to fall.
    const existingRoomOnly = await ingestion.stories.getByCanonicalUrl(story.canonicalUrl, {
      visibility: 'room_only',
      roomId: story.roomId,
    });
    if (existingRoomOnly !== null) {
      ingestion.metrics.increment('visibility.narrow_url_collision');
      return {
        ok: false,
        status: 409,
        code: 'duplicate_story',
        message: 'An in-room story already exists for this link',
        existingStoryId: existingRoomOnly.storyId,
      };
    }
  }

  // The screens above are a read followed by a write, so two concurrent
  // changes can both pass them.  The database still refuses the second, and
  // that refusal names the same DUPLICATE the screen does — reported as such
  // rather than escaping as a 500.  Only the two canonical-URL tier uniques
  // mean "duplicate story"; any other constraint is a different bug and must
  // keep propagating rather than be relabelled.
  const tierUniques = ['stories_canonical_url_public_uq', 'stories_canonical_url_room_uq'];
  let updated: Awaited<ReturnType<typeof ingestion.stories.update>>;
  // RETRY when the blocker turns out to be GONE.  The refusal and the lookup
  // that names the winner are two statements, and between them the incumbent
  // can be hidden, deleted, or moved to another tier — after which the write
  // this refused would succeed.  Reporting the caller's OWN story as the
  // duplicate (`winner?.storyId ?? storyId`) was false on its face and, for a
  // narrowing request, left the story PUBLIC because of a blocker that no
  // longer existed: a privacy-reducing operation failing for a stale reason,
  // which is the direction that must never be quietly accepted.
  for (let attempt = 0; ; attempt += 1) {
    try {
      updated = await ingestion.stories.update(storyId, { visibility: target });
      break;
    } catch (error) {
      if (!isUniqueViolation(error) || !tierUniques.includes(uniqueViolationConstraint(error))) {
        throw error;
      }
      const widening = target === 'public';
      const winner =
        story.canonicalUrl === null
          ? null
          : await ingestion.stories.getByCanonicalUrl(
              story.canonicalUrl,
              widening
                ? { visibility: 'public' }
                : { visibility: 'room_only', roomId: story.roomId },
            );
      if (winner === null && attempt < VISIBILITY_COLLISION_RETRIES) continue;
      ingestion.metrics.increment(
        widening ? 'visibility.widen_url_collision' : 'visibility.narrow_url_collision',
      );
      // Still refused with no winner to name after the retries: the constraint
      // is real but its holder is not readable here, so rethrow rather than
      // invent an incumbent.  A 500 on an unexplainable refusal is honest; a
      // 409 naming the caller's own story is not.
      if (winner === null) throw error;
      return {
        ok: false,
        status: 409,
        code: 'duplicate_story',
        message: widening
          ? 'A public story already exists for this link'
          : 'An in-room story already exists for this link',
        existingStoryId: winner.storyId,
      };
    }
  }
  if (updated === null) {
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  }

  // WIDEN re-runs the public near-dup cluster (a query over the stored
  // signature) so a near-duplicate-but-not-exact item gets the normal review
  // routing — it never enters the public tier unscreened.
  if (target === 'public') {
    const config = ingestion.config();
    // REUSE the story's existing accurate signature rather than re-signing.
    // WS-Q.2.2c stores a signature for every story, so widening a LINK that
    // already completed extraction finds its `extracted` article signature
    // here — re-signing from submissionText (a link's thin title+reason NOTE)
    // would clobber it and make this first public screen miss real article
    // duplicates or flag note-similar links. Sign the submitted text only when
    // no signature exists yet (an inline story always has its submitted one;
    // a link whose extraction is still pending gets a stopgap, and the later
    // `extracted` screen re-runs the accurate public pass once the article lands).
    const { signature, bands } =
      (await loadStoredSignature(ingestion.signatures, storyId)) ??
      (await signatureStory(ingestion.signatures, storyId, submissionText(updated), 'submitted'));
    const similar = await findNearDuplicates(
      ingestion.signatures,
      ingestion.stories,
      storyId,
      signature,
      bands,
      config.nearDuplicateThreshold,
      5,
    );
    if (similar.length > 0) {
      await ingestion.reviewQueue.insert({
        kind: 'near_duplicate',
        storyId,
        context: {
          similar: similar.map((s) => ({ story_id: s.storyId, estimate: s.estimatedJaccard })),
          text_source: 'widen',
        },
        status: 'pending',
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        notBefore: null,
      });
      ingestion.metrics.increment('dedup.flagged_near_duplicate_widen');
    }
  }

  await identity.audit.append({
    actorUserId: userId,
    eventType: 'story_visibility_change',
    targetRef: storyId,
    context: { setting: 'visibility', previous_value: story.visibility, new_value: target },
  });
  const event = contentVisibilityChangedEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'content.visibility.changed',
    timestamp: nowIso,
    schema_version: '1',
    story_id: storyId,
    room_id: story.roomId,
    from: story.visibility,
    to: target,
    trigger: 'author',
    actor_ref: userId,
    privacy_classification: 'public',
    retention_tier: 'public_contribution',
  });
  ingestion.trackBackground(emitVisibilityChanged(events, event));
  ingestion.metrics.increment(target === 'public' ? 'visibility.widened' : 'visibility.narrowed');
  return { ok: true, changed: true, visibility: target };
}
