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
//     chosen scope.  `purge` IRREVERSIBLY removes the room's content across the
//     §24.2 categories — stories (taken down + their archived body excerpt nulled),
//     threads (terminally `archived`), ALL contributions of every member (hard-
//     deleted with their evidence cards + edit history + draft-dedup keys), derived
//     summaries (hard-deleted), media uploads (records AND bytes destroyed), lenses
//     (hard-deleted), and — derived from those — the search documents (a hidden
//     story + deleted contributions vanish from the index) — leaving only the
//     server-retained historical/audit artifacts the §24.2 closing sentence
//     mandates be disclosed (the immutable story id/title row, the append-only
//     content events, the ranking decision logs, and the review-queue history,
//     none of which can reconstruct the purged bodies).  `anonymize` keeps the
//     content readable but detaches the steward's authorship (the WS-Q DSAR path).
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
      /** WS-S.9 resumability — the OPAQUE P2P destination recorded at freeze. */
      migratedToRoomId: string | null;
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
  return {
    ok: true,
    roomId,
    roomName: room.name,
    frozen: room.frozen,
    migratedToRoomId: room.migratedToRoomId,
    items,
  };
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

/** The §24.2 categories minimized by a `purge`, reported honestly to the
 *  steward (counts only; never UGC bodies). */
export interface MigrationPurgeCounts {
  /** Stories taken down + their archived excerpt nulled. */
  stories: number;
  /** Threads terminally archived. */
  threads: number;
  /** Contributions hard-deleted (ALL members', any state). */
  contributions: number;
  /** Derived summaries hard-deleted. */
  summaries: number;
  /** Media uploads (records + bytes) destroyed. */
  uploads: number;
  /** Lenses hard-deleted. */
  lenses: number;
}

export type MigrationPurgeResult =
  | {
      ok: true;
      roomId: string;
      mode: 'purge' | 'anonymize';
      /** Backwards-compatible: the story count (taken down or anonymized). */
      storiesAffected: number;
      /** Per-category §24.2 minimization counts (purge mode; zeros for anonymize). */
      counts: MigrationPurgeCounts;
    }
  | { ok: false; status: 404; code: 'not_found'; message: string }
  | { ok: false; status: 409; code: 'room_not_frozen'; message: string }
  | { ok: false; status: 409; code: 'p2p_room_not_purgeable'; message: string };

const EMPTY_COUNTS: MigrationPurgeCounts = {
  stories: 0,
  threads: 0,
  contributions: 0,
  summaries: 0,
  uploads: 0,
  lenses: 0,
};

/**
 * Phase 6 — minimize the old server content.
 *
 * `purge` IRREVERSIBLY removes the room's content across the §24.2 categories
 * (stories taken down + body excerpt nulled; threads terminally archived; ALL
 * members' contributions + their evidence cards + edit history hard-deleted;
 * derived summaries hard-deleted; media uploads — records AND bytes — destroyed;
 * lenses hard-deleted; the search index follows, since it is DERIVED from the
 * now-hidden stories + deleted contributions).  What remains is only the
 * server-retained historical/audit artifacts the §24.2 closing sentence requires
 * be disclosed (the immutable story id/title row, the append-only content events,
 * the ranking decision logs, and the review-queue history) — none of which can
 * reconstruct the purged bodies.  `anonymize` keeps the content readable but
 * detaches the steward's authorship only (the WS-Q DSAR path).
 *
 * GATED on the room being FROZEN first (fail-closed) so the §8 disclosure stays
 * honest — content cannot vanish while the room still accepts writes.  Idempotent:
 * a re-run over already-purged content removes nothing.  Paged over the room's
 * stories so a large room is bounded.
 */
export async function purgeRoomForMigration(
  forum: ForumServices,
  ingestion: IngestionServices,
  actorUserId: string,
  actorRoles: readonly Role[],
  roomId: string,
  mode: 'purge' | 'anonymize',
  /** The per-pass page size (defaulted; injectable so a test can prove the pagination drains a
   *  room with MORE than one page of stories). */
  sweepLimit: number = MIGRATION_SWEEP_LIMIT,
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

  if (mode === 'anonymize') {
    // anonymize: detach the steward's authorship; all content stays readable.
    await anonymizeUserContent(ingestion, forum, actorUserId);
    const storiesAffected = (await ingestion.stories.listLiveByRoom(roomId, sweepLimit)).length;
    forum.metrics.increment('migration.anonymized');
    forum.log('forum.migration_purged', {
      room_id: roomId,
      mode,
      stories_affected: storiesAffected,
    });
    return { ok: true, roomId, mode, storiesAffected, counts: { ...EMPTY_COUNTS } };
  }

  // --- purge: irreversibly minimize EVERY §24.2 category for the room ---------
  const counts: MigrationPurgeCounts = { ...EMPTY_COUNTS };

  // Page over the room's LIVE stories.  Each pass collects the live stories' ids +
  // thread ids, hard-deletes the per-thread / per-story forum content, archives
  // the threads, and takes the stories down (nulling the archived body excerpt).
  // `listLiveByRoom` (not `listByRoom`+a JS filter) is essential: each pass hides a
  // batch, which DROPS OUT of the next query, so the window advances and the loop
  // drains EVERY live story — a plain `listByRoom` re-reads the same newest rows and
  // exits early once they are hidden, leaving older live stories published.
  for (;;) {
    const live = await ingestion.stories.listLiveByRoom(roomId, sweepLimit);
    if (live.length === 0) break;

    // Resolve each live story's thread (a story owns at most one shell here).
    const storyIds: string[] = [];
    const threadIds: string[] = [];
    for (const story of live) {
      storyIds.push(story.storyId);
      const thread = await ingestion.stories.getThreadByStoryId(story.storyId);
      if (thread !== null) threadIds.push(thread.threadId);
    }

    // Forum-owned content (hard delete): contributions (ALL members'), derived
    // summaries, and media uploads.  Order is irrelevant — each is independent.
    if (threadIds.length > 0) {
      counts.contributions += await forum.contributions.purgeByThreads(threadIds);
      counts.summaries += await forum.summaries.deleteByThreads(threadIds);
    }
    counts.uploads += await forum.uploads.purgeByStories(storyIds);

    // Threads: terminally archive (the WS-G conversation state's `archived` sink).
    for (const threadId of threadIds) {
      await ingestion.stories.updateThread(threadId, { conversationState: 'archived' });
      counts.threads += 1;
    }

    // Stories: take down (distribution + read kill, removes from search) AND null
    // the archived body excerpt so the indexed body content is gone too.
    for (const story of live) {
      await ingestion.stories.update(story.storyId, { hiddenState: 'takedown', excerpt: null });
      counts.stories += 1;
    }

    // A short page means there were fewer than a full page of LIVE stories left — the next
    // query would return none, so stop here (the top-of-loop empty check is the real terminator).
    if (live.length < sweepLimit) break;
  }

  // Lenses are room-scoped (not per-thread): purge once.
  counts.lenses += await forum.lenses.deleteByRoom(roomId);

  forum.metrics.increment('migration.purged');
  forum.log('forum.migration_purged', {
    room_id: roomId,
    mode,
    stories_affected: counts.stories,
    threads_archived: counts.threads,
    contributions_deleted: counts.contributions,
    summaries_deleted: counts.summaries,
    uploads_deleted: counts.uploads,
    lenses_deleted: counts.lenses,
  });
  return { ok: true, roomId, mode, storiesAffected: counts.stories, counts };
}
