// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.3.3b / 3.4 — steward room-axis writes (SPEC §16.2/§14.5.2/§16.1).
//
//   • updateRoomGovernanceSettings — change join_model / posting_policy freely
//     (audited `forum_config_change`). A VISIBILITY change is REJECTED here and
//     pointed at the cascade endpoint, because flipping visibility must cascade
//     content (it is not a plain settings write).
//   • changeRoomVisibility — the audited public⇄private cascade:
//       public → private: force every public story room_only via an idempotent
//         per-story sweep, each emitting `content.visibility.changed`
//         (trigger=room_visibility_change); flip the room + collapse an `open`
//         join model to `request_approval`; one summary room-audit record.
//         Re-running skips already-converted stories (resumable/idempotent).
//       private → public: make the room readable by all, auto-publish NO
//         content (every story stays room_only until its author widens it).
import { randomUUID } from 'node:crypto';
import {
  contentVisibilityChangedEventSchema,
  type RoomJoinModel,
  type RoomPostingPolicy,
  type RoomVisibility,
  TOPIC_REGISTRY,
} from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { StoryPageCursor } from '../ingestion/stores.js';
import {
  isCheckViolation,
  isTierUniqueViolation,
  TIER_COLLISION_RETRIES,
} from '../lib/pg-errors.js';
import type { ForumServices } from './services.js';

/** Bound for the cascade sweep (rooms are bounded by content count). */
const CASCADE_SWEEP_LIMIT = 10_000;

export type GovernanceSettingsOutcome =
  | { ok: true }
  | { ok: false; status: 404; code: 'not_found'; message: string }
  | { ok: false; status: 422; code: 'visibility_not_settable'; message: string };

/** WS-Q.3.3b — change join_model/posting_policy (NOT visibility) on a room. */
export async function updateRoomGovernanceSettings(
  forum: ForumServices,
  identity: IdentityServices,
  actorUserId: string,
  roomId: string,
  patch: { joinModel?: RoomJoinModel; postingPolicy?: RoomPostingPolicy; visibility?: unknown },
): Promise<GovernanceSettingsOutcome> {
  if (patch.visibility !== undefined) {
    return {
      ok: false,
      status: 422,
      code: 'visibility_not_settable',
      message:
        'Visibility changes cascade content — use POST /v1/rooms/{id}/visibility, not the settings write',
    };
  }
  const room = await forum.rooms.getById(roomId);
  if (room === null)
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  // WS-S §8: a member-hosted (p2p) room's stub accepts NO server-side
  // administration — its join model/posting policy live in the members'
  // MLS-governed state, and the DB pins the stub's axes with CHECKs.  The
  // action surface behaves as absent (404-over-403), matching the stores.ts
  // doctrine note that WS-Q guards reject p2p rooms before any side effect.
  if (room.storageMode !== 'server')
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  // Coherence (§16.2): a PUBLIC room only admits the `open` join model.
  const joinModel = room.visibility === 'public' ? 'open' : (patch.joinModel ?? room.joinModel);
  await forum.rooms.update(roomId, {
    joinModel,
    ...(patch.postingPolicy !== undefined ? { postingPolicy: patch.postingPolicy } : {}),
  });
  await identity.audit.append({
    actorUserId,
    eventType: 'forum_config_change',
    targetRef: roomId,
    context: {
      setting: 'room_governance',
      new_value: JSON.stringify({
        join_model: joinModel,
        posting_policy: patch.postingPolicy ?? room.postingPolicy,
      }).slice(0, 256),
    },
  });
  forum.metrics.increment('rooms.governance_settings_changed');
  return { ok: true };
}

export type RoomVisibilityOutcome =
  | { ok: true; converted: number }
  | { ok: false; status: 404; code: 'not_found'; message: string }
  | {
      ok: false;
      status: 409;
      code: 'duplicate_story';
      message: string;
      /** The public stories the sweep could not contain, so an operator can
       *  resolve each duplicate and retry. */
      blockedStoryIds: readonly string[];
    }
  /** A story became public between the last sweep read and the room flip, which
   *  migration 0110's trigger refuses.  Distinct from `duplicate_story` because
   *  the remedy is a plain retry and because that variant's wire schema requires
   *  a NON-EMPTY blocker list. */
  | { ok: false; status: 409; code: 'visibility_race'; message: string };

