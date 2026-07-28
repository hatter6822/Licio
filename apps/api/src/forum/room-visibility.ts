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
import { isUniqueViolation } from '../lib/pg-errors.js';
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
    };

/** WS-Q.3.4 — the audited public⇄private room-visibility cascade. */
export async function changeRoomVisibility(
  forum: ForumServices,
  ingestion: IngestionServices,
  events: EventPipelineServices,
  identity: IdentityServices,
  actorUserId: string,
  roomId: string,
  target: RoomVisibility,
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
  /** Public stories a tier-unique collision refused to contain (see below). */
  const blocked: string[] = [];

  if (target === 'private') {
    // Per-story sweep: force every PUBLIC story room_only. PAGED until none
    // remain — converting a story to room_only removes it from the public-only
    // query, so each page is a fresh batch of the remaining public stories (a
    // room with >CASCADE_SWEEP_LIMIT public stories is fully converted, not just
    // its newest page). Idempotent: a crash mid-cascade resumes cleanly.
    for (;;) {
      const batch = await ingestion.stories.listByRoom(roomId, CASCADE_SWEEP_LIMIT, 'public');
      if (batch.length === 0) break;
      for (const story of batch) {
        try {
          await ingestion.stories.update(story.storyId, { visibility: 'room_only' });
        } catch (error) {
          // `stories_canonical_url_room_uq` is a partial unique on
          // `(canonical_url, room_id) where visibility = 'room_only'`, and a
          // room may legitimately hold BOTH a public story and a room_only one
          // for the same link — `ingestion/submission.ts` records the
          // cross-tier pointer for exactly that pair.  Converting the public
          // copy then collides with its in-room twin.
          //
          // Unhandled, that 23505 escaped the loop as a 500 with the room still
          // PUBLIC and an arbitrary prefix of its stories already converted —
          // a containment failure reported as a server error.  It is caught
          // here so the sweep finishes every story it CAN contain, and the room
          // flip below is skipped: a room that still holds public content must
          // not be marked private, because the `room.visibility === target`
          // short-circuit at the top would then answer a retry with
          // `{ ok: true, converted: 0 }` and the content would stay published.
          if (!isUniqueViolation(error)) throw error;
          blocked.push(story.storyId);
          ingestion.metrics.increment('rooms.visibility_cascade_duplicate');
          continue;
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
      }
      // A short page means no public stories remain — the sweep is complete.
      if (batch.length < CASCADE_SWEEP_LIMIT) break;
      // Every story in this page was blocked, so the next `listByRoom` returns
      // the same rows: page forward would loop for ever.  Stop and report.
      if (blocked.length >= batch.length && converted === 0) break;
    }
    if (blocked.length > 0) {
      return {
        ok: false,
        status: 409,
        code: 'duplicate_story',
        message:
          `${blocked.length} public ${blocked.length === 1 ? 'story shares' : 'stories share'} ` +
          'a link with an existing in-room story and cannot be converted. Resolve the ' +
          'duplicates, then retry — the room is still public and every other story is ' +
          'already contained.',
        blockedStoryIds: blocked,
      };
    }
    // Flip the room; collapse an `open` join model (incoherent once private →
    // a request-approval gate) — active memberships are retained.
    await forum.rooms.update(roomId, {
      visibility: 'private',
      ...(room.joinModel === 'open' ? { joinModel: 'request_approval' as const } : {}),
    });
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
