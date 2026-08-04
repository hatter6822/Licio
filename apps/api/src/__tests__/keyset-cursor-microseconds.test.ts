// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE MICROSECOND HAZARD, across every `(timestamp, id)` keyset cursor that survives it.
//
// These cursors all had the same defect, and none of it is visible in TypeScript:
// `timestamptz` is MICROSECOND resolution, the driver returns a millisecond JS `Date`,
// and so a cursor encoded from a row names an instant strictly BEFORE that row.  What
// the strict comparison then does depends only on the direction:
//
//   DESC — rows sharing the cursor's millisecond with fewer microseconds are excluded.
//          Silently DROPPED, with a `next_cursor` that looks like it worked.
//   ASC  — those same rows are re-included.  DUPLICATED; and if a whole page shares one
//          millisecond the cursor cannot advance past it and the walk never terminates.
//
// The id tiebreaker in each of these cursors did not help and could not: it is only
// consulted once the timestamps compare EQUAL, which a rounded cursor never does against
// the value it came from.
//
// So the fixture writes timestamps EXPLICITLY, 137µs apart — several rows per
// millisecond, each at a distinct sub-millisecond position.  Left to `now()` this would
// be a race against how fast the machine inserts, and on a fast one every row lands in
// its own millisecond and the whole suite passes without testing anything.
//
// Postgres-only by nature: the in-memory adapters take their timestamps from
// `Date.now()`, so they have no sub-millisecond to lose and cannot reproduce this.  That
// asymmetry is why the bug survived — the defect lived only in the adapter no unit test
// exercises.
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleStoryStore } from '../ingestion/drizzle-ingestion-stores.js';
import { DrizzleGovernanceAuditStore } from '../knomosis/drizzle-knomosis-stores.js';
import {
  DrizzleCoordinatedReportIncidentStore,
  DrizzleEvidenceDecisionStore,
} from '../moderation/drizzle-moderation-stores.js';

const DB_URL = process.env['DATABASE_URL'];

const ROWS = 40;
const PAGE = 7;
/** Sub-millisecond spacing: ~7 rows share each millisecond, all distinguishable only by
 *  the microseconds the cursor cannot carry. */
const STEP_US = 137;

