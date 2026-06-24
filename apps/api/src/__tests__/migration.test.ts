// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — the server-side server-room → Private-P2P-room migration (PRIVATE_SPEC
// §24).  Proves: the export is steward-authorized + carries the right shape; a
// FROZEN room rejects every write (submission + contribution, fail-closed); purge
// is GATED on the freeze; an `anonymize` detaches ONLY the actor (non-vacuously —
// a second member's content is untouched); a `purge` IRREVERSIBLY minimizes EVERY
// §24.2 category (stories/threads/contributions incl. OTHER members'/summaries/
// media uploads/lenses, with the search index following); and the full
// export→freeze→purge flow runs end to end over multi-member seeded content.
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

  it('purge PAGES past the first batch: EVERY live story is taken down (multi-page sweep)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity, { steward: true });
    const roomId = await makeServerRoom();
    // THREE stories — more than the injected one-page sweep limit of 2.  With the old
    // `listByRoom`+JS-filter, pass 2 re-read the now-hidden newest page, `live` went empty, and
    // the loop exited leaving the third (older) story PUBLISHED.  `listLiveByRoom` advances.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { storyId } = await seedThread(fixture, { roomId, submittedBy: userId });
      ids.push(storyId);
    }
    await freezeRoomForMigration(fixture.forum, userId, ['user', 'steward'], roomId, randomUUID());
    const out = await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      userId,
      ['user', 'steward'],
      roomId,
      'purge',
      2, // sweepLimit: force a multi-page drain
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.storiesAffected).toBe(3);
    for (const id of ids) {
      const story = await fixture.ingestion.stories.getById(id);
      expect(story?.hiddenState).toBe('takedown');
    }
  });

  it('anonymize detaches ONLY the steward authorship; other members keep theirs (non-vacuous)', async () => {
    // Two distinct members author in the room — the steward AND a second member.
    const { userId: steward } = await seedUserWithSession(fixture.identity, { steward: true });
    const { userId: member } = await seedUserWithSession(fixture.identity);
    const roomId = await makeServerRoom();
    const { storyId, threadId } = await seedThread(fixture, { roomId, submittedBy: steward });
    const stewardComment = await createContribution(fixture, steward, `acct-${steward}`, {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: randomUUID(),
      body: "Steward's comment.",
    });
    const memberComment = await createContribution(fixture, member, `acct-${member}`, {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: randomUUID(),
      body: "Another member's comment.",
    });
    expect(stewardComment.ok && memberComment.ok).toBe(true);
    if (!stewardComment.ok || !memberComment.ok) return;
    await freezeRoomForMigration(fixture.forum, steward, ['user', 'steward'], roomId, randomUUID());

    const out = await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      steward,
      ['user', 'steward'],
      roomId,
      'anonymize',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.mode).toBe('anonymize');
    // The story stays readable (anonymize is non-destructive on content).
    const story = await fixture.ingestion.stories.getById(storyId);
    expect(story?.hiddenState).toBe(null);
    // The steward's authorship is detached; the OTHER member's authorship is NOT
    // (anonymize is the steward's own DSAR — it cannot touch a third party).
    const sc = await fixture.forum.contributions.getById(
      stewardComment.contribution.contributionId,
    );
    const mc = await fixture.forum.contributions.getById(memberComment.contribution.contributionId);
    expect(sc?.userId).toBe(null);
    expect(mc?.userId).toBe(member);
    // Both comment BODIES survive (anonymize keeps content readable).
    expect(sc?.body).toBe("Steward's comment.");
    expect(mc?.body).toBe("Another member's comment.");
  });
});

/**
 * Seed a fully-populated server room: a story (with media upload), a thread with
 * a steward comment AND a second member's comment, a derived summary, and a lens.
 * Returns the ids so a purge can assert each §24.2 category is removed.
 */
