// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — the server-side half of the server-room → Private-P2P-room migration
// (PRIVATE_SPEC §24).  A Members-only server room is NEVER upgraded in place:
//
//   • exportRoomForMigration  (phases 1/3 input) — an AUTHORIZED, READ-ONLY
//     listing of the migrating room's stories + their PUBLISHED contributions in
//     the `MigrationSourceItem` shape `@licio/private-p2p`'s `planMigration`
//     consumes.  The client picks an import mode, re-encrypts the chosen items
//     into the new P2P room, and authors them locally — the server never touches
//     P2P content (the §8 non-storage contract).  Authorization: only a room
//     STEWARD (or a platform steward/admin) may export — an outsider gets the
//     same not-authorized result, never a content/membership oracle.
//
//   • freezeRoomForMigration  (phase 5) — set the old room READ-ONLY and record
//     the OPAQUE client-side P2P destination id (a UUID, never an FK).  The
//     submission + contribution paths reject every write to a frozen room
//     (fail-closed, enforced in ingestion/submission.ts + forum/contributions.ts).
//
//   • purgeRoomForMigration   (phase 6) — minimize the OLD server content per the
//     chosen scope: `purge` takes the stories down + tombstones the steward's own
//     contributions (the WS-Q DSAR machinery), `anonymize` detaches authors only.
//     `purge` is GATED on the room already being frozen (phase 5 first) so the §8
//     disclosure stays honest — content cannot vanish while the room still accepts
//     writes.  A P2P room (no server content) and a non-existent room both refuse.
//
// Authorization is enforced via the WS-Q room-steward predicate (`isRoomSteward`),
// identical to the visibility-cascade + governance writes.  Logs/metrics carry
// ids + counts only (never UGC bodies).

import type { Role } from '../identity/rbac.js';
import { submissionText } from '../ingestion/pipeline.js';
import type { IngestionServices } from '../ingestion/services.js';
import { anonymizeUserContent } from './data-rights.js';
import { isRoomSteward } from './rooms.js';
import type { ForumServices } from './services.js';
import type { ContributionRecord } from './stores.js';

/** Bound for the per-room content sweep (rooms are bounded by content count). */
const MIGRATION_SWEEP_LIMIT = 10_000;
/** Bound for a thread's published contributions read. */
const THREAD_CONTRIB_LIMIT = 5_000;

/** A historical server item in the `planMigration` source shape. */
export interface MigrationSourceItem {
  readonly id: string;
  readonly kind: 'story' | 'contribution';
  readonly title?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly threadRef?: string;
  readonly parentRef?: string;
}

export type MigrationExportResult =
  | {
      ok: true;
      roomId: string;
      roomName: string;
      frozen: boolean;
      items: MigrationSourceItem[];
    }
  | { ok: false; status: 404; code: 'not_found'; message: string }
  | { ok: false; status: 409; code: 'p2p_room_not_exportable'; message: string };

function notAuthorized(): { ok: false; status: 404; code: 'not_found'; message: string } {
  // 404-over-403 (the WS-D.1.6a house rule): never confirm a room/steward role to
  // an outsider — the migrating-room oracle would otherwise leak membership.
  return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
}

/**
 * Phase 1/3 — read the old room's exportable content (stories + published
 * contributions), authorized to room/platform stewards only.
 */
export async function exportRoomForMigration(
  forum: ForumServices,
  ingestion: IngestionServices,
  actorUserId: string,
  actorRoles: readonly Role[],
  roomId: string,
): Promise<MigrationExportResult> {
  const room = await forum.rooms.getById(roomId);
  if (room === null) return notAuthorized();
  // Only a steward/owner of THIS room (or a platform steward/admin) may export.
  if (!(await isRoomSteward(forum, roomId, actorUserId, actorRoles))) {
    return notAuthorized();
  }
  // A Private P2P room holds NO server content (the §8 contract): there is
  // nothing to export, and a request for one is a coherence bug — refuse.
  if (room.storageMode === 'p2p') {
    return {
      ok: false,
      status: 409,
      code: 'p2p_room_not_exportable',
      message: 'A Private P2P room has no server content to export.',
    };
  }

  const items: MigrationSourceItem[] = [];

  // Stories in the room (every visibility tier — the steward exports the room's
  // own content). Paged by listByRoom; hidden (takedown/safety) stories are NOT
  // re-authored into the private room (they were removed for cause).
  const stories = await ingestion.stories.listByRoom(roomId, MIGRATION_SWEEP_LIMIT);
  for (const story of stories) {
    if (story.hiddenState !== null) continue;
    const thread = await ingestion.stories.getThreadByStoryId(story.storyId);
    const body = submissionText(story);
    items.push({
      id: story.storyId,
      kind: 'story',
      title: story.title,
      ...(body.length > 0 ? { body } : {}),
      ...(thread !== null ? { threadRef: thread.threadId } : {}),
    });

    // Published contributions of the story's thread, in source-item shape.
    if (thread !== null) {
      const contributions = await collectPublishedContributions(forum, thread.threadId);
      for (const contribution of contributions) {
        items.push({
          id: contribution.contributionId,
          kind: 'contribution',
          ...(contribution.body.length > 0 ? { body: contribution.body } : {}),
          threadRef: contribution.threadId,
          ...(contribution.parentContributionId !== null
            ? { parentRef: contribution.parentContributionId }
            : {}),
        });
      }
    }
  }

  forum.metrics.increment('migration.exported');
  forum.log('forum.migration_exported', {
    room_id: roomId,
    story_count: stories.length,
    item_count: items.length,
  });
  return { ok: true, roomId, roomName: room.name, frozen: room.frozen, items };
}

