// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `purgeActors` deletes two tables per chunk, and the pair has to be atomic.
//
// As two independent statements, a transient failure on the second left the authenticity
// SCORE behind for owners whose behaviour windows had already gone.  That residue does not
// heal on the next pass: the retention sweep removes an owner's expired attention
// aggregates BEFORE calling this, and `listIdentifiableOwners()` discovers work only from
// the aggregates that remain — so an owner with none left never reappears, and an
// attention-derived score sits there indefinitely.  That is the exact outcome the
// retention path exists to prevent, reached by a partial success rather than a failure.
//
// Testing it needs the second delete to actually FAIL, which no input can cause.  So the
// suite installs a `BEFORE DELETE` trigger on the scores table for the duration of one
// call: the second statement raises, and the assertion is that the FIRST one did not
// survive it.  Without the transaction the window row is gone and the score remains —
// precisely the split state.
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleActorBehaviorStore } from '../events/drizzle-event-stores.js';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('actor behaviour purge is atomic per chunk', () => {
  let db: ReturnType<typeof createDbClient>;
  let store: DrizzleActorBehaviorStore;
  /** `actor_ref` is a uuid column, so probes are real uuids and cleanup is by id. */
  const probes: string[] = [];
  let ran = false;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    store = new DrizzleActorBehaviorStore(db);
  });

  afterAll(async () => {
    await db.execute(
      sql`DROP TRIGGER IF EXISTS purge_atomicity_probe ON actor_authenticity_scores`,
    );
    await db.execute(sql`DROP FUNCTION IF EXISTS purge_atomicity_probe_fn()`);
    for (const id of probes) {
      await db.execute(sql`DELETE FROM actor_behavior_windows WHERE actor_ref = ${id}::uuid`);
      await db.execute(sql`DELETE FROM actor_authenticity_scores WHERE actor_ref = ${id}::uuid`);
      await db.execute(sql`DELETE FROM users WHERE user_id = ${id}::uuid`);
    }
    await db.$client.end();
  });

  /** A real `users` row (both tables FK to it), then one window and one score through
   *  the store's own writers — so the fixture cannot drift from the schema. */
  async function seed(): Promise<string> {
    const actorRef = randomUUID();
    probes.push(actorRef);
    await db.execute(sql`
      insert into users (user_id, handle, display_name, privacy_settings, personalization_settings)
      values (${actorRef}, ${`purge_${actorRef.slice(0, 8)}`}, 'Purge probe',
              '{}'::jsonb, '{}'::jsonb)`);
    await store.upsertWindows([
      {
        actorRef,
        windowStart: new Date(Date.now() - 3_600_000).toISOString(),
        eventCount: 3,
        itemsTouched: 2,
        dwellHistogram: {},
        replyDepthHistogram: {},
        returnHistogram: {},
        sourceOpens: 0,
        contextOpens: 0,
        saves: 0,
        contributions: 0,
      },
    ]);
    await store.upsertAuthenticity([
      {
        actorRef,
        score: 0.5,
        coherence: 0.5,
        components: {},
        flags: [],
        evidence: 1,
        clusterId: null,
        clusterSize: 1,
        computedAt: new Date().toISOString(),
      },
    ]);
    return actorRef;
  }

  const countRows = async (actorRef: string): Promise<{ windows: number; scores: number }> => {
    const rows = (await db.execute(sql`
      SELECT (SELECT count(*) FROM actor_behavior_windows WHERE actor_ref = ${actorRef}::uuid)::int AS w,
             (SELECT count(*) FROM actor_authenticity_scores WHERE actor_ref = ${actorRef}::uuid)::int AS s
    `)) as unknown as Array<{ w: number; s: number }>;
    return { windows: rows[0]?.w ?? -1, scores: rows[0]?.s ?? -1 };
  };

  it('removes both tables together on the ordinary path', async () => {
    ran = true;
    const actorRef = await seed();
    expect(await countRows(actorRef)).toEqual({ windows: 1, scores: 1 });

    const removed = await store.purgeActors([actorRef]);
    expect(removed).toBe(2);
    expect(await countRows(actorRef)).toEqual({ windows: 0, scores: 0 });
  });

  it('ROLLS BACK the window delete when the score delete fails', async () => {
    ran = true;
    const actorRef = await seed();

    // Make the SECOND statement fail, which no input can do on its own.
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION purge_atomicity_probe_fn() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'purge atomicity probe'; END;
      $$ LANGUAGE plpgsql`);
    await db.execute(sql`
      CREATE TRIGGER purge_atomicity_probe BEFORE DELETE ON actor_authenticity_scores
      FOR EACH ROW EXECUTE FUNCTION purge_atomicity_probe_fn()`);
    try {
      await expect(store.purgeActors([actorRef])).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER purge_atomicity_probe ON actor_authenticity_scores`);
    }

    // BOTH rows survive.  Without the transaction the window would be gone and the score
    // would remain — an attention-derived score with no owner left to rediscover it.
    expect(await countRows(actorRef)).toEqual({ windows: 1, scores: 1 });
  });

  it('actually ran the gated legs (a skipped leg proves nothing)', () => {
    expect(ran).toBe(true);
  });
});