async function seedPopulatedRoom(
  fx: ForumServicesFixture,
  steward: string,
  member: string,
): Promise<{
  roomId: string;
  storyId: string;
  threadId: string;
  stewardCommentId: string;
  memberCommentId: string;
  summaryId: string;
  lensId: string;
  uploadId: string;
}> {
  const roomId = await makeServerRoom();
  const { storyId, threadId } = await seedThread(fx, {
    roomId,
    submittedBy: steward,
    title: 'Reservoir bond vote',
  });
  // A media upload anchored to the story (the §24.2 "media uploads" category).
  const uploadId = randomUUID();
  await fx.forum.uploads.put(
    {
      uploadId,
      ownerUserId: steward,
      contentType: 'image/png',
      byteSize: 3,
      altText: 'chart',
      storageRef: `uploads/${uploadId}`,
      metadataStripped: true,
      scanState: 'clear',
      ownerStoryId: storyId,
    },
    new Uint8Array([1, 2, 3]),
  );
  const sc = await createContribution(fx, steward, `acct-${steward}`, {
    type: 'comment',
    thread_id: threadId,
    client_draft_id: randomUUID(),
    body: "Steward's comment.",
  });
  const mc = await createContribution(fx, member, `acct-${member}`, {
    type: 'comment',
    thread_id: threadId,
    client_draft_id: randomUUID(),
    body: "Another member's comment.",
  });
  if (!sc.ok || !mc.ok) throw new Error('seedPopulatedRoom: contribution failed');
  const summary = await fx.forum.summaries.insert({
    summaryId: randomUUID(),
    threadId,
    layer: 'community_synthesis',
    body: 'Both branches agree the dataset is authentic.',
    citedBranchIds: [sc.contribution.contributionId],
    citedEvidenceIds: [],
    unresolvedUncertainty: 'Whether the 2024 revision changed the method.',
    minorityViewsNote: null,
    authoredBy: steward,
    approvedBy: null,
  });
  const lens = await fx.forum.lenses.insert({
    lensId: randomUUID(),
    roomId,
    name: 'Local residents',
    lensType: 'local_resident',
    description: 'People who live there.',
  });
  if (!lens.ok) throw new Error('seedPopulatedRoom: lens failed');
  return {
    roomId,
    storyId,
    threadId,
    stewardCommentId: sc.contribution.contributionId,
    memberCommentId: mc.contribution.contributionId,
    summaryId: summary.summaryId,
    lensId: lens.lens.lensId,
    uploadId,
  };
}

describe('WS-S.9 purge — IRREVERSIBLY minimizes EVERY §24.2 category', () => {
  it("removes stories, threads, ALL members' contributions, summaries, media bytes + lenses", async () => {
    const { userId: steward } = await seedUserWithSession(fixture.identity, { steward: true });
    const { userId: member } = await seedUserWithSession(fixture.identity);
    const seeded = await seedPopulatedRoom(fixture, steward, member);
    await freezeRoomForMigration(
      fixture.forum,
      steward,
      ['user', 'steward'],
      seeded.roomId,
      randomUUID(),
    );

    const out = await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      steward,
      ['user', 'steward'],
      seeded.roomId,
      'purge',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.mode).toBe('purge');

    // Per-category counts reported honestly.
    expect(out.counts.stories).toBe(1);
    expect(out.counts.threads).toBe(1);
    expect(out.counts.contributions).toBe(2); // BOTH members' comments
    expect(out.counts.summaries).toBe(1);
    expect(out.counts.uploads).toBe(1);
    expect(out.counts.lenses).toBe(1);

    // 1. Story — taken down AND its archived body excerpt nulled.
    const story = await fixture.ingestion.stories.getById(seeded.storyId);
    expect(story?.hiddenState).toBe('takedown');
    expect(story?.excerpt).toBe(null);

    // 2. Thread — terminally archived.
    const thread = await fixture.ingestion.stories.getThreadById(seeded.threadId);
    expect(thread?.conversationState).toBe('archived');

    // 3. Contributions — ALL members' hard-deleted (not just the steward's).
    expect(await fixture.forum.contributions.getById(seeded.stewardCommentId)).toBe(null);
    expect(await fixture.forum.contributions.getById(seeded.memberCommentId)).toBe(null);
    expect(
      (await fixture.forum.contributions.listByThread(seeded.threadId, { limit: 50 })).length,
    ).toBe(0);

    // 4. Summary — hard-deleted.
    expect(await fixture.forum.summaries.getById(seeded.summaryId)).toBe(null);

    // 5. Media — record AND bytes destroyed.
    expect(await fixture.forum.uploads.getRecord(seeded.uploadId)).toBe(null);
    expect(await fixture.forum.uploads.getBytes(seeded.uploadId)).toBe(null);

    // 6. Lens — hard-deleted.
    expect((await fixture.forum.lenses.listByRoom(seeded.roomId)).length).toBe(0);
  });

  it('the purged content vanishes from search (the index is DERIVED from it)', async () => {
    const { userId: steward } = await seedUserWithSession(fixture.identity, { steward: true });
    const { userId: member } = await seedUserWithSession(fixture.identity);
    const seeded = await seedPopulatedRoom(fixture, steward, member);
    // Sanity: the story is searchable BEFORE the purge (room-scoped search).
    const before = await fixture.ingestion.searchIndex.search({
      q: 'Reservoir',
      room: seeded.roomId,
      prefix: false,
      limit: 10,
    });
    expect(before.items.length).toBeGreaterThan(0);

    await freezeRoomForMigration(
      fixture.forum,
      steward,
      ['user', 'steward'],
      seeded.roomId,
      randomUUID(),
    );
    await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      steward,
      ['user', 'steward'],
      seeded.roomId,
      'purge',
    );

    const after = await fixture.ingestion.searchIndex.search({
      q: 'Reservoir',
      room: seeded.roomId,
      prefix: false,
      limit: 10,
    });
    expect(after.items.length).toBe(0);
  });

  it('is idempotent — a second purge over already-purged content removes nothing', async () => {
    const { userId: steward } = await seedUserWithSession(fixture.identity, { steward: true });
    const { userId: member } = await seedUserWithSession(fixture.identity);
    const seeded = await seedPopulatedRoom(fixture, steward, member);
    await freezeRoomForMigration(
      fixture.forum,
      steward,
      ['user', 'steward'],
      seeded.roomId,
      randomUUID(),
    );
    await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      steward,
      ['user', 'steward'],
      seeded.roomId,
      'purge',
    );
    const second = await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      steward,
      ['user', 'steward'],
      seeded.roomId,
      'purge',
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.counts).toStrictEqual({
      stories: 0,
      threads: 0,
      contributions: 0,
      summaries: 0,
      uploads: 0,
      lenses: 0,
    });
  });

  it('still refuses to purge a room that is NOT frozen (gated, fail-closed)', async () => {
    const { userId: steward } = await seedUserWithSession(fixture.identity, { steward: true });
    const { userId: member } = await seedUserWithSession(fixture.identity);
    const seeded = await seedPopulatedRoom(fixture, steward, member);
    const out = await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      steward,
      ['user', 'steward'],
      seeded.roomId,
      'purge',
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('room_not_frozen');
    // Nothing was minimized — the content survives intact.
    expect(await fixture.forum.contributions.getById(seeded.memberCommentId)).not.toBe(null);
    expect((await fixture.ingestion.stories.getById(seeded.storyId))?.hiddenState).toBe(null);
  });
});