/** Read a thread's PUBLISHED contributions in causal (created-at) order. */
async function collectPublishedContributions(
  forum: ForumServices,
  threadId: string,
): Promise<ContributionRecord[]> {
  const out: ContributionRecord[] = [];
  let after: { createdAt: string; id: string } | null = null;
  for (;;) {
    const page = await forum.contributions.listByThread(threadId, {
      states: ['published'],
      after,
      limit: 500,
    });
    out.push(...page);
    if (page.length < 500 || out.length >= THREAD_CONTRIB_LIMIT) break;
    const last = page[page.length - 1];
    if (last === undefined) break;
    after = { createdAt: last.createdAt, id: last.contributionId };
  }
  return out;
}

export type MigrationFreezeResult =
  | { ok: true; roomId: string; migratedToRoomId: string | null }
  | { ok: false; status: 404; code: 'not_found'; message: string }
  | { ok: false; status: 409; code: 'p2p_room_not_freezable'; message: string };

/**
 * Phase 5 — freeze the old server room READ-ONLY (fail-closed: writes rejected)
 * and record the OPAQUE P2P destination id.  Steward-only; idempotent.
 */
export async function freezeRoomForMigration(
  forum: ForumServices,
  actorUserId: string,
  actorRoles: readonly Role[],
  roomId: string,
  migratedToRoomId: string | null,
): Promise<MigrationFreezeResult> {
  const room = await forum.rooms.getById(roomId);
  if (room === null) return notAuthorized();
  if (!(await isRoomSteward(forum, roomId, actorUserId, actorRoles))) {
    return notAuthorized();
  }
  if (room.storageMode === 'p2p') {
    return {
      ok: false,
      status: 409,
      code: 'p2p_room_not_freezable',
      message: 'A Private P2P room is not a server room and cannot be frozen.',
    };
  }
  const frozen = await forum.rooms.freeze(roomId, migratedToRoomId);
  if (frozen === null) return notAuthorized();
  forum.metrics.increment('migration.frozen');
  forum.log('forum.migration_frozen', {
    room_id: roomId,
    migrated_to_room_id: frozen.migratedToRoomId,
  });
  return { ok: true, roomId, migratedToRoomId: frozen.migratedToRoomId };
}

export type MigrationPurgeResult =
  | { ok: true; roomId: string; mode: 'purge' | 'anonymize'; storiesAffected: number }
  | { ok: false; status: 404; code: 'not_found'; message: string }
  | { ok: false; status: 409; code: 'room_not_frozen'; message: string }
  | { ok: false; status: 409; code: 'p2p_room_not_purgeable'; message: string };

/**
 * Phase 6 — minimize the old server content.  `purge` takes every story in the
 * room DOWN (the WS-Q takedown hidden_state, mirrored on the WS-G thread state is
 * the steward console's job; here the story-level `hiddenState='takedown'` is the
 * distribution + read kill) and tombstones the actor's own authored content;
 * `anonymize` detaches authors only.  Gated on the room being FROZEN first
 * (fail-closed) so the §8 disclosure stays honest.
 */
export async function purgeRoomForMigration(
  forum: ForumServices,
  ingestion: IngestionServices,
  actorUserId: string,
  actorRoles: readonly Role[],
  roomId: string,
  mode: 'purge' | 'anonymize',
): Promise<MigrationPurgeResult> {
  const room = await forum.rooms.getById(roomId);
  if (room === null) return notAuthorized();
  if (!(await isRoomSteward(forum, roomId, actorUserId, actorRoles))) {
    return notAuthorized();
  }
  if (room.storageMode === 'p2p') {
    return {
      ok: false,
      status: 409,
      code: 'p2p_room_not_purgeable',
      message: 'A Private P2P room has no server content to purge.',
    };
  }
  // Fail-closed: never minimize a room that still accepts writes (the §8
  // disclosure would be dishonest — content could reappear).
  if (!room.frozen) {
    return {
      ok: false,
      status: 409,
      code: 'room_not_frozen',
      message: 'Freeze the room (phase 5) before purging or minimizing its content.',
    };
  }

  let storiesAffected = 0;
  if (mode === 'purge') {
    // Take every (non-already-hidden) story in the room down — removed from
    // distribution + reads exactly like a takedown.  Paged + idempotent: a
    // re-run skips already-hidden stories.
    for (;;) {
      const batch = await ingestion.stories.listByRoom(roomId, MIGRATION_SWEEP_LIMIT);
      const live = batch.filter((story) => story.hiddenState === null);
      if (live.length === 0) break;
      for (const story of live) {
        await ingestion.stories.update(story.storyId, { hiddenState: 'takedown' });
        storiesAffected += 1;
      }
      if (batch.length < MIGRATION_SWEEP_LIMIT) break;
    }
    // Tombstone the steward's OWN authored content across both tiers (the WS-Q
    // DSAR anonymize machinery): a steward purging the room they founded removes
    // their authorship from what remains.  (Per-member purge is each member's own
    // DSAR right — the steward cannot tombstone other members' authorship.)
    await anonymizeUserContent(ingestion, forum, actorUserId);
    forum.metrics.increment('migration.purged');
  } else {
    // anonymize: detach the steward's authorship; stories stay readable.
    await anonymizeUserContent(ingestion, forum, actorUserId);
    storiesAffected = (await ingestion.stories.listByRoom(roomId, MIGRATION_SWEEP_LIMIT)).filter(
      (story) => story.hiddenState === null,
    ).length;
    forum.metrics.increment('migration.anonymized');
  }
  forum.log('forum.migration_purged', { room_id: roomId, mode, stories_affected: storiesAffected });
  return { ok: true, roomId, mode, storiesAffected };
}
