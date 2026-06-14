// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.2 room + lens route tests: creation authorization, listing filters +
// pagination + the no-applause recommendation contract, detail (§16.5
// governance presence), subscription lifecycle (join/pending/approve/leave,
// idempotency, notification preferences), lens uniqueness + the WS-G.2.4
// SCOI read, and restricted-room access control.
import {
  isFinancialFieldName,
  roomDetailSchema,
  roomJoinResponseSchema,
  roomListResponseSchema,
  storyLensesResponseSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { RECOMMENDATION_INPUT_KEYS } from '../forum/rooms.js';
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
let userId: string;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  fixture = freshForumServices({
    now: () => {
      nowMs += 211;
      return nowMs;
    },
  });
  const session = await seedUserWithSession(fixture.identity);
  cookie = session.cookie;
  userId = session.userId;
});

async function createRoom(body: Record<string, unknown>, asCookie = cookie): Promise<Response> {
  return app().request(jsonRequest('/v1/rooms', 'POST', body, asCookie));
}

const PUBLIC_ROOM = {
  room_type: 'global_topic',
  name: 'Public Health',
  description: 'Evidence-led discussion.',
  initial_topics: ['health'],
} as const;

describe('WS-G.2.3c — room creation', () => {
  it('creates each room type with valid per-type fields', async () => {
    const bodies: Array<Record<string, unknown>> = [
      PUBLIC_ROOM,
      {
        room_type: 'local_geographic',
        name: 'Riverside',
        description: 'd',
        geographic_scope: 'Riverside district',
      },
      {
        room_type: 'professional_domain',
        name: 'Epidemiology',
        description: 'd',
        domain_descriptor: 'Epidemiology',
      },
      {
        room_type: 'event',
        name: 'Election night',
        description: 'd',
        event_start: '2026-06-11T00:00:00.000Z',
        event_end: '2026-06-12T00:00:00.000Z',
      },
      {
        room_type: 'learning',
        name: 'Source literacy',
        description: 'd',
        curriculum_outline: 'Week 1.',
      },
    ];
    for (const body of bodies) {
      const res = await createRoom(body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { governance_mode: string; joined: boolean };
      expect(json.governance_mode).toBe('ordinary'); // ALWAYS the default
      expect(json.joined).toBe(true); // creator auto-subscribes
    }
  });

  it('allows PRIVATE rooms for ordinary users (WS-Q.3.3a); steward rooms require staff (403)', async () => {
    // WS-Q.3.3a — a private room is a first-class user affordance (no longer
    // steward-gated). Only `steward`-type rooms still require platform staff.
    const privateRoom = await createRoom({ ...PUBLIC_ROOM, name: 'R1', visibility: 'private' });
    expect(privateRoom.status).toBe(201);
    const stewardRoom = await createRoom({
      room_type: 'steward',
      name: 'Steward HQ',
      description: 'd',
      visibility: 'private',
    });
    expect(stewardRoom.status).toBe(403);
  });

  it('detects duplicate names case-insensitively within a type (409)', async () => {
    expect((await createRoom(PUBLIC_ROOM)).status).toBe(201);
    const dup = await createRoom({ ...PUBLIC_ROOM, name: 'PUBLIC HEALTH' });
    expect(dup.status).toBe(409);
    // The same name under a DIFFERENT type is fine.
    const otherType = await createRoom({
      room_type: 'learning',
      name: 'Public Health',
      description: 'd',
      curriculum_outline: 'Week 1.',
    });
    expect(otherType.status).toBe(201);
  });

  it('creator is recorded as community steward', async () => {
    const res = await createRoom(PUBLIC_ROOM);
    const { room_id } = (await res.json()) as { room_id: string };
    const stewards = await fixture.forum.rooms.listStewards(room_id);
    expect(stewards).toEqual([expect.objectContaining({ userId, role: 'community_steward' })]);
  });
});

describe('WS-G.2.3a — listing, filters, recommendation (no applause)', () => {
  it('filters by type and q; paginates with a stable cursor', async () => {
    for (let index = 0; index < 25; index += 1) {
      await createRoom({
        ...PUBLIC_ROOM,
        name: `Room ${String(index).padStart(2, '0')}`,
        description: index % 2 === 0 ? 'water quality' : 'transit planning',
      });
    }
    const firstPage = roomListResponseSchema.parse(
      await (await app().request('http://local/v1/rooms?type=global_topic&limit=20')).json(),
    );
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = roomListResponseSchema.parse(
      await (
        await app().request(
          `http://local/v1/rooms?type=global_topic&limit=20&cursor=${firstPage.nextCursor}`,
        )
      ).json(),
    );
    // WS-Q.1.6 — the system Commons room (a public global_topic) is always
    // present, so the global_topic listing is the 25 created rooms + Commons.
    expect(secondPage.items).toHaveLength(6);
    const all = new Set([...firstPage.items, ...secondPage.items].map((r) => r.room_id));
    expect(all.size).toBe(26);

    const search = roomListResponseSchema.parse(
      await (await app().request('http://local/v1/rooms?q=water')).json(),
    );
    expect(search.items.length).toBe(13);
  });

  it('joined=true returns only subscriptions; recommended excludes joined and orders by recency', async () => {
    const a = (await (await createRoom({ ...PUBLIC_ROOM, name: 'Alpha' })).json()) as {
      room_id: string;
    };
    const b = (await (await createRoom({ ...PUBLIC_ROOM, name: 'Beta' })).json()) as {
      room_id: string;
    };
    // A second user joins nothing; Alpha gets newer activity than Beta.
    await fixture.forum.rooms.touchActivity(b.room_id, new Date(nowMs + 1_000).toISOString());
    await fixture.forum.rooms.touchActivity(a.room_id, new Date(nowMs + 60_000).toISOString());
    const reader = await seedUserWithSession(fixture.identity, { handle: 'reader2' });

    const joined = roomListResponseSchema.parse(
      await (
        await app().request(
          new Request('http://local/v1/rooms?joined=true', { headers: { cookie: reader.cookie } }),
        )
      ).json(),
    );
    expect(joined.items).toHaveLength(0);

    const recommended = roomListResponseSchema.parse(
      await (
        await app().request(
          new Request('http://local/v1/rooms?recommended=true', {
            headers: { cookie: reader.cookie },
          }),
        )
      ).json(),
    );
    expect(recommended.items.map((r) => r.name).slice(0, 2)).toEqual(['Alpha', 'Beta']);
  });

  it('recommendation inputs contain no denylisted/financial signal (WS-A.1.1)', () => {
    // The contract: ONLY these recency inputs feed the ordering.
    expect([...RECOMMENDATION_INPUT_KEYS]).toEqual(['activityRecencyMs', 'createdAtMs']);
    for (const key of RECOMMENDATION_INPUT_KEYS) {
      expect(isFinancialFieldName(key)).toBe(false);
      expect(/like|vote|karma|follower|reaction|member_count|applause/i.test(key)).toBe(false);
    }
    // WS-Q.3.3b — visibility / join_model / posting_policy GATE eligibility,
    // they never SCORE: none may appear as a recommendation input.
    for (const key of RECOMMENDATION_INPUT_KEYS as readonly string[]) {
      expect(/visibility|join_model|posting_policy/.test(key)).toBe(false);
    }
  });

  it('anonymous listing INCLUDES private rooms — tier-one existence is universal (WS-Q.3.1a)', async () => {
    await createRoom({ ...PUBLIC_ROOM, name: 'Open' });
    // A private room is discoverable + joinable by anyone (a non-member never
    // reads its CONTENT, but its shell — name, visibility, join CTA — is listed).
    const privateRoom = await createRoom({ ...PUBLIC_ROOM, name: 'Closed', visibility: 'private' });
    expect(privateRoom.status).toBe(201);
    const anonymous = roomListResponseSchema.parse(
      await (await app().request('http://local/v1/rooms')).json(),
    );
    const names = anonymous.items.map((r) => r.name);
    expect(names).toContain('Open');
    expect(names).toContain('Closed');
    const closed = anonymous.items.find((r) => r.name === 'Closed');
    expect(closed?.visibility).toBe('private');
  });
});

describe('WS-G.2.3b — room detail and §16.5 governance presence', () => {
  it('includes lenses, stewards, charter; governance only for non-ordinary rooms', async () => {
    const created = (await (await createRoom(PUBLIC_ROOM)).json()) as { room_id: string };
    const lens = await app().request(
      jsonRequest(
        `/v1/rooms/${created.room_id}/lenses`,
        'POST',
        { name: 'Beginners', lens_type: 'beginner', description: 'Plain-language readings.' },
        cookie,
      ),
    );
    expect(lens.status).toBe(201);
    const detail = roomDetailSchema.parse(
      await (await app().request(`http://local/v1/rooms/${created.room_id}`)).json(),
    );
    expect(detail.lenses).toHaveLength(1);
    expect(detail.stewards[0]?.role).toBe('community_steward');
    expect(detail.governance).toBeNull(); // ordinary ⇒ omitted (§16.5)
  });

  it('private-room detail shows the tier-one shell to all; CONTENT (lenses) is members-only (WS-Q.3.1a)', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const created = (await (
      await createRoom({ ...PUBLIC_ROOM, name: 'Closed', visibility: 'private' }, steward.cookie)
    ).json()) as { room_id: string };
    // Give the room a lens (CONTENT) the creator can see but a stranger cannot.
    await app().request(
      jsonRequest(
        `/v1/rooms/${created.room_id}/lenses`,
        'POST',
        { name: 'Locals', lens_type: 'local_resident' },
        steward.cookie,
      ),
    );
    // A stranger gets the tier-one SHELL (200), but no lens content.
    const stranger = await app().request(`http://local/v1/rooms/${created.room_id}`);
    expect(stranger.status).toBe(200);
    const strangerDetail = roomDetailSchema.parse(await stranger.json());
    expect(strangerDetail.name).toBe('Closed');
    expect(strangerDetail.visibility).toBe('private');
    expect(strangerDetail.lenses).toHaveLength(0); // content withheld
    // The creator (active member + steward) sees the content.
    const asCreator = await app().request(
      new Request(`http://local/v1/rooms/${created.room_id}`, {
        headers: { cookie: steward.cookie },
      }),
    );
    expect(asCreator.status).toBe(200);
    expect(roomDetailSchema.parse(await asCreator.json()).lenses).toHaveLength(1);
    // The room's THREADS remain 404 to a stranger (CONTENT, tier two).
    const threads = await app().request(`http://local/v1/rooms/${created.room_id}/threads`);
    expect(threads.status).toBe(404);
  });
});