describe('WS-S.9 full migration flow — export → freeze → purge end to end', () => {
  it('drives the whole server-side migration over multi-member content', async () => {
    const { userId: steward } = await seedUserWithSession(fixture.identity, { steward: true });
    const { userId: member } = await seedUserWithSession(fixture.identity);
    const seeded = await seedPopulatedRoom(fixture, steward, member);
    const roles: Array<'user' | 'steward'> = ['user', 'steward'];

    // Phase 1/3 — export carries both members' content + the resume fields.
    const exported = await exportRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      steward,
      roles,
      seeded.roomId,
    );
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.frozen).toBe(false);
    expect(exported.migratedToRoomId).toBe(null);
    const exportedComments = exported.items.filter((i) => i.kind === 'contribution');
    expect(exportedComments.length).toBe(2); // BOTH members' comments are exportable
    expect(exportedComments.map((c) => c.body).sort()).toStrictEqual([
      "Another member's comment.",
      "Steward's comment.",
    ]);

    // Phase 5 — freeze records the OPAQUE P2P destination; a write now 409s.
    const destination = randomUUID();
    const frozen = await freezeRoomForMigration(
      fixture.forum,
      steward,
      roles,
      seeded.roomId,
      destination,
    );
    expect(frozen.ok).toBe(true);
    const reExport = await exportRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      steward,
      roles,
      seeded.roomId,
    );
    expect(reExport.ok && reExport.frozen).toBe(true);
    if (reExport.ok) expect(reExport.migratedToRoomId).toBe(destination); // resume field
    const blocked = await createContribution(fixture, member, `acct-${member}`, {
      type: 'comment',
      thread_id: seeded.threadId,
      client_draft_id: randomUUID(),
      body: 'A post-freeze comment that must be rejected.',
    });
    expect(blocked.ok).toBe(false);

    // Phase 6 — purge minimizes every category.
    const purged = await purgeRoomForMigration(
      fixture.forum,
      fixture.ingestion,
      steward,
      roles,
      seeded.roomId,
      'purge',
    );
    expect(purged.ok).toBe(true);
    if (!purged.ok) return;
    expect(purged.counts.contributions).toBe(2);
    expect((await fixture.ingestion.stories.getById(seeded.storyId))?.hiddenState).toBe('takedown');
    expect(await fixture.forum.contributions.getById(seeded.memberCommentId)).toBe(null);
  });
});
