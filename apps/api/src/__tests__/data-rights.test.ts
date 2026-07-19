// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.3.5 — DSAR export + account-purge anonymization across BOTH visibility
// tiers. Self-access is not bounded by distribution: a user's room_only content
// and private-room subscription appear in their export tagged with room_ref +
// visibility; a purge tombstones contributions across tiers and strips the
// private-room membership.
import { randomUUID } from 'node:crypto';
import { COMMONS_ROOM_ID } from '@licio/shared';
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
    requestedAt: nowIso,
    joinedAt: nowIso,
  };
}

/** A minimal `open` debate arena; `over` overrides the party ids / positions. */
function openArena(over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    debateId: randomUUID(),
    storyId: randomUUID(),
    threadId: null,
    roomId: null,
    targetType: 'comment' as const,
    targetContributionId: randomUUID(),
    challengerContributionId: randomUUID(),
    incumbentUserId: null as string | null,
    challengerUserId: null as string | null,
    state: 'open' as const,
    positions: {
      incumbent: { summary: '', citations: [], updatedAt: null },
      challenger: { summary: '', citations: [], updatedAt: null },
    },
    editDeadlineAt: now,
    resolveDueAt: now,
    lockedAt: null,
    lockedContent: null,
    incumbentLastActiveAt: now,
    challengerLastActiveAt: now,
    verdict: null,
    winner: null,
    decidedBy: null,
    rationale: null,
    confidence: null,
    aiOutputId: null,
    verdictAt: null,
    overrideDeadlineAt: null,
    overriddenByUserId: null as string | null,
    overrideReason: null,
    resolvedAt: null,
    ...over,
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
      type: 'comment',
      body: 'An in-room comment for the record.',
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

describe('WS-T — data-rights covers debate-arena rebuttals', () => {
  it('exports only the subject OWN side of arenas they are a party to', async () => {
    const userId = randomUUID();
    await fixture.forum.debates.open(
      openArena({
        challengerUserId: userId,
        incumbentUserId: randomUUID(),
        positions: {
          incumbent: { summary: 'the opposing side text', citations: [], updatedAt: null },
          challenger: {
            summary: 'My sourced rebuttal draft.',
            citations: [],
            updatedAt: '2026-07-01T00:00:00.000Z',
          },
        },
      }),
    );

    const archive = await exportUserContent(fixture.ingestion, fixture.forum, userId);
    const debates = archive.filter((e) => e['kind'] === 'debate');
    expect(debates).toHaveLength(1);
    expect(debates[0]).toMatchObject({
      role: 'challenger',
      rebuttal: 'My sourced rebuttal draft.',
      rebuttal_updated_at: '2026-07-01T00:00:00.000Z',
    });
    // The OPPOSING side's text is another person's data — it must not leak.
    expect(JSON.stringify(debates[0])).not.toContain('the opposing side text');
  });

  it('anonymize detaches the subject from every arena role (party + steward override)', async () => {
    const userId = randomUUID();
    // The subject as a challenger party…
    await fixture.forum.debates.open(
      openArena({ challengerUserId: userId, incumbentUserId: randomUUID() }),
    );
    // …and as the steward who overrode a separate, judged arena.
    const overridden = openArena({
      state: 'judged',
      incumbentUserId: randomUUID(),
      challengerUserId: randomUUID(),
      overriddenByUserId: userId,
    });
    await fixture.forum.debates.open(overridden);

    await anonymizeUserContent(fixture.forum, userId);

    // No arena still lists the subject as a party…
    expect(await fixture.forum.debates.listByParty(userId, null, 100)).toHaveLength(0);
    // …and the steward-override identity link is cleared too.
    const row = await fixture.forum.debates.getById(overridden.debateId);
    expect(row?.overriddenByUserId).toBeNull();
  });

  it('listByParty keyset-paginates a party across pages', async () => {
    const userId = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await fixture.forum.debates.open(
        openArena({ incumbentUserId: userId, challengerUserId: randomUUID() }),
      );
    }
    const first = await fixture.forum.debates.listByParty(userId, null, 2);
    expect(first).toHaveLength(2);
    const lastRow = first[first.length - 1];
    if (lastRow === undefined) throw new Error('expected a first-page row');
    const next = await fixture.forum.debates.listByParty(
      userId,
      { createdAt: lastRow.createdAt, debateId: lastRow.debateId },
      2,
    );
    expect(next).toHaveLength(1);
    // No overlap between pages.
    const ids = new Set([...first, ...next].map((r) => r.debateId));
    expect(ids.size).toBe(3);
  });
});
