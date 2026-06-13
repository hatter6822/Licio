// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q acceptance: the content–room model end to end through the real routes —
// the submission room/posting/visibility guards, tier-scoped dedup +
// cross-tier linking, the item read bar, author visibility transitions, and
// the per-event classification firewall for in-room content.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createV1Routes } from '../routes/v1.js';
import {
  briefSubmission,
  freshIngestionServices,
  type IngestionServicesFixture,
  linkSubmission,
  post,
  seedUserWithSession,
} from './ingestion-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: IngestionServicesFixture;

beforeEach(() => {
  fixture = freshIngestionServices({ config: { minAccountAgeMinutes: 0 } });
});

/** Create a room directly through the store and return its id. */
async function makeRoom(
  visibility: 'public' | 'private',
  over: Partial<{
    joinModel: 'open' | 'request_approval' | 'invite';
    postingPolicy: 'all_members' | 'experts_and_stewards';
  }> = {},
): Promise<string> {
  const roomId = randomUUID();
  await fixture.forum.rooms.insert({
    roomId,
    name: `Room ${roomId.slice(0, 8)}`,
    slug: `room-${roomId.slice(0, 8)}`,
    description: null,
    roomType: 'global_topic',
    visibility,
    joinModel: over.joinModel ?? (visibility === 'public' ? 'open' : 'request_approval'),
    postingPolicy: over.postingPolicy ?? 'all_members',
    createdBy: null,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: {},
    latestActivityAt: null,
  });
  return roomId;
}

describe('WS-Q.2.1 submission guards', () => {
  it('rejects submission to an unknown room with 404 (no tier-two leak)', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await app().request(
      post('/v1/stories', briefSubmission({ room_id: randomUUID() }), cookie),
    );
    expect(res.status).toBe(404);
  });

  it('a private-room outsider gets 404; an active member can post', async () => {
    const room = await makeRoom('private');
    const outsider = await seedUserWithSession(fixture.identity, { handle: 'outsider' });
    const denied = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), outsider.cookie),
    );
    expect(denied.status).toBe(404);

    const member = await seedUserWithSession(fixture.identity, { handle: 'member' });
    await fixture.forum.rooms.upsertSubscription({
      roomId: room,
      userId: member.userId,
      status: 'active',
      requestId: randomUUID(),
      notificationPreferences: {
        threads: 'mentions',
        new_evidence: false,
        bridge_requests: false,
        steward_announcements: true,
      },
      requestedAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    });
    const ok = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), member.cookie),
    );
    expect(ok.status).toBe(201);
  });

  it('a private room FORCES room_only even when the author requests public', async () => {
    const room = await makeRoom('private');
    const steward = await seedUserWithSession(fixture.identity, { handle: 'rs' });
    await fixture.forum.rooms.addSteward({
      roomId: room,
      userId: steward.userId,
      role: 'community_steward',
      assignedAt: new Date().toISOString(),
    });
    const res = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room, visibility: 'public' }), steward.cookie),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { story: { visibility: string } };
    expect(body.story.visibility).toBe('room_only');
  });

  it("an experts_and_stewards room rejects a plain member's post with a distinct in-room error", async () => {
    const room = await makeRoom('public', { postingPolicy: 'experts_and_stewards' });
    const member = await seedUserWithSession(fixture.identity, { handle: 'plain' });
    const res = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), member.cookie),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'posting_restricted',
    );
  });
});

describe('WS-Q.2.2 tier-scoped dedup + cross-tier linking', () => {
  it('public/public same URL ⇒ 409; the same URL is allowed room_only in a room', async () => {
    const a = await seedUserWithSession(fixture.identity, { handle: 'a' });
    const url = 'https://example.com/tiered-article';
    const first = await app().request(post('/v1/stories', linkSubmission(url), a.cookie));
    expect(first.status).toBe(201);
    const dup = await app().request(post('/v1/stories', linkSubmission(url), a.cookie));
    expect(dup.status).toBe(409);

    // The SAME url is fine as room_only inside a room (different tier).
    const room = await makeRoom('public');
    const b = await seedUserWithSession(fixture.identity, { handle: 'b' });
    const inRoom = await app().request(
      post(
        '/v1/stories',
        linkSubmission(url, { room_id: room, visibility: 'room_only' }),
        b.cookie,
      ),
    );
    expect(inRoom.status).toBe(201);
    // The in-room row records the canonical-public pointer (cross-tier link).
    const body = (await inRoom.json()) as { story: { canonical_public_story_id: string | null } };
    expect(body.story.canonical_public_story_id).not.toBeNull();
  });
});

