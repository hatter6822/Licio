// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gated integration test (DATABASE_URL) for migration 0110 — a PUBLIC story
// cannot live in a PRIVATE room.
//
// This is a DATABASE guarantee and belongs where the database runs.  The
// invariant was previously maintained by the room-visibility cascade alone,
// which structurally cannot hold it: every read happens before the room flip, so
// a story that becomes public in between was never revisited.  Two writer paths
// reach that window and both read the room long before they write the story — a
// fresh submission whose `deriveStoryVisibility` saw the room still public, and
// an author widen that reads the room and then awaits two more queries.
//
// The leftover row is not cosmetic: the Gate-19 public re-publisher derives
// eligibility from room STORAGE MODE plus story visibility and never reads room
// visibility, so a public story left in a private room is publishable to the
// public IPFS DHT.
//
// The in-memory story store cannot emulate this one (unlike the tier uniques it
// does emulate) because the rule spans two tables and that store holds no rooms
// — so this suite is the only place the two triggers are exercised.  Both
// directions are asserted, plus the three shapes that must still be ALLOWED, so
// a trigger that simply refused everything would fail here too.
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCheckViolation } from '../../lib/pg-errors.js';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('private-room story visibility (live Postgres, migration 0110)', () => {
  let db: ReturnType<typeof createDbClient>;
  let userId: string;
  let topicId: string;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    // The stories FK needs a real submitter and a non-empty topic set
    // (`stories_topics_nonempty`); reuse whatever the migrated schema has rather
    // than minting identity rows this test does not care about.
    const users = await db.execute<{ user_id: string }>(sql`select user_id from users limit 1`);
    const first = users[0];
    if (!first) throw new Error('no user row available for the stories FK');
    userId = first.user_id;
    topicId = randomUUID();
  });

  afterAll(async () => {
    await db.$client.end();
  });

  // Written as raw statements on purpose: these assert what POSTGRES does, so
  // going through the query builder would add a layer whose typing could mask
  // which column the trigger actually objected to.
  async function makeRoom(visibility: 'public' | 'private'): Promise<string> {
    const roomId = randomUUID();
    await db.execute(sql`
      insert into rooms (room_id, slug, name, room_type, visibility, join_model)
      values (${roomId}, ${`vis-${roomId.slice(0, 8)}`}, ${`Visibility trigger ${roomId.slice(0, 8)}`},
              'global_topic', ${visibility},
              ${visibility === 'private' ? 'invite' : 'open'})
    `);
    return roomId;
  }

  async function makeStory(roomId: string, visibility: 'public' | 'room_only'): Promise<string> {
    const storyId = randomUUID();
    await db.execute(sql`
      insert into stories
        (story_id, room_id, title, title_hash, submitted_by, submission_type, visibility,
         topic_ids, submission_metadata)
      values (${storyId}, ${roomId}, 'Trigger fixture', ${randomUUID()}, ${userId},
              'original_brief', ${visibility}, ${sql`array[${topicId}]::uuid[]`}, '{}')
    `);
    return storyId;
  }

  /**
   * Assert the write was REFUSED by a check/trigger, and that the refusal names
   * the expected reason.
   *
   * Through `isCheckViolation` rather than `rejects.toThrow(/…/)`, because
   * Drizzle wraps the driver error (`DrizzleQueryError` → `cause: PostgresError`)
   * and the wrapper's own message is just "Failed query" — a regex against it
   * matches nothing, which is precisely the trap `lib/pg-errors.ts` exists to
   * close.  So this exercises the helper production actually branches on, not a
   * message the production code never reads.
   */
  async function expectRefused(write: Promise<unknown>, reason: RegExp): Promise<void> {
    let caught: unknown;
    try {
      await write;
    } catch (error) {
      caught = error;
    }
    expect(caught, 'the write should have been refused').toBeDefined();
    expect(isCheckViolation(caught), 'refusal should be a 23514 check violation').toBe(true);
    // The reason travels on the cause chain, where the trigger put it.
    let messages = '';
    for (let link: unknown = caught, depth = 0; link != null && depth < 4; depth += 1) {
      messages += ` ${String((link as { message?: unknown }).message ?? '')}`;
      link = (link as { cause?: unknown }).cause;
    }
    expect(messages).toMatch(reason);
  }

  const setRoom = (roomId: string, visibility: 'public' | 'private') =>
    db.execute(sql`update rooms set visibility = ${visibility} where room_id = ${roomId}`);
  const setStory = (storyId: string, visibility: 'public' | 'room_only') =>
    db.execute(sql`update stories set visibility = ${visibility} where story_id = ${storyId}`);

  it('REFUSES a public story written into a private room', async () => {
    const roomId = await makeRoom('private');
    await expectRefused(makeStory(roomId, 'public'), /cannot be public/);
  });

  it('REFUSES widening a story whose room went private under it', async () => {
    // The author-widen race: the pre-check read a public room, the cascade landed,
    // and the write then left the story public in a private room.
    const roomId = await makeRoom('public');
    const storyId = await makeStory(roomId, 'room_only');
    await setRoom(roomId, 'private');
    await expectRefused(setStory(storyId, 'public'), /cannot be public/);
  });

  it('REFUSES taking a room private while a public story remains', async () => {
    // What makes the cascade's own race safe: a straggler that appeared after the
    // last sweep read now fails the FLIP instead of surviving it.
    const roomId = await makeRoom('public');
    await makeStory(roomId, 'public');
    await expectRefused(setRoom(roomId, 'private'), /cannot go private/);
  });

  it('ALLOWS the three legitimate shapes', async () => {
    // A trigger that refused everything would pass the three tests above.
    const publicRoom = await makeRoom('public');
    await expect(makeStory(publicRoom, 'public')).resolves.toBeTruthy();
    const privateRoom = await makeRoom('private');
    await expect(makeStory(privateRoom, 'room_only')).resolves.toBeTruthy();
    // …and the cascade's correct order: contain the story, THEN flip the room.
    const cascadeRoom = await makeRoom('public');
    const storyId = await makeStory(cascadeRoom, 'public');
    await setStory(storyId, 'room_only');
    await expect(setRoom(cascadeRoom, 'private')).resolves.toBeTruthy();
  });
});