describe.skipIf(!DB_URL)('keyset cursors under sub-millisecond timestamps', () => {
  let db: ReturnType<typeof createDbClient>;
  let roomId: string;
  let ran = false;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    roomId = randomUUID();
    await db.execute(sql`
      insert into rooms (room_id, slug, name, room_type, visibility, join_model)
      values (${roomId}, ${`ks-${roomId.slice(0, 8)}`},
              ${`Keyset cursor room ${roomId.slice(0, 8)}`},
              'global_topic', 'public', 'open')`);
  });

  afterAll(async () => {
    // `governance_audit_log` is append-only behind a `BEFORE DELETE` trigger, so the
    // seed comes out with row-level triggers disabled for this session.  Without it the
    // first DELETE throws and every later cleanup statement — including the room — is
    // skipped, leaking a fixture that then collides with the next run's unique name.
    // ONE TRANSACTION: `session_replication_role` is a SESSION setting and the pool
    // hands each statement whichever connection is free, so the `SET` and the deletes
    // it covers can land on different connections and the append-only trigger fires
    // anyway.  `SET LOCAL` is scoped to the transaction, i.e. to one connection.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`delete from knomosis.governance_audit_log where room_id = ${roomId}`);
      await tx.execute(sql`delete from threads where room_id = ${roomId}`);
      await tx.execute(sql`delete from stories where room_id = ${roomId}`);
      await tx.execute(sql`delete from users where handle like 'ks\\_%'`);
      await tx.execute(sql`delete from rooms where room_id = ${roomId}`);
      await tx.execute(
        sql`delete from coordinated_report_incidents where summary like 'keyset-microsecond%'`,
      );
      await tx.execute(
        sql`delete from evidence_decisions where reason_code like 'keyset-microsecond%'`,
      );
    });
    await db.$client.end();
  });

  it('the integrity incident queue (ASC) reaches the end, once per row', async () => {
    ran = true;
    // Rows are generated IN Postgres and identified by a per-run tag.  Passing a JS
    // array instead would reach the server as a record — Drizzle interpolates it
    // positionally, and `record::text[]` is not a cast Postgres has.
    const tag = `keyset-microsecond-${randomUUID().slice(0, 8)}`;
    await db.execute(sql`
      INSERT INTO coordinated_report_incidents
        (target_type, target_id, report_count, window_seconds, coordination_score,
         severity, status, summary, created_at)
      SELECT 'content', gen_random_uuid(), 3, 600, 0.5, 'severe', 'open',
             ${tag} || ' ' || n,
             timestamptz '2026-02-01 00:00:00+00' + (n * ${STEP_US}) * interval '1 microsecond'
        FROM generate_series(1, ${ROWS}) AS n`);

    const store = new DrizzleCoordinatedReportIncidentStore(db);
    const seen: string[] = [];
    let after: { createdAt: string; incidentId: string } | undefined;
    // Bounded: an ASC cursor that fails to advance would otherwise hang the suite
    // rather than fail it, which is how this class of bug reaches production.
    for (let page = 0; page < ROWS + 5; page++) {
      const batch = await store.listOpen(PAGE, after);
      seen.push(...batch.filter((r) => r.summary.startsWith(tag)).map((r) => r.incidentId));
      const last = batch.at(-1);
      if (batch.length < PAGE || !last) break;
      after = { createdAt: last.createdAt, incidentId: last.incidentId };
    }

    expect(new Set(seen).size).toBe(ROWS); // every incident reached
    expect(seen).toHaveLength(ROWS); // and none served twice
  });

  it('the governance audit log (DESC) loses nothing between pages', async () => {
    ran = true;
    // The room is created per run, so every entry in it belongs to this test.
    await db.execute(sql`
      INSERT INTO knomosis.governance_audit_log
        (entry_id, room_id, action_type, action_details, simulation_mode, created_at)
      SELECT gen_random_uuid(), ${roomId}::uuid, 'room_created', '{}'::jsonb, false,
             timestamptz '2026-02-01 00:00:00+00' + (n * ${STEP_US}) * interval '1 microsecond'
        FROM generate_series(1, ${ROWS}) AS n`);

    const store = new DrizzleGovernanceAuditStore(db);
    const seen: string[] = [];
    let before: { createdAt: string; entryId: string } | undefined;
    for (let page = 0; page < ROWS + 5; page++) {
      const batch = await store.listByRoom(roomId, PAGE, before);
      seen.push(...batch.map((e) => e.entryId));
      const oldest = batch.at(-1);
      if (batch.length < PAGE || !oldest) break;
      before = { createdAt: oldest.createdAt, entryId: oldest.entryId };
    }

    expect(new Set(seen).size).toBe(ROWS);
    expect(seen).toHaveLength(ROWS);
  });

  it('the room-thread page (DESC) loses nothing between pages', async () => {
    ran = true;
    // The SCOI room report walks this cursor, and a short page is how it decides
    // it has reached the end of the room — so a dropped row does not merely
    // vanish, it makes an incomplete scan report itself complete.
    // One story per thread (`threads.story_id` is NOT NULL and cascades), with
    // the thread timestamps written EXPLICITLY so several land per millisecond.
    const submitter = randomUUID();
    // `topic_ids` is a bare uuid[] with a non-empty CHECK and no FK.
    const topicId = randomUUID();
    await db.execute(sql`
      insert into users (user_id, handle, display_name, account_state, roles,
                         privacy_settings, personalization_settings)
      values (${submitter}::uuid, ${`ks_${submitter.replace(/-/g, '').slice(0, 12)}`}, 'Keyset', 'active',
              ARRAY['user']::text[], '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`
      WITH seeded AS (
        INSERT INTO stories
          (story_id, title, title_hash, submitted_by, room_id, visibility, language,
           topic_ids, proposed_topic_ids, sensitivity_labels, lifecycle_state,
           submission_type, submission_metadata, extraction_state)
        SELECT gen_random_uuid(), 'keyset-microsecond',
               'keyset-microsecond-' || n, ${submitter}::uuid, ${roomId}::uuid,
               'public', 'en', ARRAY[${topicId}::uuid], ARRAY[${topicId}::uuid], ARRAY[]::text[],
               'gathering_attention', 'original_brief', '{}'::jsonb, 'pending'
          FROM generate_series(1, ${ROWS}) AS n
        RETURNING story_id, title_hash
      )
      INSERT INTO threads (thread_id, story_id, room_id, branch_index, created_at)
      SELECT gen_random_uuid(), story_id, ${roomId}::uuid, 0,
             timestamptz '2026-03-01 00:00:00+00'
               + (split_part(title_hash, '-', 3)::int * ${STEP_US}) * interval '1 microsecond'
        FROM seeded`);

    const store = new DrizzleStoryStore(db);
    const seen: string[] = [];
    let before: { createdAt: string; threadId: string } | null = null;
    for (let page = 0; page < ROWS + 5; page += 1) {
      const batch = await store.listThreadsByRoom(roomId, before, PAGE);
      seen.push(...batch.map((t) => t.threadId));
      const oldest = batch.at(-1);
      if (batch.length < PAGE || !oldest) break;
      before = { createdAt: oldest.createdAt, threadId: oldest.threadId };
    }

    expect(new Set(seen).size).toBe(ROWS);
    expect(seen).toHaveLength(ROWS);
  });

  it('the evidence-decision feed (DESC) loses nothing between pages', async () => {
    ran = true;
    const tag = `keyset-microsecond-${randomUUID().slice(0, 8)}`;
    await db.execute(sql`
      INSERT INTO evidence_decisions
        (decision_id, contribution_id, thread_id, action, reason_code, created_at)
      SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'clear', ${tag},
             timestamptz '2026-02-01 00:00:00+00' + (n * ${STEP_US}) * interval '1 microsecond'
        FROM generate_series(1, ${ROWS}) AS n`);

    const store = new DrizzleEvidenceDecisionStore(db);
    const seen: string[] = [];
    let after: { createdAt: string; decisionId: string } | null = null;
    for (let page = 0; page < ROWS + 5; page++) {
      const batch = await store.listRecent({ after, limit: PAGE });
      seen.push(...batch.filter((r) => r.reasonCode === tag).map((r) => r.decisionId));
      const last = batch.at(-1);
      if (batch.length < PAGE || !last) break;
      after = { createdAt: last.createdAt, decisionId: last.decisionId };
    }

    expect(new Set(seen).size).toBe(ROWS);
    expect(seen).toHaveLength(ROWS);
  });

  it('actually ran the gated legs (a skipped leg proves nothing)', () => {
    expect(ran).toBe(true);
  });
});