describe('WS-Q.3.2 item read bar', () => {
  it('a room_only story in a private room is 404 to outsiders, 200 to members', async () => {
    const room = await makeRoom('private');
    const author = await seedUserWithSession(fixture.identity, { handle: 'author' });
    await fixture.forum.rooms.upsertSubscription({
      roomId: room,
      userId: author.userId,
      status: 'active',
      requestId: randomUUID(),
      notificationPreferences: {
        threads: 'mentions',
        new_evidence: false,
        bridge_requests: false,
        steward_announcements: true,
      },
      requestedAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    });
    const created = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), author.cookie),
    );
    const { story_id } = (await created.json()) as { story_id: string };

    // Outsider: 404 (no oracle).
    expect((await app().request(`http://local/v1/stories/${story_id}`)).status).toBe(404);
    // Member: 200.
    const member = await app().request(
      new Request(`http://local/v1/stories/${story_id}`, { headers: { cookie: author.cookie } }),
    );
    expect(member.status).toBe(200);
  });
});

describe('WS-Q.2.4 author visibility transitions', () => {
  async function seedPublicStory(): Promise<{ storyId: string; cookie: string }> {
    const author = await seedUserWithSession(fixture.identity, { handle: 'tx' });
    const created = await app().request(post('/v1/stories', briefSubmission(), author.cookie));
    const { story_id } = (await created.json()) as { story_id: string };
    return { storyId: story_id, cookie: author.cookie };
  }

  it('narrow public → room_only is author-only and idempotent', async () => {
    const { storyId, cookie } = await seedPublicStory();
    const other = await seedUserWithSession(fixture.identity, { handle: 'other' });
    // Non-author ⇒ 404.
    const denied = await app().request(
      new Request(`http://local/v1/stories/${storyId}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: other.cookie },
        body: JSON.stringify({ visibility: 'room_only' }),
      }),
    );
    expect(denied.status).toBe(404);
    // Author narrows.
    const narrow = await app().request(
      new Request(`http://local/v1/stories/${storyId}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ visibility: 'room_only' }),
      }),
    );
    expect(narrow.status).toBe(200);
    expect(((await narrow.json()) as { changed: boolean }).changed).toBe(true);
    // Idempotent re-narrow.
    const again = await app().request(
      new Request(`http://local/v1/stories/${storyId}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ visibility: 'room_only' }),
      }),
    );
    expect(((await again.json()) as { changed: boolean }).changed).toBe(false);
  });

  it('widen in a PRIVATE room is rejected with 422', async () => {
    const room = await makeRoom('private');
    const author = await seedUserWithSession(fixture.identity, { handle: 'pw' });
    await fixture.forum.rooms.addSteward({
      roomId: room,
      userId: author.userId,
      role: 'community_steward',
      assignedAt: new Date().toISOString(),
    });
    const created = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), author.cookie),
    );
    const { story_id } = (await created.json()) as { story_id: string };
    const widen = await app().request(
      new Request(`http://local/v1/stories/${story_id}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: author.cookie },
        body: JSON.stringify({ visibility: 'public' }),
      }),
    );
    expect(widen.status).toBe(422);
  });
});

describe('WS-Q.1.7c content-event classification firewall', () => {
  it('a room_only submission emits content.submitted classified `restricted` (not public)', async () => {
    const room = await makeRoom('public');
    const author = await seedUserWithSession(fixture.identity, { handle: 'inroom' });
    await app().request(
      post(
        '/v1/stories',
        briefSubmission({ room_id: room, visibility: 'room_only' }),
        author.cookie,
      ),
    );
    await fixture.ingestion.settle();
    // The stored content.submitted event for room_only content is restricted.
    const rows = await fixture.events.eventStore.listByTopicsBetween(
      ['content.submitted'],
      '2000-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
    );
    const roomOnly = rows.filter(
      (r) => (r.payload as { visibility?: string }).visibility === 'room_only',
    );
    expect(roomOnly.length).toBeGreaterThan(0);
    for (const row of roomOnly) {
      expect(row.privacyClassification).toBe('restricted');
    }
  });
});