/** WS-Q.3.4 — the audited public⇄private room-visibility cascade. */
export async function changeRoomVisibility(
  forum: ForumServices,
  ingestion: IngestionServices,
  events: EventPipelineServices,
  identity: IdentityServices,
  actorUserId: string,
  roomId: string,
  target: RoomVisibility,
  /** Page size for the per-story sweep.  Injectable so a test can drive the
   *  PAGING (a 10k default page hides every boundary the cursor exists for). */
  sweepLimit: number = CASCADE_SWEEP_LIMIT,
): Promise<RoomVisibilityOutcome> {
  const room = await forum.rooms.getById(roomId);
  if (room === null)
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  // WS-S §8: a p2p stub's visibility is pinned 'private' (DB CHECK
  // rooms_p2p_visibility_private); the server-side cascade must refuse it
  // BEFORE any side effect — in production the CHECK would abort the write
  // mid-cascade, and in-memory nothing would stop it (a dev↔prod divergence).
  if (room.storageMode !== 'server')
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  if (room.visibility === target) return { ok: true, converted: 0 };
  const nowIso = new Date(forum.now()).toISOString();
  let converted = 0;
  /** Public stories a tier-unique collision refused to contain (see below).  A
   *  SET, because a blocked story stays public: without the cursor below it
   *  reappeared in every page and was reported once per pass. */
  const blocked = new Set<string>();

  /**
   * Contain ONE public story: the tier flip, its `content.visibility.changed`
   * event, and the counters — in one place because there are TWO sweeps below
   * (the cursored pass and the final uncursored straggler pass) and a story
   * converted by one of them must be indistinguishable from a story converted
   * by the other.  Two call sites emitting different side effects for the same
   * transition is how a downstream consumer learns about only some of them.
   *
   * Returns true when the story was contained, false when a tier-unique
   * collision refused it (recorded in `blocked`).
   */
  const containStory = async (story: {
    storyId: string;
    canonicalUrl: string | null;
  }): Promise<boolean> => {
    // SYMMETRIC WITH `changeStoryVisibility`, which performs the identical write in
    // the identical privacy-reducing direction.  That path discriminates on the
    // CONSTRAINT NAME and retries a refusal whose incumbent has vanished; this one
    // did neither, so:
    //   • any unique violation was relabelled `duplicate_story` — a
    //     `stories_media_upload_ref_uq` refusal was reported to a steward as "shares a
    //     link with an existing in-room story", a claim the code never verified;
    //   • a blocker that no longer existed left the story public and the ROOM public,
    //     which is a privacy-reducing operation failing for a stale reason — at room
    //     scale rather than one story.
    // A blocked story is filtered out of the straggler sweep, so it is not
    // re-attempted in this request either.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await ingestion.stories.update(story.storyId, { visibility: 'room_only' });
        break;
      } catch (error) {
        // `stories_canonical_url_room_uq` is a partial unique on
        // `(canonical_url, room_id) where visibility = 'room_only'`, and a room
        // may legitimately hold BOTH a public story and a room_only one for the
        // same link — `ingestion/submission.ts` records the cross-tier pointer
        // for exactly that pair.  Converting the public copy then collides with
        // its in-room twin.
        //
        // Unhandled, that 23505 escaped the loop as a 500 with the room still
        // PUBLIC and an arbitrary prefix of its stories already converted — a
        // containment failure reported as a server error.  Caught here so the
        // sweep finishes every story it CAN contain, and the room flip is skipped:
        // a room that still holds public content must not be marked private,
        // because the `room.visibility === target` short-circuit at the top would
        // then answer a retry with `{ ok: true, converted: 0 }` and the content
        // would stay published.
        if (!isTierUniqueViolation(error)) throw error;
        // A story with NO canonical URL occupies no URL slot, so it cannot have
        // collided with a twin — reporting it to the steward as a link duplicate
        // gave them nothing to resolve.
        const twin =
          story.canonicalUrl === null
            ? null
            : await ingestion.stories.getByCanonicalUrl(story.canonicalUrl, {
                visibility: 'room_only',
                roomId,
              });
        // The incumbent may have been hidden, deleted or moved between the refusal and
        // this lookup, after which the write would succeed.
        if (twin === null && attempt < TIER_COLLISION_RETRIES) continue;
        // Still refused with no incumbent to name: the constraint is real but its
        // holder is not readable here.  A 500 on an unexplainable refusal is honest; a
        // blocker the steward can never resolve is not.
        if (twin === null) throw error;
        blocked.add(story.storyId);
        ingestion.metrics.increment('rooms.visibility_cascade_duplicate');
        return false;
      }
    }
    const event = contentVisibilityChangedEventSchema.parse({
      event_id: randomUUID(),
      event_type: 'content.visibility.changed',
      timestamp: nowIso,
      schema_version: '1',
      story_id: story.storyId,
      room_id: roomId,
      from: 'public',
      to: 'room_only',
      trigger: 'room_visibility_change',
      actor_ref: actorUserId,
      privacy_classification: 'public',
      retention_tier: 'public_contribution',
    });
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
        ownerUserId: actorUserId,
        purgeAfter: null,
      },
    ]);
    ingestion.trackBackground(events.router.publish(event));
    converted += 1;
    return true;
  };

  if (target === 'private') {
    // Per-story sweep: force every PUBLIC story room_only. PAGED until none
    // remain — converting a story to room_only removes it from the public-only
    // query, so each page is a fresh batch of the remaining public stories (a
    // room with >CASCADE_SWEEP_LIMIT public stories is fully converted, not just
    // its newest page). Idempotent: a crash mid-cascade resumes cleanly.
    let cursor: StoryPageCursor | undefined;
    for (;;) {
      const batch = await ingestion.stories.listByRoom(roomId, sweepLimit, 'public', cursor);
      if (batch.length === 0) break;
      for (const story of batch) {
        await containStory(story);
      }
      // A short page means no public stories remain — the sweep is complete.
      if (batch.length < sweepLimit) break;
      // ADVANCE PAST this page.  Converting a story drops it from the `public`
      // filter, but a BLOCKED one stays public, so a cursor-less re-query
      // returns those same rows for ever — and the old guard (`converted === 0`)
      // could never fire once any earlier page had converted something, because
      // that counter is cumulative.  Two failures in one: an unterminating
      // request, and — while it spun — the same blocked ids appended once per
      // pass into a count the steward was meant to act on.  The cursor visits
      // each story exactly once, so the sweep converts everything it CAN even
      // when a whole page ahead of them is blocked, and terminates in
      // ceil(N / sweepLimit) passes.
      const last = batch[batch.length - 1];
      if (last === undefined) break;
      cursor = { createdAt: last.createdAt, storyId: last.storyId };
    }
    // A FINAL UNCURSORED SWEEP, because the cursor only moves one way.  A
    // submission that read the room as still public can land AFTER its page was
    // fetched, and its `createdAt` sorts ABOVE the cursor — so every later
    // cursored page excludes it and the room could flip to private with that
    // story still `public`.  Worse than a missed conversion: the retry path
    // short-circuits on `room.visibility === target`, so nothing ever revisits
    // it, and making the room public again would re-publish content the steward
    // had already contained.  The cursor made this window wider than the
    // fresh-page query it replaced, so closing it is part of that change, not a
    // separate concern.
    //
    // Bounded: this pass converts only what the cursored sweep could not have
    // seen, so on a quiet room it reads one short page and stops.  A submission
    // racing THIS pass is caught by the tier-unique index and reported as a
    // blocker rather than silently left public.
    for (;;) {
      const stragglers = await ingestion.stories.listByRoom(roomId, sweepLimit, 'public');
      const pending = stragglers.filter((story) => !blocked.has(story.storyId));
      if (pending.length === 0) break;
      let convertedHere = 0;
      for (const story of pending) {
        if (await containStory(story)) convertedHere += 1;
      }
      // Nothing moved and nothing new was blocked ⇒ no progress is possible.
      if (convertedHere === 0) break;
    }
    if (blocked.size > 0) {
      return {
        ok: false,
        status: 409,
        code: 'duplicate_story',
        message:
          `${blocked.size} public ${blocked.size === 1 ? 'story shares' : 'stories share'} ` +
          'a link with an existing in-room story and cannot be converted. Resolve the ' +
          'duplicates, then retry — the room is still public and every other story is ' +
          'already contained.',
        blockedStoryIds: [...blocked],
      };
    }
    // Flip the room; collapse an `open` join model (incoherent once private →
    // a request-approval gate) — active memberships are retained.
    //
    // THE FLIP CAN NOW REFUSE, and that is the point.  Every read above happens
    // before this write, so a story that becomes public in between — a fresh
    // submission whose `deriveStoryVisibility` saw the room still public, or an
    // author widen that read the room and then awaited two more queries — was
    // never revisited and survived the flip.  Migration 0110's
    // `rooms_visibility_no_public_stories` trigger makes that impossible: the
    // room cannot go private while a public story remains.  A straggler
    // therefore fails HERE, and the honest answer is the 409 this function
    // already returns for blockers, not a 500.
    try {
      await forum.rooms.update(roomId, {
        visibility: 'private',
        ...(room.joinModel === 'open' ? { joinModel: 'request_approval' as const } : {}),
      });
    } catch (error) {
      if (!isCheckViolation(error)) throw error;
      // The straggler's id is deliberately not read back: doing so is another
      // race, and the caller's remedy is the same either way — retry, which now
      // sweeps the story that appeared.  The room is still public and every
      // story converted so far stays converted, so the retry is cheap.
      // A DISTINCT CODE, because it is a distinct condition and because
      // `roomVisibilityConflictSchema` requires `blocked_story_ids` to be
      // NON-EMPTY — reusing `duplicate_story` with an empty list would make the
      // route's own `.parse()` throw and turn a clean 409 into a 500.
      return {
        ok: false,
        status: 409,
        code: 'visibility_race',
        message:
          'A story in this room became public while it was being converted. ' +
          'The room is still public and every other story is already contained — retry to finish.',
      };
    }
  } else {
    // private → public: the room becomes readable by all; content is untouched
    // (every story stays room_only until its author widens it). A public room
    // MUST use the `open` join model (the rooms_public_join_open CHECK), so a
    // request_approval/invite private room is reset to open as it publishes.
    await forum.rooms.update(roomId, { visibility: 'public', joinModel: 'open' });
  }

  await identity.audit.append({
    actorUserId,
    eventType: 'room_visibility_change',
    targetRef: roomId,
    context: {
      setting: 'room_visibility',
      previous_value: room.visibility,
      new_value: target,
      reason: `${converted} stories converted`,
    },
  });
  forum.metrics.increment(`rooms.visibility_${target}`);
  return { ok: true, converted };
}
