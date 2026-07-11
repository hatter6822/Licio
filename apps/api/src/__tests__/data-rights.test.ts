// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.3.5 — DSAR export + account-purge anonymization across BOTH visibility
// tiers. Self-access is not bounded by distribution: a user's room_only content
// and private-room subscription appear in their export tagged with room_ref +
// visibility; a purge tombstones contributions across tiers and strips the
// private-room membership.
import { randomUUID } from 'node:crypto';
import { COMMONS_ROOM_ID, DEFAULT_ROOM_NOTIFICATION_PREFERENCES } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { anonymizeUserContent, exportUserContent } from '../forum/data-rights.js';
import type { RoomRecord } from '../forum/stores.js';
import { type ForumServicesFixture, freshForumServices, seedThread } from './forum-test-helpers.js';

let fixture: ForumServicesFixture;

beforeEach(() => {
  fixture = freshForumServices({ forumConfig: { contributionsPerMinute: 1000 } });
});

function privateRoomInput(over: Partial<Omit<RoomRecord, 'createdAt' | 'updatedAt'>> = {}) {
  const suffix = randomUUID().slice(0, 8);
  return {
    roomId: randomUUID(),
    name: `Private Room ${suffix}`,
    slug: `private-room-${suffix}`,
    description: 'A members-only room.',
    roomType: 'global_topic' as const,
    visibility: 'private' as const,
    joinModel: 'request_approval' as const,
    postingPolicy: 'all_members' as const,
    createdBy: randomUUID(),
    governanceMode: 'ordinary' as const,
    charterSummary: null,
    typeMetadata: {},
    latestActivityAt: null,
    ...over,
  };
}

function activeSubscription(roomId: string, userId: string) {
  const nowIso = new Date().toISOString();
  return {
    roomId,
    userId,
    status: 'active' as const,
    requestId: randomUUID(),
    lensId: null,
    notificationPreferences: DEFAULT_ROOM_NOTIFICATION_PREFERENCES,
    requestedAt: nowIso,
    joinedAt: nowIso,
  };
}

describe('WS-Q.3.5 — data-rights export across tiers', () => {
  it('exports public and room_only stories, each tagged with room_ref + visibility', async () => {
    const userId = randomUUID();
    const room = privateRoomInput();
    const created = await fixture.forum.rooms.insert(room);
    expect(created.ok).toBe(true);

    await seedThread(fixture, {
      submittedBy: userId,
      roomId: COMMONS_ROOM_ID,
      visibility: 'public',
      title: 'Public story',
    });
    await seedThread(fixture, {
      submittedBy: userId,
      roomId: room.roomId,
      visibility: 'room_only',
      title: 'In-room story',
    });

    const archive = await exportUserContent(fixture.ingestion, fixture.forum, userId);
    const stories = archive.filter((e) => e['kind'] === 'story');
    expect(stories).toHaveLength(2);
    const publicStory = stories.find((s) => s['title'] === 'Public story');
    const roomStory = stories.find((s) => s['title'] === 'In-room story');
    expect(publicStory).toMatchObject({ room_ref: COMMONS_ROOM_ID, visibility: 'public' });
    expect(roomStory).toMatchObject({ room_ref: room.roomId, visibility: 'room_only' });
  });

  it('includes the private-room subscription with room_ref + room_visibility', async () => {
    const userId = randomUUID();
    const room = privateRoomInput();
    await fixture.forum.rooms.insert(room);
    await fixture.forum.rooms.upsertSubscription(activeSubscription(room.roomId, userId));

    const archive = await exportUserContent(fixture.ingestion, fixture.forum, userId);
    const subs = archive.filter((e) => e['kind'] === 'room_subscription');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      room_ref: room.roomId,
      room_visibility: 'private',
      status: 'active',
    });
  });

  it('anonymize tombstones a room_only-thread contribution and strips the membership', async () => {
    const userId = randomUUID();
    const room = privateRoomInput();
    await fixture.forum.rooms.insert(room);
    await fixture.forum.rooms.upsertSubscription(activeSubscription(room.roomId, userId));
    const { threadId } = await seedThread(fixture, {
      submittedBy: userId,
      roomId: room.roomId,
      visibility: 'room_only',
    });
    const contribution = await fixture.forum.contributions.insert({
      contributionId: randomUUID(),
      threadId,
      userId,
      type: 'question',
      body: 'An in-room question for the record?',
      citations: [],
      metadata: {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: `draft-${randomUUID()}`,
      path: [],
      moderationState: 'published',
    });
    expect(contribution.ok).toBe(true);

    await anonymizeUserContent(fixture.forum, userId);

    // The membership row is gone (personal data, private room included)…
    expect(await fixture.forum.rooms.listSubscriptionsByUser(userId)).toHaveLength(0);
    // …and the room_only-thread contribution is tombstoned (author cleared).
    const remaining = await fixture.forum.contributions.listByUser(userId, null, 100);
    expect(remaining).toHaveLength(0);
  });
});
