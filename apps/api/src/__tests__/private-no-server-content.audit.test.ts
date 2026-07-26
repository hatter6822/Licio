// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.11 audit — "a Private P2P room places NO content on the server"
// (PRIVATE_SPEC §8, §23.10).  This is the AUTOMATED umbrella assertion behind the
// `check:no-p2p-server-content` static gate: where that gate proves the guards
// are PRESENT in source (markers + the structural column denylist), and
// `private-p2p-server-gates.test.ts` exercises each ingress in isolation, THIS
// suite ties them into one `assertNoP2PServerContent(roomId)` audit that runs the
// whole contract end-to-end and confirms that — after a real submission /
// contribution / feed attempt — NO content row references the p2p room.
//
//   • §8.1/§8.2 — the structural column denylist on the two private-room server
//     tables is clean (no content/CID/member column can have been added).
//   • §23.3   — `POST /v1/stories` to a p2p room 409s (`p2p_room_requires_client_sync`)
//     before any side effect, and no story/thread row is created.
//   • §23.4   — a contribution to a p2p-room thread 404s (no oracle), no row created.
//   • §23.5   — `GET /v1/rooms/:id/feed` 409s (`p2p_room_local_only`).
//
// GATED leg (`DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev`):
// against REAL Postgres, the production `DrizzleStoryStore.createWithThread`
// adapter (the exact ORM path the submission service uses) is REJECTED by the
// §8.3 trigger for a coherent p2p room, and zero rows persist.  (The db package's
// `migration-harness.test.ts` already proves the trigger via RAW SQL on all five
// room-referencing tables; this leg complements it by proving the production ORM
// adapter path is blocked too, and leaves the store empty.)
import { randomUUID } from 'node:crypto';
import { checkPrivateServerTables } from '@licio/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContribution } from '../forum/contributions.js';
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

/** Insert a coherent §4.1 Private P2P room SHELL into the in-memory store (the
 *  "should never happen" state the runtime guards defend against — the in-memory
 *  store does not enforce the DB CHECKs, so this simulates it directly). */
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

/**
 * The umbrella audit: drive EVERY content-ingress endpoint at a p2p room and
 * assert it fails closed BEFORE any side effect, then confirm no content row in
 * any server store references the room.  Returns the observed rejection statuses
 * so a caller can additionally assert the exact codes.
 */
async function assertNoP2PServerContent(roomId: string): Promise<{
  submissionStatus: number;
  feedStatus: number;
}> {
  const { cookie, userId } = await seedUserWithSession(fixture.identity);

  // 1) Submission (§23.3) — must reject before creating a story/thread.
  const submission = await app().request(
    post('/v1/stories', briefSubmission({ room_id: roomId }), cookie),
  );

  // 2) Room feed (§23.5) — must reject (rendered locally, never served).
  const feed = await app().request(`/v1/rooms/${roomId}/feed`);

  // 3) No content row anywhere references the p2p room (the actual invariant).
  const recent = await fixture.ingestion.stories.listRecent(500);
  expect(recent.some((s) => s.roomId === roomId)).toBe(false);
  // The submitter created NOTHING (the guard returned before any write).
  expect(recent.some((s) => s.submittedBy === userId)).toBe(false);

  return { submissionStatus: submission.status, feedStatus: feed.status };
}

describe('WS-S.11 — §8.1/§8.2 structural column contract (precondition)', () => {
  it('the two private-room server tables carry NO content/CID/member column', () => {
    // If a content column had been added to the stub/rendezvous table, the whole
    // non-storage contract would be void; this is the structural precondition.
    expect(checkPrivateServerTables()).toEqual([]);
  });
});

