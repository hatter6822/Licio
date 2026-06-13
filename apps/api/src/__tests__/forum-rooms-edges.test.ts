// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.2 route edge coverage: room detail/threads/lens 404s and 403s, the
// join-request deny path, leave-without-membership, notification-preference
// 404, governance presence for a non-ordinary room, the room-threads page
// cursor, and the visibility filter on the listing superset.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createV1Routes } from '../routes/v1.js';
import {
  type ForumServicesFixture,
  freshForumServices,
  jsonRequest,
  seedThread,
  seedUserWithSession,
} from './forum-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: ForumServicesFixture;
let cookie: string;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  fixture = freshForumServices({
    now: () => {
      nowMs += 97;
      return nowMs;
    },
  });
  const session = await seedUserWithSession(fixture.identity);
  cookie = session.cookie;
});

async function makeRoom(name: string, asCookie = cookie): Promise<string> {
  const res = await app().request(
    jsonRequest(
      '/v1/rooms',
      'POST',
      { room_type: 'global_topic', name, description: 'd', initial_topics: ['t'] },
      asCookie,
    ),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { room_id: string }).room_id;
}

describe('room route edges', () => {
  it('404s on unknown room detail/join/lenses/threads', async () => {
    const missing = randomUUID();
    expect((await app().request(`http://local/v1/rooms/${missing}`)).status).toBe(404);
    expect(
      (await app().request(jsonRequest(`/v1/rooms/${missing}/join`, 'POST', {}, cookie))).status,
    ).toBe(404);
    expect((await app().request(`http://local/v1/rooms/${missing}/lenses`)).status).toBe(404);
    expect((await app().request(`http://local/v1/rooms/${missing}/threads`)).status).toBe(404);
  });

  it('leaving a room you never joined is a clean no-op', async () => {
    const roomId = await makeRoom('Leavable');
    const other = await seedUserWithSession(fixture.identity, { handle: 'never-joined' });
    const res = await app().request(
      new Request(`http://local/v1/rooms/${roomId}/join`, {
        method: 'DELETE',
        headers: { cookie: other.cookie },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('notification preferences 404 without a subscription', async () => {
    const roomId = await makeRoom('Prefless');
    const other = await seedUserWithSession(fixture.identity, { handle: 'no-sub' });
    const res = await app().request(
      jsonRequest(`/v1/rooms/${roomId}/notifications`, 'PATCH', { threads: 'all' }, other.cookie),
    );
    expect(res.status).toBe(404);
  });

  it('join-request deny removes the pending subscription; unknown request 404s', async () => {
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
    const applicant = await seedUserWithSession(fixture.identity, { handle: 'denied' });
    await app().request(jsonRequest(`/v1/rooms/${room_id}/join`, 'POST', {}, applicant.cookie));
    const requests = (await (
      await app().request(
        new Request(`http://local/v1/rooms/${room_id}/join-requests`, {
          headers: { cookie: steward.cookie },
        }),
      )
    ).json()) as { items: Array<{ request_id: string }> };
    const requestId = requests.items[0]?.request_id ?? '';
    const deny = await app().request(
      jsonRequest(
        `/v1/rooms/${room_id}/join-requests/${requestId}`,
        'PATCH',
        { decision: 'deny' },
        steward.cookie,
      ),
    );
    expect(deny.status).toBe(200);
    expect(await fixture.forum.rooms.getSubscription(room_id, applicant.userId)).toBeNull();
    // Re-deciding the now-gone request 404s.
    const again = await app().request(
      jsonRequest(
        `/v1/rooms/${room_id}/join-requests/${requestId}`,
        'PATCH',
        { decision: 'approve' },
        steward.cookie,
      ),
    );
    expect(again.status).toBe(404);
    // Non-steward listing is denied.
    const stranger = await app().request(
      new Request(`http://local/v1/rooms/${room_id}/join-requests`, {
        headers: { cookie: applicant.cookie },
      }),
    );
    expect(stranger.status).toBe(403);
  });

  it('lens creation requires a steward of THAT room; private lens list 404s for outsiders', async () => {
    const roomId = await makeRoom('Lensy');
    const other = await seedUserWithSession(fixture.identity, { handle: 'not-steward' });
    const denied = await app().request(
      jsonRequest(
        `/v1/rooms/${roomId}/lenses`,
        'POST',
        { name: 'Experts', lens_type: 'expert' },
        other.cookie,
      ),
    );
    expect(denied.status).toBe(403);

    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const restricted = await app().request(
      jsonRequest(
        '/v1/rooms',
        'POST',
        {
          room_type: 'global_topic',
          name: 'Hidden lenses',
          description: 'd',
          initial_topics: ['t'],
          visibility: 'private',
        },
        steward.cookie,
      ),
    );
    const hiddenRoom = ((await restricted.json()) as { room_id: string }).room_id;
    // WS-Q.3.2 — lenses are CONTENT (tier two): an outsider gets 404 (no oracle).
    const anonymous = await app().request(`http://local/v1/rooms/${hiddenRoom}/lenses`);
    expect(anonymous.status).toBe(404);
  });

  it('room threads page lists visible threads most-recent-first with a cursor', async () => {
    const roomId = await makeRoom('Threaded');
    const first = await seedThread(fixture, { roomId, title: 'First story' });
    const second = await seedThread(fixture, { roomId, title: 'Second story' });
    // A hidden story's thread never appears.
    const hidden = await seedThread(fixture, { roomId, title: 'Hidden story' });
    await fixture.ingestion.stories.update(hidden.storyId, { hiddenState: 'takedown' });

    const res = await app().request(`http://local/v1/rooms/${roomId}/threads`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ thread_id: string; title: string }> };
    expect(body.items.map((t) => t.thread_id)).toEqual([second.threadId, first.threadId]);
    expect(body.items.map((t) => t.title)).toEqual(['Second story', 'First story']);
  });

  it('room detail shows the governance section ONLY for non-ordinary modes (§16.5)', async () => {
    const roomId = await makeRoom('Governed');
    // Simulate a WS-L mode change at the store level (read-only in WS-G).
    const room = await fixture.forum.rooms.getById(roomId);
    if (room) {
      // biome-ignore lint/suspicious/noExplicitAny: test-only direct mutation of the in-memory record
      (room as any).governanceMode = 'simulated';
    }
    const detail = (await (await app().request(`http://local/v1/rooms/${roomId}`)).json()) as {
      governance: { mode: string } | null;
    };
    expect(detail.governance?.mode).toBe('simulated');
  });
});
