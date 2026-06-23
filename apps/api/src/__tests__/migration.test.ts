// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — the server-side server-room → Private-P2P-room migration (PRIVATE_SPEC
// §24).  Proves: the export is steward-authorized + carries the right shape; a
// FROZEN room rejects every write (submission + contribution, fail-closed); purge
// is GATED on the freeze; and an authorized purge/anonymize minimizes content.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContribution } from '../forum/contributions.js';
import {
  exportRoomForMigration,
  freezeRoomForMigration,
  purgeRoomForMigration,
} from '../forum/migration-export.js';
import { submitStory } from '../ingestion/submission.js';
import { createV1Routes } from '../routes/v1.js';
import { type ForumServicesFixture, freshForumServices, seedThread } from './forum-test-helpers.js';
import { briefSubmission, post, seedUserWithSession } from './ingestion-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: ForumServicesFixture;

beforeEach(() => {
  fixture = freshForumServices({ config: { minAccountAgeMinutes: 0 } });
});

/** Insert a server-storage (Members-only) room. */
async function makeServerRoom(over: Record<string, unknown> = {}): Promise<string> {
  const roomId = randomUUID();
  await fixture.forum.rooms.insert({
    roomId,
    name: `Server ${roomId.slice(0, 8)}`,
    slug: `server-${roomId.slice(0, 8)}`,
    description: null,
    roomType: 'global_topic',
    visibility: 'public',
    joinModel: 'open',
    postingPolicy: 'all_members',
    storageMode: 'server',
    createdBy: null,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: {},
    latestActivityAt: null,
    ...over,
  });
  return roomId;
}

describe('WS-S.9 export — authorization + shape', () => {
  it('a room steward exports the room stories + published contributions in source shape', async () => {
    const { userId } = await seedUserWithSession(fixture.identity, { steward: true });
    const roomId = await makeServerRoom();
    const { storyId, threadId } = await seedThread(fixture, {
      roomId,
      submittedBy: userId,
      title: 'Reservoir bond vote',
    });
    const contribution = await createContribution(fixture, userId, `acct-${userId}`, {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: randomUUID(),
      body: 'The vote passed 7 to 2.',
    });
    expect(contribution.ok).toBe(true);

    const out = await exportRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      userId,
      ['user', 'steward'],
      roomId,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const story = out.items.find((i) => i.kind === 'story');
    const comment = out.items.find((i) => i.kind === 'contribution');
    expect(story).toMatchObject({ id: storyId, kind: 'story', title: 'Reservoir bond vote' });
    expect(story?.threadRef).toBe(threadId);
    expect(comment).toMatchObject({ kind: 'contribution', threadRef: threadId });
    expect(comment?.body).toBe('The vote passed 7 to 2.');
  });

  it('a NON-steward (no role) is refused with not_found (no membership oracle)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const roomId = await makeServerRoom();
    await seedThread(fixture, { roomId, submittedBy: userId });
    const out = await exportRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      userId,
      ['user'],
      roomId,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(404);
    expect(out.code).toBe('not_found');
  });

  it('the export route returns 401/404 for an unauthenticated / non-steward caller', async () => {
    const roomId = await makeServerRoom();
    const res = await app().request(post(`/v1/rooms/${roomId}/migration/export`, {}));
    // Unauthenticated → the auth middleware 401s before the service runs.
    expect(res.status).toBe(401);
  });
});

describe('WS-S.9 freeze — the old room becomes read-only (fail-closed)', () => {
  it('rejects a story submission to a frozen room with 409 room_frozen', async () => {
    const { userId } = await seedUserWithSession(fixture.identity, { steward: true });
    const roomId = await makeServerRoom();
    const frozen = await freezeRoomForMigration(
      fixture.forum,
      userId,
      ['user', 'steward'],
      roomId,
      randomUUID(),
    );
    expect(frozen.ok).toBe(true);

    const outcome = await submitStory(
      fixture.ingestion,
      fixture.events,
      fixture.identity,
      fixture.forum,
      userId,
      briefSubmission({ room_id: roomId }) as Parameters<typeof submitStory>[5],
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.status).toBe(409);
    expect(outcome.rejection.code).toBe('room_frozen');
    // No story row was created (the guard runs before any side effect).
    const recent = await fixture.ingestion.stories.listRecent(100);
    expect(recent.some((s) => s.roomId === roomId)).toBe(false);
  });

  it('rejects a contribution to a thread in a frozen room (fail-closed)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity, { steward: true });
    const roomId = await makeServerRoom();
    // Seed the thread BEFORE freezing (existing content stays readable).
    const { threadId } = await seedThread(fixture, { roomId, submittedBy: userId });
    await freezeRoomForMigration(fixture.forum, userId, ['user', 'steward'], roomId, null);

    const outcome = await createContribution(fixture, userId, `acct-${userId}`, {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: randomUUID(),
      body: 'A late comment that must be rejected.',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.status).toBe(409);
    expect(fixture.forum.metrics.snapshot()['contributions.room_frozen_rejected']).toBe(1);
  });

  it('a non-frozen room still accepts writes (the freeze is targeted)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const { threadId } = await seedThread(fixture); // public Commons (server, not frozen)
    const outcome = await createContribution(fixture, userId, `acct-${userId}`, {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: randomUUID(),
      body: 'A perfectly normal comment.',
    });
    expect(outcome.ok).toBe(true);
  });
});

describe('WS-S.9 purge — gated on the freeze; minimizes content', () => {
  it('refuses to purge a room that is NOT frozen (the §8 disclosure stays honest)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity, { steward: true });
    const roomId = await makeServerRoom();
    await seedThread(fixture, { roomId, submittedBy: userId });
    const out = await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      userId,
      ['user', 'steward'],
      roomId,
      'purge',
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.code).toBe('room_not_frozen');
  });

  it('purge takes the old stories down once the room is frozen', async () => {
    const { userId } = await seedUserWithSession(fixture.identity, { steward: true });
    const roomId = await makeServerRoom();
    const { storyId } = await seedThread(fixture, { roomId, submittedBy: userId });
    await freezeRoomForMigration(fixture.forum, userId, ['user', 'steward'], roomId, randomUUID());

    const out = await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      userId,
      ['user', 'steward'],
      roomId,
      'purge',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.mode).toBe('purge');
    expect(out.storiesAffected).toBe(1);
    const story = await fixture.ingestion.stories.getById(storyId);
    expect(story?.hiddenState).toBe('takedown');
  });

  it('anonymize detaches the steward authorship while keeping stories readable', async () => {
    const { userId } = await seedUserWithSession(fixture.identity, { steward: true });
    const roomId = await makeServerRoom();
    const { storyId, threadId } = await seedThread(fixture, { roomId, submittedBy: userId });
    await createContribution(fixture, userId, `acct-${userId}`, {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: randomUUID(),
      body: 'Authored comment.',
    });
    await freezeRoomForMigration(fixture.forum, userId, ['user', 'steward'], roomId, randomUUID());

    const out = await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      userId,
      ['user', 'steward'],
      roomId,
      'anonymize',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.mode).toBe('anonymize');
    // The story is still readable (not taken down) but the contribution authorship
    // is tombstoned (the WS-Q DSAR anonymize machinery).
    const story = await fixture.ingestion.stories.getById(storyId);
    expect(story?.hiddenState).toBe(null);
    const comments = await fixture.forum.contributions.listByThread(threadId, {
      states: ['published'],
      limit: 50,
    });
    expect(comments.every((c) => c.userId === null)).toBe(true);
  });
});