describe('WS-G.2.3d — subscriptions', () => {
  it('public join is immediate and idempotent; leave removes preferences', async () => {
    const created = (await (await createRoom(PUBLIC_ROOM)).json()) as { room_id: string };
    const reader = await seedUserWithSession(fixture.identity, { handle: 'joiner' });
    const join = roomJoinResponseSchema.parse(
      await (
        await app().request(
          jsonRequest(`/v1/rooms/${created.room_id}/join`, 'POST', {}, reader.cookie),
        )
      ).json(),
    );
    expect(join.status).toBe('active');
    expect(join.room.joined).toBe(true);
    // Idempotent re-join.
    const again = roomJoinResponseSchema.parse(
      await (
        await app().request(
          jsonRequest(`/v1/rooms/${created.room_id}/join`, 'POST', {}, reader.cookie),
        )
      ).json(),
    );
    expect(again.status).toBe('active');
    // Preferences round-trip, then leave removes everything.
    const prefs = await app().request(
      jsonRequest(
        `/v1/rooms/${created.room_id}/notifications`,
        'PATCH',
        { threads: 'all', new_evidence: true },
        reader.cookie,
      ),
    );
    expect(((await prefs.json()) as { threads: string }).threads).toBe('all');
    const leave = await app().request(
      new Request(`http://local/v1/rooms/${created.room_id}/join`, {
        method: 'DELETE',
        headers: { cookie: reader.cookie },
      }),
    );
    expect(leave.status).toBe(200);
    expect(await fixture.forum.rooms.getSubscription(created.room_id, reader.userId)).toBeNull();
  });

  it('private (request_approval) join → pending → steward approve → active', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const created = (await (
      await createRoom({ ...PUBLIC_ROOM, name: 'Closed', visibility: 'private' }, steward.cookie)
    ).json()) as { room_id: string };
    const applicant = await seedUserWithSession(fixture.identity, { handle: 'applicant' });
    const join = roomJoinResponseSchema.parse(
      await (
        await app().request(
          jsonRequest(`/v1/rooms/${created.room_id}/join`, 'POST', {}, applicant.cookie),
        )
      ).json(),
    );
    expect(join.status).toBe('pending');
    const requests = (await (
      await app().request(
        new Request(`http://local/v1/rooms/${created.room_id}/join-requests`, {
          headers: { cookie: steward.cookie },
        }),
      )
    ).json()) as { items: Array<{ request_id: string }> };
    expect(requests.items).toHaveLength(1);
    const requestId = requests.items[0]?.request_id ?? '';
    const decision = await app().request(
      jsonRequest(
        `/v1/rooms/${created.room_id}/join-requests/${requestId}`,
        'PATCH',
        { decision: 'approve' },
        steward.cookie,
      ),
    );
    expect(decision.status).toBe(200);
    const subscription = await fixture.forum.rooms.getSubscription(
      created.room_id,
      applicant.userId,
    );
    expect(subscription?.status).toBe('active');
  });
});

