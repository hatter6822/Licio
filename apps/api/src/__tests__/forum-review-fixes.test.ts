// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression tests for the PR review findings on the WS-G surface:
//
//   • restricted-room CONTENT requires an ACTIVE membership — a pending
//     applicant sees the room exists but reads no threads/lenses;
//   • a safety-relevant EDIT re-runs the classifier and holds for review;
//   • a held contribution emits NO events and bumps no room activity;
//   • summary provenance: cited evidence must be real and thread-scoped;
//   • the standalone /v1/evidence path emits the durable `evidence.added`;
//   • room thread counts exclude hidden stories (no hidden oracle);
//   • branch pagination walks arbitrarily large sections exactly once;
//   • the rooms directory pages beyond any single scan batch, and `joined`
//     enumerates the requester's own memberships completely.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createV1Routes } from '../routes/v1.js';
import {
  contributionBody,
  freshWsGServices,
  jsonRequest,
  seedClaim,
  seedThread,
  seedUserWithSession,
  type WsGFixture,
} from './ws-g-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: WsGFixture;
let cookie: string;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  fixture = freshWsGServices({
    now: () => {
      nowMs += 137;
      return nowMs;
    },
    forumConfig: { contributionsPerMinute: 1_000, contributionsPerHour: 5_000 },
  });
  const session = await seedUserWithSession(fixture.identity);
  cookie = session.cookie;
});

const ROOM = {
  room_type: 'global_topic',
  name: 'Review Fixes',
  description: 'Regression room.',
  initial_topics: ['x'],
} as const;

describe('restricted content requires ACTIVE membership (not a pending application)', () => {
  it('a pending applicant sees the room exists but cannot read threads or lenses', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const created = (await (
      await app().request(
        jsonRequest(
          '/v1/rooms',
          'POST',
          { ...ROOM, name: 'Closed Wing', visibility: 'restricted' },
          steward.cookie,
        ),
      )
    ).json()) as { room_id: string };
    await seedThread(fixture, { roomId: created.room_id });

    const applicant = await seedUserWithSession(fixture.identity, { handle: 'applicant' });
    const join = (await (
      await app().request(
        jsonRequest(`/v1/rooms/${created.room_id}/join`, 'POST', {}, applicant.cookie),
      )
    ).json()) as { status: string };
    expect(join.status).toBe('pending');

    // Existence is visible (they applied)…
    const listing = (await (
      await app().request(
        new Request('http://local/v1/rooms', { headers: { cookie: applicant.cookie } }),
      )
    ).json()) as { items: Array<{ room_id: string }> };
    expect(listing.items.some((room) => room.room_id === created.room_id)).toBe(true);

    // …but content is not: threads and lenses stay closed until approval.
    const threads = await app().request(
      new Request(`http://local/v1/rooms/${created.room_id}/threads`, {
        headers: { cookie: applicant.cookie },
      }),
    );
    expect(threads.status).toBe(403);
    const lenses = await app().request(
      new Request(`http://local/v1/rooms/${created.room_id}/lenses`, {
        headers: { cookie: applicant.cookie },
      }),
    );
    expect(lenses.status).toBe(403);

    // Approval opens the content reads.
    const requests = (await (
      await app().request(
        new Request(`http://local/v1/rooms/${created.room_id}/join-requests`, {
          headers: { cookie: steward.cookie },
        }),
      )
    ).json()) as { items: Array<{ request_id: string }> };
    await app().request(
      jsonRequest(
        `/v1/rooms/${created.room_id}/join-requests/${requests.items[0]?.request_id}`,
        'PATCH',
        { decision: 'approve' },
        steward.cookie,
      ),
    );
    expect(
      (
        await app().request(
          new Request(`http://local/v1/rooms/${created.room_id}/threads`, {
            headers: { cookie: applicant.cookie },
          }),
        )
      ).status,
    ).toBe(200);
  });
});

