// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Query-shape guarantees for `routes/rooms.ts`.  Two lists on this router are
// resolved to handles: the room-shell steward list (every visitor hits it) and
// the steward join-request queue (whose size is attacker-influenceable — any
// account may request to join).  Both must resolve through the batch getter,
// not one point lookup per row.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureCommonsRoom } from '../forum/rooms.js';
import { createV1Routes } from '../routes/v1.js';
import {
  type ForumServicesFixture,
  freshForumServices,
  jsonRequest,
  seedUserWithSession,
} from './forum-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: ForumServicesFixture;

beforeEach(async () => {
  fixture = freshForumServices();
  await ensureCommonsRoom(fixture.forum);
});

/** Count store reads without changing behaviour. */
function countUserReads(): { single: number; batched: number } {
  const store = fixture.identity.store;
  const counts = { single: 0, batched: 0 };
  const getUser = store.getUser.bind(store);
  const getUsersByIds = store.getUsersByIds.bind(store);
  store.getUser = async (userId: string) => {
    counts.single += 1;
    return getUser(userId);
  };
  store.getUsersByIds = async (userIds: readonly string[]) => {
    counts.batched += 1;
    return getUsersByIds(userIds);
  };
  return counts;
}

describe('join-request queue resolves handles in ONE batched read', () => {
  it('serves a queue of five applicants without a per-row user lookup', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const create = await app().request(
      jsonRequest(
        '/v1/rooms',
        'POST',
        {
          room_type: 'global_topic',
          name: 'Gated',
          description: 'd',
          initial_topics: ['t'],
          visibility: 'private',
        },
        steward.cookie,
      ),
    );
    const { room_id } = (await create.json()) as { room_id: string };
    for (let i = 0; i < 5; i += 1) {
      const applicant = await seedUserWithSession(fixture.identity, { handle: `applicant${i}` });
      await app().request(jsonRequest(`/v1/rooms/${room_id}/join`, 'POST', {}, applicant.cookie));
    }

    const counts = countUserReads();
    const res = await app().request(
      new Request(`http://local/v1/rooms/${room_id}/join-requests`, {
        headers: { cookie: steward.cookie },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(5);
    // The five applicants are resolved together.  `getUser` still runs once for
    // the CALLER (the auth middleware), so the assertion is on the queue itself:
    // one batched read, and no lookup that scales with the queue length.
    expect(counts.batched).toBe(1);
    expect(counts.single).toBeLessThanOrEqual(1);
  });
});

describe('room detail resolves the steward list in ONE batched read', () => {
  it('does not issue a point lookup per steward', async () => {
    const owner = await seedUserWithSession(fixture.identity, { steward: true });
    const create = await app().request(
      jsonRequest(
        '/v1/rooms',
        'POST',
        {
          room_type: 'global_topic',
          name: 'Shell',
          description: 'd',
          initial_topics: ['t'],
          visibility: 'public',
        },
        owner.cookie,
      ),
    );
    const { room_id } = (await create.json()) as { room_id: string };

    const counts = countUserReads();
    const res = await app().request(new Request(`http://local/v1/rooms/${room_id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stewards: unknown[] };
    expect(body.stewards.length).toBeGreaterThan(0);
    expect(counts.batched).toBe(1);
    expect(counts.single).toBe(0);
  });
});