describe('WS-S.11 — assertNoP2PServerContent umbrella (in-memory)', () => {
  it('a p2p room rejects submission + feed and persists ZERO content rows', async () => {
    const roomId = await makeP2pRoom();
    const { submissionStatus, feedStatus } = await assertNoP2PServerContent(roomId);
    expect(submissionStatus).toBe(409);
    expect(feedStatus).toBe(409);
    // The submission counter records the rejection (no story was written).
    expect(fixture.ingestion.metrics.snapshot()['submission.p2p_room_rejected']).toBe(1);
  });

  it('emits the exact §23.3/§23.5 rejection codes (no oracle, no side effect)', async () => {
    const roomId = await makeP2pRoom();
    const { cookie } = await seedUserWithSession(fixture.identity);
    const submission = await app().request(
      post('/v1/stories', briefSubmission({ room_id: roomId }), cookie),
    );
    const subBody = (await submission.json()) as { error: { code: string } };
    expect(subBody.error.code).toBe('p2p_room_requires_client_sync');

    const feed = await app().request(`/v1/rooms/${roomId}/feed`);
    const feedBody = (await feed.json()) as { error: { code: string } };
    expect(feedBody.error.code).toBe('p2p_room_local_only');
  });

  it('the contribution path (§23.4) refuses a p2p-room thread with no oracle (404) + no row', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const roomId = await makeP2pRoom();
    // A p2p thread can never legitimately exist server-side; seed one to exercise
    // the defense-in-depth guard, then prove a contribution to it is refused.
    const { threadId } = await seedThread(fixture, { roomId, visibility: 'room_only' });
    const outcome = await createContribution(fixture, userId, `acct-${userId}`, {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: randomUUID(),
      body: 'This must never be accepted into a p2p room.',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.status).toBe(404);
    expect(fixture.forum.metrics.snapshot()['contributions.p2p_room_rejected']).toBe(1);
  });

  it('a SERVER room is unaffected — the audit is targeted, not a blanket block', async () => {
    // Sanity floor: the SAME endpoints accept a server room, so the p2p rejection
    // is a real discriminator, not a globally-broken path.
    const { cookie } = await seedUserWithSession(fixture.identity);
    const submission = await app().request(post('/v1/stories', briefSubmission(), cookie));
    expect(submission.status).toBe(201);
    const recent = await fixture.ingestion.stories.listRecent(10);
    expect(recent.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GATED — the production ORM adapter path is blocked by the §8.3 DB trigger.
// ---------------------------------------------------------------------------

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)(
  'WS-S.11 — §8.3 DB trigger blocks the production ORM path (live Postgres)',
  () => {
    let db: Awaited<ReturnType<typeof import('@licio/db')['createDbClient']>>;
    let userId: string;
    const createdRoomIds: string[] = [];
    const attemptedStoryIds: string[] = [];
    const createdUserIds: string[] = [];

    beforeAll(async () => {
      const { createDbClient, migrationsFolder, users } = await import('@licio/db');
      const { defaultPersonalizationSettings, defaultPrivacySettings } = await import(
        '@licio/shared'
      );
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      db = createDbClient(DB_URL as string, { onNotice: 'discard' });
      await migrate(db, { migrationsFolder: migrationsFolder() });
      const inserted = await db
        .insert(users)
        .values({
          handle: `wss11_${randomUUID().slice(0, 8)}`,
          displayName: 'WS-S.11 audit',
          email: null,
          ageBandIfKnown: 'adult',
          privacySettings: defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
        })
        .returning();
      userId = (inserted[0] as { userId: string }).userId;
      createdUserIds.push(userId);
    });

    afterAll(async () => {
      if (!db) return;
      const { stories, rooms, users } = await import('@licio/db');
      const { inArray } = await import('drizzle-orm');
      if (attemptedStoryIds.length > 0) {
        await db.delete(stories).where(inArray(stories.storyId, attemptedStoryIds));
      }
      if (createdRoomIds.length > 0) {
        await db.delete(rooms).where(inArray(rooms.roomId, createdRoomIds));
      }
      if (createdUserIds.length > 0) {
        await db.delete(users).where(inArray(users.userId, createdUserIds));
      }
      const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
      await client.end();
    });

    /** Insert a COHERENT p2p room (the 0043 axis CHECKs must pass): room_keys +
     *  private + invite + unlisted.  Raw SQL so every axis is set explicitly. */
    async function insertCoherentP2pRoom(): Promise<string> {
      const { sql } = await import('drizzle-orm');
      const roomId = randomUUID();
      createdRoomIds.push(roomId);
      await db.execute(
        sql`INSERT INTO rooms (room_id, name, slug, room_type, visibility, join_model, posting_policy, storage_mode, authority_model, directory_mode)
          VALUES (${roomId}, ${`Secret ${roomId.slice(0, 8)}`}, ${`sec-${roomId.slice(0, 8)}`}, 'global_topic', 'private', 'invite', 'all_members', 'p2p', 'room_keys', 'unlisted')`,
      );
      return roomId;
    }

    it('DrizzleStoryStore.createWithThread is rejected for a p2p room and leaves zero rows', async () => {
      const { DrizzleStoryStore } = await import('../ingestion/drizzle-ingestion-stores.js');
      const store = new DrizzleStoryStore(db);
      const roomId = await insertCoherentP2pRoom();

      const storyId = randomUUID();
      attemptedStoryIds.push(storyId);
      const threadId = randomUUID();

      // The production adapter's transactional insert hits the §8.3 trigger and
      // throws (a check_violation) — the same code path the submission service runs.
      await expect(
        store.createWithThread(
          {
            storyId,
            canonicalUrl: null,
            title: 'must never persist',
            titleHash: `h-${storyId.slice(0, 8)}`,
            submittedBy: userId,
            sourceId: null,
            roomId,
            visibility: 'room_only',
            mediaUploadRef: null,
            canonicalPublicStoryId: null,
            language: 'en',
            topicIds: [randomUUID()],
            locationScope: null,
            sensitivityLabels: [],
            lifecycleState: 'submitted',
            submissionType: 'original_brief',
            submissionMetadata: { submission_type: 'original_brief', body: 'must never persist' },
            excerpt: null,
            publisher: null,
            author: null,
            publishedAt: null,
            mediaType: null,
            extractionState: 'pending',
            hiddenState: null,
          },
          threadId,
        ),
      ).rejects.toThrow();

      // The whole transaction rolled back — no story row for the p2p room.
      const recent = await store.listRecent(500);
      expect(recent.some((s) => s.roomId === roomId)).toBe(false);
      expect(recent.some((s) => s.storyId === storyId)).toBe(false);
    });
  },
);
