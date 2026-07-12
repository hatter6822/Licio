// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres test for the ATOMIC development seed (the index.ts wiring):
// every content store bound to ONE `db.transaction(...)` commits all-or-nothing,
// so a mid-seed failure can never leave a partial corpus that traps the seed's
// idempotency guard (which keys on ROOM_1, written early). Proven at a focused
// grain — a room + its story/thread, the FK-chained pair the real seed starts
// with — using random ids (row-scoped cleanup; safe alongside the other gated
// suites against the shared CI database). Skipped without DATABASE_URL.
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleRoomStore } from '../forum/drizzle-forum-stores.js';
import type { RoomRecord } from '../forum/stores.js';
import { DrizzleStoryStore } from '../ingestion/drizzle-ingestion-stores.js';
import type { StoryRecord } from '../ingestion/stores.js';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('atomic development seed transaction (live Postgres)', () => {
  let db: ReturnType<typeof createDbClient>;
  let authorId: string;
  const roomIds: string[] = [];
  const storyIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    const { users } = await import('@licio/db');
    const rows = await db
      .insert(users)
      .values({
        handle: `seedtx_${randomUUID().slice(0, 8)}`,
        displayName: 'Seed Tx',
        email: null,
        ageBandIfKnown: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
      })
      .returning();
    const created = rows[0];
    if (!created) throw new Error('seed-tx user insert failed');
    authorId = created.userId;
  });

  afterAll(async () => {
    // Row-scoped cleanup (dependents before referents; threads cascade from
    // stories), then close this suite's own client.
    const dbSchema = await import('@licio/db');
    const { inArray } = await import('drizzle-orm');
    if (storyIds.length > 0) {
      await db.delete(dbSchema.threads).where(inArray(dbSchema.threads.storyId, storyIds));
      await db.delete(dbSchema.stories).where(inArray(dbSchema.stories.storyId, storyIds));
    }
    if (roomIds.length > 0) {
      await db.delete(dbSchema.rooms).where(inArray(dbSchema.rooms.roomId, roomIds));
    }
    await db.delete(dbSchema.users).where(inArray(dbSchema.users.userId, [authorId]));
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  function roomSpec(roomId: string): Omit<RoomRecord, 'createdAt' | 'updatedAt'> {
    const suffix = roomId.slice(0, 8);
    return {
      roomId,
      name: `Seed Tx Room ${suffix}`,
      slug: `seed-tx-room-${suffix}`,
      description: 'Atomic-seed transaction room.',
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      storageMode: 'server',
      createdBy: authorId,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
      frozen: false,
      migratedToRoomId: null,
    };
  }

  function storySpec(
    storyId: string,
    roomId: string,
  ): Omit<StoryRecord, 'createdAt' | 'updatedAt' | 'lastMaterialUpdateAt'> {
    return {
      storyId,
      canonicalUrl: null,
      title: `Seed Tx Story ${storyId.slice(0, 8)}`,
      titleHash: randomUUID().replaceAll('-', ''),
      submittedBy: authorId,
      sourceId: null,
      roomId,
      visibility: 'public',
      mediaUploadRef: null,
      canonicalPublicStoryId: null,
      language: 'en',
      topicIds: [randomUUID()],
      proposedTopicIds: [randomUUID()],
      locationScope: null,
      sensitivityLabels: ['none'] as StoryRecord['sensitivityLabels'],
      lifecycleState: 'gathering_attention',
      submissionType: 'original_brief',
      submissionMetadata: { submission_type: 'original_brief', body: 'Seed body.' },
      excerpt: 'Seed body.',
      publisher: null,
      author: null,
      publishedAt: null,
      mediaType: null,
      extractionState: 'not_applicable',
      hiddenState: null,
    };
  }

  it('rolls the whole content set back when the transaction fails', async () => {
    const roomId = randomUUID();
    const storyId = randomUUID();
    // Track for cleanup in case the rollback (unexpectedly) fails to undo them.
    roomIds.push(roomId);
    storyIds.push(storyId);
    await expect(
      db.transaction(async (tx) => {
        await new DrizzleRoomStore(tx).insert(roomSpec(roomId));
        const created = await new DrizzleStoryStore(tx).createWithThread(
          storySpec(storyId, roomId),
          randomUUID(),
        );
        if (!created.ok) throw new Error('story insert failed inside tx');
        // A mid-seed failure AFTER both writes: the transaction must undo BOTH.
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    // Read through a NON-transactional store: neither write survived.
    expect(await new DrizzleRoomStore(db).getById(roomId)).toBeNull();
    expect(await new DrizzleStoryStore(db).getById(storyId)).toBeNull();
    expect(await new DrizzleStoryStore(db).getThreadByStoryId(storyId)).toBeNull();
  });

  it('commits the room, story, and thread shell together on success', async () => {
    const roomId = randomUUID();
    const storyId = randomUUID();
    roomIds.push(roomId);
    storyIds.push(storyId);
    await db.transaction(async (tx) => {
      await new DrizzleRoomStore(tx).insert(roomSpec(roomId));
      const created = await new DrizzleStoryStore(tx).createWithThread(
        storySpec(storyId, roomId),
        randomUUID(),
      );
      if (!created.ok) throw new Error('story insert failed inside tx');
    });

    // All three rows committed atomically and are visible after the transaction.
    expect(await new DrizzleRoomStore(db).getById(roomId)).not.toBeNull();
    expect(await new DrizzleStoryStore(db).getById(storyId)).not.toBeNull();
    expect(await new DrizzleStoryStore(db).getThreadByStoryId(storyId)).not.toBeNull();
  });
});
