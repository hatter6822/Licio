// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Query-shape guarantees for `routes/forum.ts`.  `makeAuthorResolver` documents
// "no N+1 on a 50-row page"; a memo alone only collapses REPEAT authors, so a
// page of DISTINCT authors used to cost one point lookup each — up to ~200 of
// them released simultaneously onto a ten-connection pool per page view.  This
// pins the batched shape: same-tick resolutions share ONE `getUsersByIds`.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureCommonsRoom } from '../forum/rooms.js';
import { createV1Routes } from '../routes/v1.js';
import {
  type ForumServicesFixture,
  freshForumServices,
  seedThread,
  seedUserWithSession,
} from './forum-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: ForumServicesFixture;
let threadId: string;
let storyId: string;

beforeEach(async () => {
  fixture = freshForumServices();
  await ensureCommonsRoom(fixture.forum);
  ({ threadId, storyId } = await seedThread(fixture));
});

/** Count the store reads a request issues, keeping the real behaviour intact. */
function countUserReads(): { single: number; batched: number; ids: number } {
  const store = fixture.identity.store;
  const counts = { single: 0, batched: 0, ids: 0 };
  const getUser = store.getUser.bind(store);
  const getUsersByIds = store.getUsersByIds.bind(store);
  store.getUser = async (userId: string) => {
    counts.single += 1;
    return getUser(userId);
  };
  store.getUsersByIds = async (userIds: readonly string[]) => {
    counts.batched += 1;
    counts.ids += userIds.length;
    return getUsersByIds(userIds);
  };
  return counts;
}

describe('comment-page author resolution is batched, not N+1', () => {
  it('resolves 12 DISTINCT comment authors with a single batched read', async () => {
    const authors: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const seeded = await seedUserWithSession(fixture.identity, { handle: `author${i}` });
      authors.push(seeded.userId);
      await fixture.forum.contributions.insert({
        contributionId: randomUUID(),
        threadId,
        userId: seeded.userId,
        type: 'comment',
        body: `Comment from author ${i}.`,
        citations: [],
        metadata: {},
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: `seed-${i}`,
        path: [],
        moderationState: 'published',
      });
    }

    const counts = countUserReads();
    const res = await app().request(`http://local/v1/stories/${storyId}/comments`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: unknown[] };
    expect(body.comments).toHaveLength(12);

    // The twelve distinct authors cost ONE batched read covering all of them —
    // not twelve serial `SELECT ... WHERE user_id = $1` statements.
    expect(counts.batched).toBe(1);
    expect(counts.ids).toBe(12);
    expect(counts.single).toBe(0);
  });

  it('memoizes a MISS so a deleted author is never re-queried', async () => {
    const ghost = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await fixture.forum.contributions.insert({
        contributionId: randomUUID(),
        threadId,
        userId: ghost,
        type: 'comment',
        body: `Orphaned comment ${i}.`,
        citations: [],
        metadata: {},
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: `ghost-${i}`,
        path: [],
        moderationState: 'published',
      });
    }
    const counts = countUserReads();
    const res = await app().request(`http://local/v1/stories/${storyId}/comments`);
    expect(res.status).toBe(200);
    // One id in one batch: the repeat author collapses in the memo, and the
    // batch omitting it (no such user) is recorded as a miss rather than retried.
    expect(counts.batched).toBe(1);
    expect(counts.ids).toBe(1);
    expect(counts.single).toBe(0);
  });
});