describe('edits re-run the safety classifier (WS-G.3.1 parity)', () => {
  it('an edit that introduces a denylisted URL is held for review + queued', async () => {
    const flagged = freshWsGServices({
      now: () => nowMs,
      config: { malwareDomains: ['evil.example'] },
      forumConfig: { contributionsPerMinute: 1_000 },
    });
    const session = await seedUserWithSession(flagged.identity);
    const seeded = await seedThread(flagged);
    const createRes = await app().request(
      jsonRequest(
        '/v1/contributions',
        'POST',
        contributionBody('question', seeded.threadId),
        session.cookie,
      ),
    );
    const created = (await createRes.json()) as {
      contribution: { contribution_id: string; moderation_state: string };
    };
    expect(created.contribution.moderation_state).toBe('published');

    const editRes = await app().request(
      jsonRequest(
        `/v1/contributions/${created.contribution.contribution_id}`,
        'PATCH',
        {
          contribution_id: created.contribution.contribution_id,
          body: 'Actually see https://evil.example/payload for details.',
        },
        session.cookie,
      ),
    );
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as { moderation_state: string };
    expect(edited.moderation_state).toBe('under_review');
    const queue = await flagged.ingestion.reviewQueue.list(
      { kind: 'contribution_safety_hold' },
      10,
    );
    expect(queue).toHaveLength(1);
    expect((queue[0]?.context as { trigger?: string }).trigger).toBe('edit');
  });

  it('benign edits stay published', async () => {
    const seeded = await seedThread(fixture);
    const createRes = await app().request(
      jsonRequest(
        '/v1/contributions',
        'POST',
        contributionBody('question', seeded.threadId),
        cookie,
      ),
    );
    const created = (await createRes.json()) as {
      contribution: { contribution_id: string };
    };
    const editRes = await app().request(
      jsonRequest(
        `/v1/contributions/${created.contribution.contribution_id}`,
        'PATCH',
        { contribution_id: created.contribution.contribution_id, body: 'Clarified question?' },
        cookie,
      ),
    );
    expect(((await editRes.json()) as { moderation_state: string }).moderation_state).toBe(
      'published',
    );
  });
});