describe('WS-G.2.2 / WS-G.2.4 — lenses', () => {
  it('enforces (room, lens_type) uniqueness with 409', async () => {
    const created = (await (await createRoom(PUBLIC_ROOM)).json()) as { room_id: string };
    const first = await app().request(
      jsonRequest(
        `/v1/rooms/${created.room_id}/lenses`,
        'POST',
        { name: 'Experts', lens_type: 'expert' },
        cookie,
      ),
    );
    expect(first.status).toBe(201);
    const dup = await app().request(
      jsonRequest(
        `/v1/rooms/${created.room_id}/lenses`,
        'POST',
        { name: 'Other experts', lens_type: 'expert' },
        cookie,
      ),
    );
    expect(dup.status).toBe(409);
  });

  it('GET /stories/:id/lenses groups lens-tagged contributions; divergence is absent gracefully', async () => {
    const created = (await (await createRoom(PUBLIC_ROOM)).json()) as { room_id: string };
    const lensRes = await app().request(
      jsonRequest(
        `/v1/rooms/${created.room_id}/lenses`,
        'POST',
        { name: 'Locals', lens_type: 'local_resident' },
        cookie,
      ),
    );
    const lens = (await lensRes.json()) as { lens_id: string };
    const { storyId, threadId } = await seedThread(fixture, { roomId: created.room_id });
    const contribution = await app().request(
      jsonRequest(
        '/v1/contributions',
        'POST',
        {
          thread_id: threadId,
          client_draft_id: 'lens-tagged',
          type: 'local_context',
          body: 'The intersection floods every spring.',
          scope: 'Riverside resident',
          lens_id: lens.lens_id,
        },
        cookie,
      ),
    );
    expect(contribution.status).toBe(201);
    const lenses = storyLensesResponseSchema.parse(
      await (await app().request(`http://local/v1/stories/${storyId}/lenses`)).json(),
    );
    expect(lenses.groups).toHaveLength(1);
    expect(lenses.groups[0]?.contribution_ids).toHaveLength(1);
    expect(lenses.divergence).toBeNull(); // SCOI not yet run (WS-H.4)
  });
});
