// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q — migration 0119 finishes what 0110 could not.
//
// 0110 converts public stories in private rooms to `room_only`, and skips one case: a
// story sharing a canonical URL with an in-room `room_only` twin, where the conversion
// would land in an occupied `(canonical_url, room_id)` slot and raise 23505.  It reported
// a count and moved on.
//
// That count was a live leak, not a note.  The Gate-19 public re-publisher derives
// eligibility from room storage mode plus story visibility and never reads room
// visibility, so a public story left in a private room is publishable to the public IPFS
// DHT — the exact condition 0110 exists to prevent, surviving on the installations that
// had it.
//
// This suite reconstructs the collision the migration could not resolve and asserts the
// repair handles it.  Reconstructing it requires disabling the 0110 trigger, which is
// itself the point: the ONLY way to produce the row now is to bypass the enforcement,
// which is exactly how the historical rows came to exist (they predate it).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env['DATABASE_URL'];

/** The repair UPDATE, lifted from migration 0119 itself. */
function repairStatement(): string {
  const file = join(migrationsFolder(), '0119_story_hidden_state_superseded.sql');
  const statement = readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .find((part) => /^UPDATE\s+"stories"/im.test(part.replace(/^--.*$/gm, '').trim()));
  if (statement === undefined) {
    // The migration no longer contains a repair.  That is a finding, not a skip: the
    // rows it exists for are publishable to the public IPFS DHT.
    throw new Error('migration 0119 contains no `UPDATE "stories"` repair statement');
  }
  // Strip the leading comment block so `sql.raw` receives the statement alone.
  return statement.replace(/^(--.*\n)+/, '');
}

describe.skipIf(!DB_URL)('WS-Q private-room story repair (migration 0119)', () => {
  let db: ReturnType<typeof createDbClient>;
  let roomId: string;
  let userId: string;
  let url: string;
  let ran = false;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    roomId = randomUUID();
    userId = randomUUID();
    url = `https://example.invalid/ws-q-repair/${roomId.slice(0, 8)}`;
    await db.execute(sql`
      insert into users (user_id, handle, display_name, privacy_settings, personalization_settings)
      values (${userId}, ${`wsq_${userId.slice(0, 8)}`}, 'WS-Q repair submitter',
              '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`
      insert into rooms (room_id, slug, name, room_type, visibility, join_model)
      values (${roomId}, ${`wsq-${roomId.slice(0, 8)}`},
              ${`WS-Q repair ${roomId.slice(0, 8)}`}, 'global_topic', 'private', 'invite')`);
  });

  afterAll(async () => {
    await db.execute(sql`delete from stories where room_id = ${roomId}::uuid`);
    await db.execute(sql`delete from rooms where room_id = ${roomId}::uuid`);
    await db.execute(sql`delete from users where user_id = ${userId}::uuid`);
    await db.$client.end();
  });

  it('converts a stranded duplicate by hiding it as `superseded`', async () => {
    ran = true;
    // The in-room twin that already holds the URL — the row whose presence blocks the
    // conversion.
    const twinId = randomUUID();
    await db.execute(sql`
      insert into stories (story_id, room_id, submitted_by, title, title_hash, canonical_url,
                           topic_ids, submission_type, submission_metadata, visibility)
      values (${twinId}, ${roomId}::uuid, ${userId}::uuid, 'twin', 'twin-hash', ${url},
              array[gen_random_uuid()], 'link', '{}'::jsonb, 'room_only')`);

    // The stranded row.  The 0110 trigger refuses it, so producing it means turning the
    // trigger off — which is precisely what makes these rows HISTORICAL: they exist only
    // where they predate the enforcement.
    const strandedId = randomUUID();
    // ONE TRANSACTION: `session_replication_role` is a SESSION setting and the pool
    // hands each statement whichever connection is free, so the `SET` and the deletes
    // it covers can land on different connections and the append-only trigger fires
    // anyway.  `SET LOCAL` is scoped to the transaction, i.e. to one connection.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`
      insert into stories (story_id, room_id, submitted_by, title, title_hash, canonical_url,
                           topic_ids, submission_type, submission_metadata, visibility)
      values (${strandedId}, ${roomId}::uuid, ${userId}::uuid, 'stranded', 'stranded-hash', ${url},
              array[gen_random_uuid()], 'link', '{}'::jsonb, 'public')`);
    });

    // 0110's own backfill predicate SKIPS this row: the twin occupies the destination.
    const skipped = (await db.execute(sql`
      SELECT count(*)::int AS n FROM stories s
       WHERE s.story_id = ${strandedId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM stories t
            WHERE t.room_id = s.room_id AND t.canonical_url = s.canonical_url
              AND t.visibility = 'room_only' AND t.hidden_state IS NULL
              AND t.story_id <> s.story_id)`)) as unknown as Array<{ n: number }>;
    expect(skipped[0]?.n).toBe(0); // i.e. 0110 could not convert it

    // THE MIGRATION'S OWN STATEMENT, read out of the file and executed — not a copy of
    // it.  A hand-transcribed copy tests the transcription: it keeps passing after the
    // migration is edited, or after the repair is dropped from it entirely.
    await db.execute(sql.raw(repairStatement()));

    const rows = (await db.execute(sql`
      SELECT story_id::text AS id, visibility::text AS v, hidden_state::text AS h
        FROM stories WHERE room_id = ${roomId}::uuid ORDER BY title`)) as unknown as Array<{
      id: string;
      v: string;
      h: string | null;
    }>;
    const stranded = rows.find((r) => r.id === strandedId);
    const twin = rows.find((r) => r.id === twinId);

    // Repaired: no longer public, and hidden for a reason that is TRUE.
    expect(stranded?.v).toBe('room_only');
    expect(stranded?.h).toBe('superseded');
    // The twin is untouched and still serves the URL in-room — nothing was deleted.
    expect(twin?.v).toBe('room_only');
    expect(twin?.h).toBeNull();
  });

  it('leaves NO public story in a private room, which is the whole invariant', async () => {
    ran = true;
    const remaining = (await db.execute(sql`
      SELECT count(*)::int AS n FROM stories s
       WHERE s.visibility = 'public'
         AND s.room_id IN (SELECT room_id FROM rooms WHERE visibility = 'private')`)) as unknown as Array<{
      n: number;
    }>;
    // 0119 RAISEs on this condition rather than reporting it, so a non-zero count here
    // would also have halted the migration chain.
    expect(remaining[0]?.n).toBe(0);
  });

  it('actually ran the gated legs (a skipped leg proves nothing)', () => {
    expect(ran).toBe(true);
  });
});
