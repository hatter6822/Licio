// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-D.2.4 / WS-G / WS-Q.3.5 — the forum-composed data-rights surface (the
// content half of DSAR export + account-purge anonymization).
//
//   • exportUserContent — a COMPLETE (§19.3 / GDPR Art. 15) listing of the
//     user's own stories, contributions, room subscriptions, and uploads,
//     keyset-paginated to exhaustion. Self-access is NOT bounded
//     by distribution: `room_only` content and private-room subscriptions are
//     exported, each tagged with its home room (`room_ref`) and visibility
//     tier so the subject sees exactly where each item lives (WS-Q.3.5).
//   • anonymizeUserContent — tombstones the author on every contribution /
//     upload across BOTH tiers (bodies persist per §22.4; the tombstoned user
//     row IS the anonymization) and REMOVES room memberships
//     and steward assignments (membership is personal data, incl. private
//     rooms).
//
// Extracted from the boot wiring so the composition is unit-testable end to end.
import { submissionText } from '../ingestion/pipeline.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { ForumServices } from './services.js';

const PAGE = 500;

export async function exportUserContent(
  ingestion: IngestionServices,
  forum: ForumServices,
  userId: string,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];

  // Stories (every visibility tier — self-access is unbounded by distribution).
  let storyAfter: { createdAt: string; storyId: string } | null = null;
  for (;;) {
    const page = await ingestion.stories.listBySubmitter(userId, storyAfter, PAGE);
    for (const story of page) {
      out.push({
        kind: 'story',
        story_id: story.storyId,
        title: story.title,
        submission_type: story.submissionType,
        canonical_url: story.canonicalUrl,
        // WS-Q.3.5 — tag the home room + visibility so room_only items are
        // identifiable as in-room content the subject authored.
        room_ref: story.roomId,
        visibility: story.visibility,
        body: submissionText(story),
        created_at: story.createdAt,
      });
    }
    if (page.length < PAGE) break;
    const last = page[page.length - 1];
    if (last === undefined) break;
    storyAfter = { createdAt: last.createdAt, storyId: last.storyId };
  }

  // Contributions (tier-agnostic — covers room_only threads).
  let contribAfter: { createdAt: string; id: string } | null = null;
  for (;;) {
    const page = await forum.contributions.listByUser(userId, contribAfter, PAGE);
    for (const row of page) {
      out.push({
        kind: 'contribution',
        contribution_id: row.contributionId,
        thread_id: row.threadId,
        type: row.type,
        body: row.body,
        citations: row.citations,
        metadata: row.metadata,
        moderation_state: row.moderationState,
        created_at: row.createdAt,
      });
    }
    if (page.length < PAGE) break;
    const last = page[page.length - 1];
    if (last === undefined) break;
    contribAfter = { createdAt: last.createdAt, id: last.contributionId };
  }

  // Room subscriptions — incl. private-room memberships, each tagged with the
  // room's visibility (WS-Q.3.5).
  for (const sub of await forum.rooms.listSubscriptionsByUser(userId)) {
    const room = await forum.rooms.getById(sub.roomId);
    out.push({
      kind: 'room_subscription',
      room_ref: sub.roomId,
      room_visibility: room?.visibility ?? null,
      status: sub.status,
      requested_at: sub.requestedAt,
    });
  }

  // Uploads: the user-provided record + same-origin retrieval URL (bytes stay
  // in the upload store, served only once scan-cleared).
  for (const upload of await forum.uploads.listByOwner(userId)) {
    out.push({
      kind: 'upload',
      upload_id: upload.uploadId,
      content_type: upload.contentType,
      byte_size: upload.byteSize,
      alt_text: upload.altText,
      url: `/v1/uploads/${upload.uploadId}`,
      metadata_stripped: upload.metadataStripped,
      scan_state: upload.scanState,
      created_at: upload.createdAt,
    });
  }

  return out;
}

export async function anonymizeUserContent(forum: ForumServices, userId: string): Promise<void> {
  await forum.contributions.anonymizeUser(userId);
  await forum.uploads.anonymizeUser(userId);
  await forum.rooms.anonymizeUser(userId);
}

/**
 * WS-S.9 (PRIVATE_SPEC §24.2 `anonymize`) — ROOM-SCOPED anonymize: detach `userId`'s authored
 * content in ONE room only (the migrated room), leaving their authorship in EVERY OTHER room
 * intact.  Resolves the room's stories + their thread ids, then tombstones the user's
 * contributions (by thread) and media uploads (by story).  Unlike
 * {@link anonymizeUserContent} (the account-wide DSAR path), this never reaches across rooms —
 * a steward who migrates one of their rooms keeps their authorship everywhere else.  Room
 * MEMBERSHIP is left untouched (the migrated room is frozen/purged, and membership is not
 * authored content).  Rooms are bounded by content count, so a single `sweepLimit` page of
 * stories covers the room.
 */
export async function anonymizeUserContentInRoom(
  ingestion: IngestionServices,
  forum: ForumServices,
  userId: string,
  roomId: string,
  sweepLimit: number,
): Promise<void> {
  const stories = await ingestion.stories.listByRoom(roomId, sweepLimit);
  const storyIds = stories.map((story) => story.storyId);
  const threadIds: string[] = [];
  for (const story of stories) {
    const thread = await ingestion.stories.getThreadByStoryId(story.storyId);
    if (thread !== null) threadIds.push(thread.threadId);
  }
  await forum.contributions.anonymizeUserByThreads(threadIds, userId);
  await forum.uploads.anonymizeUserByStories(storyIds, userId);
}
