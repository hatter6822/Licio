// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.3/1.4 — the server non-storage gates for Private P2P rooms
// (PRIVATE_SPEC §8, §23.3–§23.7).  A p2p room id should never carry server
// content; these tests prove every ingress refuses it: submission, contribution
// (defense in depth), the room feed, the ranking room surface, server search,
// and the event pipeline.  Each guard fails closed with no side effect.
import { randomUUID } from 'node:crypto';
import { type ContentSubmittedEvent, contentSubmittedEventSchema } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContribution } from '../forum/contributions.js';
import { InMemorySearchIndex, type SearchDocument } from '../ingestion/search.js';
import { RoomSurfaceRetriever } from '../ranking/retrievers.js';
import { createCandidateDataPorts } from '../ranking/services.js';
import { createV1Routes } from '../routes/v1.js';
import { seedThread } from './forum-test-helpers.js';
import {
  briefSubmission,
  freshIngestionServices,
  type IngestionServicesFixture,
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

/** Insert a Private P2P room SHELL directly (the coherent §4.1 p2p axes). The
 *  in-memory store does not enforce the DB CHECKs, so this simulates the
 *  "should never happen" state the guards defend against. */
async function makeP2pRoom(): Promise<string> {
  const roomId = randomUUID();
  await fixture.forum.rooms.insert({
    roomId,
    name: `P2P ${roomId.slice(0, 8)}`,
    slug: `p2p-${roomId.slice(0, 8)}`,
    description: null,
    roomType: 'global_topic',
    visibility: 'private',
    joinModel: 'invite',
    postingPolicy: 'all_members',
    storageMode: 'p2p',
    createdBy: null,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: {},
    latestActivityAt: null,
  });
  return roomId;
}

describe('WS-S.1.3 submission guard', () => {
  it('rejects POST /v1/stories to a p2p room with 409 p2p_room_requires_client_sync', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const roomId = await makeP2pRoom();
    const res = await app().request(
      post('/v1/stories', briefSubmission({ room_id: roomId }), cookie),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('p2p_room_requires_client_sync');
  });

  it('creates NO story/thread row for a p2p room (the guard runs before any side effect)', async () => {
    const { cookie, userId } = await seedUserWithSession(fixture.identity);
    const roomId = await makeP2pRoom();
    await app().request(post('/v1/stories', briefSubmission({ room_id: roomId }), cookie));
    // No story was created for this submitter (the guard returned first).
    const recent = await fixture.ingestion.stories.listRecent(100);
    expect(recent.some((s) => s.roomId === roomId)).toBe(false);
    expect(recent.some((s) => s.submittedBy === userId)).toBe(false);
    expect(fixture.ingestion.metrics.snapshot()['submission.p2p_room_rejected']).toBe(1);
  });
});

describe('WS-S.1.3 contribution guard (defense in depth)', () => {
  it('rejects a contribution to a thread whose room is p2p with 404 (no oracle)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const roomId = await makeP2pRoom();
    // A p2p thread should never exist server-side; seed one to exercise the guard.
    const { threadId } = await seedThread(fixture, { roomId, visibility: 'room_only' });
    const outcome = await createContribution(fixture, userId, `acct-${userId}`, {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: randomUUID(),
      body: 'Should never be accepted.',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.status).toBe(404);
    expect(fixture.forum.metrics.snapshot()['contributions.p2p_room_rejected']).toBe(1);
  });

  it('still accepts a contribution to a SERVER-room thread (the guard is targeted)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const { threadId } = await seedThread(fixture); // defaults to the public Commons (server) room
    const outcome = await createContribution(fixture, userId, `acct-${userId}`, {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: randomUUID(),
      body: 'A perfectly normal comment.',
    });
    expect(outcome.ok).toBe(true);
  });
});