describe('held contributions are invisible to every downstream system', () => {
  it('a safety-held create emits NO events and bumps no room activity', async () => {
    const flagged = freshWsGServices({
      now: () => nowMs,
      config: { malwareDomains: ['evil.example'] },
      forumConfig: { contributionsPerMinute: 1_000 },
    });
    const steward = await seedUserWithSession(flagged.identity, { steward: true });
    const roomRes = (await (
      await app().request(jsonRequest('/v1/rooms', 'POST', ROOM, steward.cookie))
    ).json()) as { room_id: string };
    const seeded = await seedThread(flagged, { roomId: roomRes.room_id });
    const seededClaim = await seedClaim(flagged);
    const session = await seedUserWithSession(flagged.identity);
    const res = await app().request(
      jsonRequest(
        '/v1/contributions',
        'POST',
        {
          thread_id: seeded.threadId,
          client_draft_id: 'draft-held',
          type: 'evidence',
          body: 'See this source.',
          citations: [{ url: 'https://evil.example/payload' }],
          target_claim_id: seededClaim,
          evidence_type: 'report',
        },
        session.cookie,
      ),
    );
    expect(res.status).toBe(201);
    await flagged.settleAll();
    const emitted = await flagged.events.eventStore.listByTopicsBetween(
      ['contribution.created', 'evidence.added'],
      new Date(0).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(emitted).toEqual([]);
    const room = await flagged.forum.rooms.getById(roomRes.room_id);
    expect(room?.latestActivityAt).toBeNull();
  });
});

describe('summary provenance + the standalone evidence event', () => {
  it('standalone /v1/evidence emits evidence.added; summaries may cite it but never a foreign id', async () => {
    const seeded = await seedThread(fixture);
    const seededClaim = await seedClaim(fixture, seeded.storyId);
    const evidenceRes = await app().request(
      jsonRequest(
        '/v1/evidence',
        'POST',
        {
          claim_id: seededClaim,
          citation_url_or_ref: 'https://example.org/source',
          relevance_note: 'Primary dataset.',
          evidence_type: 'dataset',
          relationship_type: 'supports',
        },
        cookie,
      ),
    );
    expect(evidenceRes.status).toBe(201);
    const card = (await evidenceRes.json()) as { evidence: { evidence_id: string } };
    await fixture.settleAll();
    const emitted = await fixture.events.eventStore.listByTopicsBetween(
      ['evidence.added'],
      new Date(0).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(emitted).toHaveLength(1);
    expect((emitted[0]?.payload as { thread_id: string }).thread_id).toBe(seeded.threadId);

    // The summary may cite the real, story-scoped card…
    const okSummary = await app().request(
      jsonRequest(
        `/v1/threads/${seeded.threadId}/summaries`,
        'POST',
        {
          thread_id: seeded.threadId,
          layer: 'community_synthesis',
          body: 'Both branches agree.',
          cited_branch_ids: [],
          cited_evidence_ids: [card.evidence.evidence_id],
          unresolved_uncertainty: 'Whether the revision changed methods.',
        },
        cookie,
      ),
    );
    expect(okSummary.status).toBe(201);

    // …but never an arbitrary or foreign id (§24.3 provenance).
    const badSummary = await app().request(
      jsonRequest(
        `/v1/threads/${seeded.threadId}/summaries`,
        'POST',
        {
          thread_id: seeded.threadId,
          layer: 'community_synthesis',
          body: 'Citing nothing real.',
          cited_branch_ids: [],
          cited_evidence_ids: [randomUUID()],
          unresolved_uncertainty: 'n/a',
        },
        cookie,
      ),
    );
    expect(badSummary.status).toBe(422);
  });
});

describe('room thread counts exclude hidden stories', () => {
  it('hiding a story removes its thread from the count (no oracle)', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const roomRes = (await (
      await app().request(jsonRequest('/v1/rooms', 'POST', ROOM, steward.cookie))
    ).json()) as { room_id: string };
    const first = await seedThread(fixture, { roomId: roomRes.room_id });
    await seedThread(fixture, { roomId: roomRes.room_id });
    expect(await fixture.ingestion.stories.countThreadsByRoom(roomRes.room_id)).toBe(2);
    await fixture.ingestion.stories.update(first.storyId, { hiddenState: 'takedown' });
    expect(await fixture.ingestion.stories.countThreadsByRoom(roomRes.room_id)).toBe(1);
  });
});

describe('branch pagination walks arbitrarily large sections', () => {
  it('visits every contribution exactly once across keyset pages', async () => {
    const paged = freshWsGServices({
      now: () => {
        nowMs += 137;
        return nowMs;
      },
      forumConfig: { contributionsPerMinute: 1_000, branchPageSize: 10 },
    });
    const session = await seedUserWithSession(paged.identity);
    const seeded = await seedThread(paged);
    const createdIds: string[] = [];
    for (let i = 0; i < 23; i += 1) {
      const res = await app().request(
        jsonRequest(
          '/v1/contributions',
          'POST',
          contributionBody('question', seeded.threadId),
          session.cookie,
        ),
      );
      const json = (await res.json()) as { contribution: { contribution_id: string } };
      createdIds.push(json.contribution.contribution_id);
    }
    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const url = `http://local/v1/threads/${seeded.threadId}/branches/questions${
        cursor !== null ? `?cursor=${cursor}` : ''
      }`;
      const res = await app().request(new Request(url, { headers: { cookie: session.cookie } }));
      const body = (await res.json()) as {
        contributions: Array<{ contribution_id: string }>;
        next_cursor: string | null;
      };
      walked.push(...body.contributions.map((row) => row.contribution_id));
      pages += 1;
      if (body.next_cursor === null) break;
      cursor = body.next_cursor;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBeGreaterThan(1);
    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual([...createdIds].sort());
  });
});

describe('rooms directory pagination beyond a single scan batch', () => {
  it('walks 230 rooms completely (the old 1000-cap class of bug, scaled down)', async () => {
    const total = 230; // > one internal scan batch of 200
    for (let i = 0; i < total; i += 1) {
      const inserted = await fixture.forum.rooms.insert({
        roomId: randomUUID(),
        name: `Directory Room ${String(i).padStart(3, '0')}`,
        slug: `directory-room-${String(i).padStart(3, '0')}`,
        description: null,
        roomType: 'global_topic',
        visibility: 'public',
        createdBy: null,
        governanceMode: 'ordinary',
        charterSummary: null,
        typeMetadata: {},
        latestActivityAt: null,
      });
      expect(inserted.ok).toBe(true);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const url = `http://local/v1/rooms?limit=50${cursor !== null ? `&cursor=${cursor}` : ''}`;
      const res = await app().request(new Request(url, { headers: { cookie } }));
      const body = (await res.json()) as {
        items: Array<{ room_id: string }>;
        nextCursor: string | null;
      };
      seen.push(...body.items.map((room) => room.room_id));
      pages += 1;
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
      expect(pages).toBeLessThan(12);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(total);
  });

  it('joined=true enumerates the requester’s own memberships completely', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const mine: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const created = (await (
        await app().request(
          jsonRequest('/v1/rooms', 'POST', { ...ROOM, name: `Joined ${i}` }, steward.cookie),
        )
      ).json()) as { room_id: string };
      mine.push(created.room_id);
      await app().request(jsonRequest(`/v1/rooms/${created.room_id}/join`, 'POST', {}, cookie));
    }
    const res = await app().request(
      new Request('http://local/v1/rooms?joined=true', { headers: { cookie } }),
    );
    const body = (await res.json()) as { items: Array<{ room_id: string }> };
    expect(body.items.map((room) => room.room_id).sort()).toEqual([...mine].sort());
  });
});
