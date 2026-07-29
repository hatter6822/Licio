// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres pin for the ONE thing `PostgresSearchIndex` cannot be
// unit-tested into: the shape of a `timestamptz` read back through the RAW
// `db.execute` path.  Drizzle's raw path returns Postgres's own output text
// (`2026-07-28 23:58:55.359+00`), not a `Date`, so the adapter's `created_at`
// was NOT ISO-8601 — and both of its consumers require ISO:
//   • `routes/stories.ts` re-validates the reply through `searchResponseSchema`
//     (`created_at: isoTimestampSchema`), so a non-ISO value is a 500 on every
//     non-empty `GET /v1/search`;
//   • `encodeSearchCursor` embeds it in the keyset cursor that
//     `decodeSearchCursor` has to read back on the next page.
// Nothing else covers this: the in-memory index carries ISO strings by
// construction, and the store-level suites compare ids, never the timestamp.
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_ci pnpm test
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  searchResponseSchema,
} from '@licio/shared';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleStoryStore, PostgresSearchIndex } from '../drizzle-ingestion-stores.js';
import { decodeSearchCursor } from '../search.js';
import type { StoryRecord } from '../stores.js';

const DB_URL = process.env['DATABASE_URL'];
/** A nonsense token so the corpus is exactly what this suite seeds. */
const TERM = 'zorbulant';

describe.skipIf(!DB_URL)('PostgresSearchIndex emits an ISO-8601 created_at', () => {
  let db: ReturnType<typeof createDbClient>;
  let search: PostgresSearchIndex;
  let submitterId: string;
  let roomId: string;
  const storyIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    const { rooms, users } = await import('@licio/db');
    const insertedUser = await db
      .insert(users)
      .values({
        handle: `wsf_iso_${randomUUID().slice(0, 8)}`,
        displayName: 'WS-F iso timestamps',
        email: null,
        ageBandIfKnown: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
      })
      .returning();
    submitterId = (insertedUser[0] as { userId: string }).userId;
    const insertedRoom = await db
      .insert(rooms)
      .values({
        name: `WS-F iso room ${randomUUID().slice(0, 8)}`,
        slug: `wsf-iso-${randomUUID().slice(0, 8)}`,
        roomType: 'global_topic',
        visibility: 'public',
        joinModel: 'open',
        postingPolicy: 'all_members',
      })
      .returning();
    roomId = (insertedRoom[0] as { roomId: string }).roomId;
    const stories = new DrizzleStoryStore(db);
    search = new PostgresSearchIndex(db);
    for (const suffix of ['alpha', 'beta']) {
      const storyId = randomUUID();
      const created = await stories.createWithThread(
        {
          storyId,
          canonicalUrl: null,
          title: `The ${TERM} report ${suffix}`,
          titleHash: randomUUID().replaceAll('-', ''),
          submittedBy: submitterId,
          sourceId: null,
          roomId,
          visibility: 'public',
          mediaUploadRef: null,
          canonicalPublicStoryId: null,
          language: 'en',
          topicIds: [randomUUID()],
          locationScope: null,
          sensitivityLabels: ['none'] as StoryRecord['sensitivityLabels'],
          lifecycleState: 'submitted',
          submissionType: 'original_brief',
          submissionMetadata: { submission_type: 'original_brief', body: `A ${TERM} body.` },
          excerpt: `A ${TERM} body.`,
          publisher: null,
          author: null,
          publishedAt: null,
          mediaType: null,
          extractionState: 'not_applicable',
          hiddenState: null,
        },
        randomUUID(),
      );
      if (!created.ok) throw new Error('story seed failed');
      storyIds.push(storyId);
    }
  });

  afterAll(async () => {
    // ROW-SCOPED cleanup: vitest projects run in parallel against the SAME live
    // database, so a blanket clear() would race the other gated suites.
    const dbSchema = await import('@licio/db');
    const { inArray } = await import('drizzle-orm');
    if (storyIds.length > 0) {
      await db.delete(dbSchema.threads).where(inArray(dbSchema.threads.storyId, storyIds));
      await db.delete(dbSchema.stories).where(inArray(dbSchema.stories.storyId, storyIds));
    }
    await db.delete(dbSchema.rooms).where(inArray(dbSchema.rooms.roomId, [roomId]));
    await db.delete(dbSchema.users).where(inArray(dbSchema.users.userId, [submitterId]));
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  it('produces a response the route can re-validate, and a cursor that decodes', async () => {
    const page = await search.search({ q: TERM, limit: 1, prefix: false });
    expect(page.items).toHaveLength(1);
    // The exact call `routes/stories.ts` makes before replying — a Postgres
    // output-format timestamp throws here (a caller-visible 500).
    expect(() =>
      searchResponseSchema.parse({ items: page.items, nextCursor: page.nextCursor }),
    ).not.toThrow();
    const createdAt = page.items[0]?.created_at as string;
    expect(new Date(createdAt).toISOString()).toBe(createdAt);

    // The keyset cursor has to survive `decodeSearchCursor`, or page two
    // silently re-serves page one.
    expect(page.nextCursor).not.toBeNull();
    expect(decodeSearchCursor(page.nextCursor as string)).not.toBeNull();
    const next = await search.search({
      q: TERM,
      limit: 1,
      prefix: false,
      cursor: page.nextCursor as string,
    });
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
  });
});