describe('WS-S.1.3 room-feed guard', () => {
  it('returns p2p_room_local_only for a p2p room feed (rendered locally, never served)', async () => {
    const roomId = await makeP2pRoom();
    const res = await app().request(`/v1/rooms/${roomId}/feed`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('p2p_room_local_only');
  });
});

describe('WS-S.1.4 ranking room-surface exclusion', () => {
  it('the room surface serves NOTHING for a p2p room (storage check, isolated)', async () => {
    const p2pRoom = await makeP2pRoom();
    // Seed a thread in the p2p room — the surface must still return [] because
    // the storage check fires BEFORE iterating threads.
    await seedThread(fixture, { roomId: p2pRoom, visibility: 'room_only' });
    const ports = createCandidateDataPorts(
      fixture.events,
      fixture.ingestion,
      fixture.forum,
      fixture.identity,
    );
    const candidates = await new RoomSurfaceRetriever(ports).retrieve({
      userId: null,
      surface: 'room',
      surfaceRoomId: p2pRoom,
      nowMs: Date.now(),
      limit: 10,
    });
    expect(candidates).toEqual([]);
  });
});

describe('WS-S.1.4 server search exclusion', () => {
  it('never returns a p2p-room document (query-time storage filter)', async () => {
    const base = {
      resultType: 'story' as const,
      storyId: null,
      snippet: null,
      topicIds: [],
      sourceId: null,
      language: 'en',
      createdAt: '2026-06-22T00:00:00.000Z',
      visible: true,
      authorUserId: null,
      disputeStatus: 'none' as const,
      roomId: randomUUID(),
      storyVisibility: 'public' as const,
      roomVisibility: 'public' as const,
    };
    const serverDoc: SearchDocument = {
      ...base,
      id: 'server-1',
      title: 'shared reservoir finding',
      body: 'public server content',
      roomStorageMode: 'server',
    };
    const p2pDoc: SearchDocument = {
      ...base,
      id: 'p2p-1',
      title: 'shared reservoir finding',
      body: 'private p2p content',
      // A p2p doc should never be indexed; the filter excludes it regardless.
      roomStorageMode: 'p2p',
    };
    const index = new InMemorySearchIndex(async () => [serverDoc, p2pDoc]);
    const result = await index.search({ q: 'reservoir', prefix: false, limit: 20 });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain('server-1');
    expect(ids).not.toContain('p2p-1');
  });
});

describe('WS-S.1.4 event-pipeline gate', () => {
  it('refuses to publish a content event referencing a p2p room (+ security counter)', async () => {
    const roomId = await makeP2pRoom();
    const before = fixture.events.router.p2pRoomEventsRejected;
    const event: ContentSubmittedEvent = contentSubmittedEventSchema.parse({
      event_id: randomUUID(),
      event_type: 'content.submitted',
      timestamp: new Date().toISOString(),
      schema_version: '1',
      story_id: randomUUID(),
      submitted_by: randomUUID(),
      submission_type: 'original_brief',
      canonical_url: null,
      topic_ids: [randomUUID()],
      room_id: roomId,
      visibility: 'room_only',
      privacy_classification: 'restricted',
      retention_tier: 'public_contribution',
    });
    await fixture.events.router.publish(event);
    expect(fixture.events.router.p2pRoomEventsRejected).toBe(before + 1);
  });

  it('publishes a content event for a SERVER room normally (the gate is targeted)', async () => {
    const before = fixture.events.router.p2pRoomEventsRejected;
    const event: ContentSubmittedEvent = contentSubmittedEventSchema.parse({
      event_id: randomUUID(),
      event_type: 'content.submitted',
      timestamp: new Date().toISOString(),
      schema_version: '1',
      story_id: randomUUID(),
      submitted_by: randomUUID(),
      submission_type: 'original_brief',
      canonical_url: null,
      topic_ids: [randomUUID()],
      // The self-seeded public Commons room is server-storage.
      room_id: 'c0000000-0000-4000-8000-000000000000',
      visibility: 'public',
      privacy_classification: 'public',
      retention_tier: 'public_contribution',
    });
    await fixture.events.router.publish(event);
    expect(fixture.events.router.p2pRoomEventsRejected).toBe(before);
  });
});
