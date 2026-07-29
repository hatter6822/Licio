// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres pins for the room-directory `q` search.  `GET /v1/rooms`
// is anonymous and `q` is up to 200 chars, so the LIKE pattern it builds is
// caller-shaped text: escaping `%`/`_` but NOT the escape character itself let
// a supplied `\` pair with an injected one and re-arm the metacharacter after
// it.  The directory branch and the `joined=true` branch of `routes/rooms.ts`
// filter through DIFFERENT engines (this store vs. `roomMatchesQuery`'s plain
// `String.includes`), so these also assert the two agree — a wildcard that
// only one of them honours is a split-brain directory.
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_ci pnpm test
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleRoomStore } from '../drizzle-forum-stores.js';
import { roomMatchesQuery } from '../rooms.js';
import type { RoomRecord } from '../stores.js';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('DrizzleRoomStore.list `q` is a LITERAL substring search', () => {
  let db: ReturnType<typeof createDbClient>;
  let rooms: DrizzleRoomStore;
  let authorId: string;
  const roomIds: string[] = [];
  /** The seeded rooms, for the store↔`roomMatchesQuery` symmetry assertion. */
  const seeded: RoomRecord[] = [];

  /** Names/descriptions carrying every LIKE metacharacter, incl. the escape. */
  const NAMES = ['my\\secret room', '100% cotton room', 'snake_case room'] as const;
  /**
   * A run-unique token every fixture carries.
   *
   * `rooms.list` is a LIMIT-bounded query over the WHOLE shared table ordered
   * by `created_at ASC`, and these fixtures are the newest rows in it — so a
   * probe matching more rooms than the limit returns a page that cannot contain
   * them, and the assertion fails for a reason that has nothing to do with LIKE
   * escaping.  The plain-substring probe used to be the literal word "room",
   * which 220 rooms in the live database now match.  Every probe below is
   * therefore scoped to this token, which only these three rows carry.
   */
  const TAG = `wsglike${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    const { users } = await import('@licio/db');
    const inserted = await db
      .insert(users)
      .values({
        handle: `wsg_like_${randomUUID().slice(0, 8)}`,
        displayName: 'WS-G like-escape',
        email: null,
        ageBandIfKnown: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
      })
      .returning();
    authorId = (inserted[0] as { userId: string }).userId;
    rooms = new DrizzleRoomStore(db);
    for (const name of NAMES) {
      const suffix = randomUUID().slice(0, 8);
      const outcome = await rooms.insert({
        roomId: randomUUID(),
        name: `${name} ${TAG} ${suffix}`,
        slug: `wsg-like-${suffix}`,
        description: 'Escape-character fixture.',
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
      });
      if (!outcome.ok) throw new Error(`fixture room insert failed: ${outcome.reason}`);
      roomIds.push(outcome.room.roomId);
      seeded.push(outcome.room);
    }
  });

  afterAll(async () => {
    // ROW-SCOPED cleanup: vitest projects run in parallel against the SAME
    // live database, so a blanket clear() would race the other gated suites.
    const dbSchema = await import('@licio/db');
    const { inArray } = await import('drizzle-orm');
    if (roomIds.length > 0) {
      await db.delete(dbSchema.rooms).where(inArray(dbSchema.rooms.roomId, roomIds));
    }
    await db.delete(dbSchema.users).where(inArray(dbSchema.users.userId, [authorId]));
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  it('never lets a caller-supplied backslash re-arm the next metacharacter', async () => {
    // `\%room` used to build `%\\%room%` — "any text, a literal backslash, ANY
    // text, 'room'" — which the `my\secret room` fixture satisfies.
    expect(await rooms.list({ query: '\\%room', limit: 10 })).toEqual([]);
    expect(await rooms.list({ query: '\\_ecret', limit: 10 })).toEqual([]);
    // The literal reading of those inputs still finds nothing, and the literal
    // reading of the text that IS there still finds the room.
    const literal = await rooms.list({ query: 'my\\secret', limit: 10 });
    expect(literal.map((r) => r.roomId)).toEqual([roomIds[0]]);
  });

  it('treats % and _ as literals, not wildcards', async () => {
    expect((await rooms.list({ query: '100% cotton', limit: 10 })).map((r) => r.roomId)).toEqual([
      roomIds[1],
    ]);
    expect((await rooms.list({ query: 'snake_case', limit: 10 })).map((r) => r.roomId)).toEqual([
      roomIds[2],
    ]);
    // `%` and `_` as wildcards would match every fixture; as literals, neither
    // of these appears in any of the three names.
    expect(await rooms.list({ query: 'snake%case', limit: 10 })).toEqual([]);
    expect(await rooms.list({ query: '100_ cotton', limit: 10 })).toEqual([]);
  });

  it('agrees with roomMatchesQuery on every metacharacter query', async () => {
    // The `joined=true` branch of routes/rooms.ts filters the requester's own
    // memberships through `roomMatchesQuery` instead of the store; the two must
    // return the same verdict or the directory splits by membership.
    const probes = [
      `\\%${TAG}`,
      '\\_ecret',
      'my\\secret',
      '100% cotton',
      'snake_case',
      'snake%case',
      '100_ cotton',
      // The plain-substring probe: a token only these fixtures carry, so the
      // result cannot be crowded out of the store's LIMIT by unrelated rows.
      TAG,
      '%',
      '_',
      '\\',
    ];
    for (const q of probes) {
      const fromStore = new Set((await rooms.list({ query: q, limit: 50 })).map((r) => r.roomId));
      const fromPredicate = new Set(
        seeded.filter((room) => roomMatchesQuery(room, q)).map((r) => r.roomId),
      );
      // The store sees the whole table, so compare only over OUR fixtures.
      const scoped = new Set([...fromStore].filter((id) => roomIds.includes(id)));
      expect(scoped, `q=${JSON.stringify(q)}`).toEqual(fromPredicate);
    }
  });
});
