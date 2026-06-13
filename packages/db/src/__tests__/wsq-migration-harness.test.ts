// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.6.1 — end-to-end migration validation harness (gated; Postgres).
//
// Seeds a realistic PRE-WS-Q dataset (public/restricted/expert_led rooms;
// thread-roomed, room-less, and near-duplicate public stories), runs the full
// WS-Q chain (0014–0020 + the Commons seed) on it, and asserts the global
// safety property: the (item, viewer) read/distribute set never grows and never
// shrinks for a publicly-visible item. Concretely —
//   • every formerly-global story stays global IFF its mapped room is public;
//   • every restricted/expert_led room becomes `private`; its stories become
//     `room_only`;
//   • no story is room-less (all backfilled to a thread room or the Commons);
//   • the public near-dup cluster survives (tier-scoped indexes constrain
//     EXACT canonical-URL per tier, never near-dups);
//   • re-running the backfill (and the Commons seed) is a no-op (idempotent).
//
// Isolation: the other gated suites share the live `public` schema, so this
// harness runs the chain in a FRESH throwaway database (created/dropped here)
// — the migrations run verbatim (no SQL rewriting) and nothing collides.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env['DATABASE_URL'];
const COMMONS = 'c0000000-0000-4000-8000-000000000000';
/** Journal idx 0–13 are pre-WS-Q; 14–20 are the WS-Q chain. */
const WSQ_BOUNDARY = 14;

interface JournalEntry {
  idx: number;
  tag: string;
}

async function migrationTags(): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: JournalEntry[] };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

async function readStatements(tag: string): Promise<string[]> {
  const text = await readFile(new URL(`../../drizzle/${tag}.sql`, import.meta.url), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(!DB_URL)('WS-Q.6.1 migration validation harness', () => {
  let root: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  const dbName = `licio_wsq_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  // Seeded ids (captured for the post-migration assertions).
  const roomPublic = randomUUID();
  const roomRestricted = randomUUID();
  const roomExpert = randomUUID();
  const storyInPublic = randomUUID();
  const storyInRestricted = randomUUID();
  const storyInExpert = randomUUID();
  const storyRoomless = randomUUID();
  const storyNearA = randomUUID();
  const storyNearB = randomUUID();

  beforeAll(async () => {
    root = postgres(DB_URL as string, { max: 1 });
    // CREATE DATABASE runs in autocommit (single unsafe statement, no txn).
    await root.unsafe(`CREATE DATABASE "${dbName}"`);
    const url = new URL(DB_URL as string);
    url.pathname = `/${dbName}`;
    client = postgres(url.toString(), { max: 1 });

    const tags = await migrationTags();

    // --- Phase 1: the pre-WS-Q schema (idx 0–13) -----------------------------
    for (const tag of tags.slice(0, WSQ_BOUNDARY)) {
      for (const stmt of await readStatements(tag)) await client.unsafe(stmt);
    }

    // --- Seed a realistic pre-WS-Q dataset -----------------------------------
    const userId = randomUUID();
    await client.unsafe(
      `INSERT INTO users (user_id, handle, display_name, privacy_settings, personalization_settings, reputation_summary_private)
       VALUES ('${userId}', 'harness_${userId.slice(0, 8)}', 'Harness', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
    );
    // Rooms in the LEGACY three-value visibility (no axes columns yet).
    await client.unsafe(
      `INSERT INTO rooms (room_id, name, slug, room_type, visibility) VALUES
        ('${roomPublic}', 'Public Room', 'pub-${roomPublic.slice(0, 8)}', 'global_topic', 'public'),
        ('${roomRestricted}', 'Restricted Room', 'res-${roomRestricted.slice(0, 8)}', 'global_topic', 'restricted'),
        ('${roomExpert}', 'Expert Room', 'exp-${roomExpert.slice(0, 8)}', 'learning', 'expert_led')`,
    );
    const meta = `'{"submission_type":"original_brief","body":"seed"}'::jsonb`;
    const topics = `ARRAY['${randomUUID()}']::uuid[]`;
    const story = (id: string, url: string | null, title: string) =>
      `('${id}', ${url === null ? 'NULL' : `'${url}'`}, '${title}', 'h-${id.slice(0, 8)}', '${userId}', ${topics}, 'original_brief', ${meta})`;
    await client.unsafe(
      `INSERT INTO stories (story_id, canonical_url, title, title_hash, submitted_by, topic_ids, submission_type, submission_metadata) VALUES
        ${story(storyInPublic, 'https://ex.com/pub', 'In public room')},
        ${story(storyInRestricted, null, 'In restricted room')},
        ${story(storyInExpert, null, 'In expert room')},
        ${story(storyRoomless, null, 'Room-less story')},
        ${story(storyNearA, 'https://ex.com/near-a', 'Near dup A')},
        ${story(storyNearB, 'https://ex.com/near-b', 'Near dup B')}`,
    );
    // Threads pin each story to a room (branch 0); the room-less story's thread
    // carries a NULL room (⇒ the backfill targets the Commons). Near-dups live
    // in the public room.
    const thread = (story: string, room: string | null) =>
      `('${randomUUID()}', '${story}', ${room === null ? 'NULL' : `'${room}'`}, 0)`;
    await client.unsafe(
      `INSERT INTO threads (thread_id, story_id, room_id, branch_index) VALUES
        ${thread(storyInPublic, roomPublic)},
        ${thread(storyInRestricted, roomRestricted)},
        ${thread(storyInExpert, roomExpert)},
        ${thread(storyRoomless, null)},
        ${thread(storyNearA, roomPublic)},
        ${thread(storyNearB, roomPublic)}`,
    );

    // --- Phase 2: the WS-Q chain (idx 14–20) ---------------------------------
    for (const tag of tags.slice(WSQ_BOUNDARY)) {
      for (const stmt of await readStatements(tag)) await client.unsafe(stmt);
    }
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    if (root) {
      await root.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await root.end({ timeout: 5 });
    }
  });

  const visOf = async (table: 'rooms' | 'stories', id: string): Promise<string> => {
    const col = table === 'rooms' ? 'room_id' : 'story_id';
    const rows = await client.unsafe(`SELECT visibility FROM ${table} WHERE ${col} = '${id}'`);
    return (rows[0] as unknown as { visibility: string } | undefined)?.visibility ?? 'MISSING';
  };

  it('seeds the Commons room idempotently', async () => {
    const rows = await client.unsafe(
      `SELECT count(*)::int AS n FROM rooms WHERE room_id = '${COMMONS}'`,
    );
    expect((rows[0] as unknown as { n: number }).n).toBe(1);
  });

  it('collapses legacy visibility to binary and derives the orthogonal axes', async () => {
    expect(await visOf('rooms', roomPublic)).toBe('public');
    expect(await visOf('rooms', roomRestricted)).toBe('private');
    expect(await visOf('rooms', roomExpert)).toBe('private');
    const exp = await client.unsafe(
      `SELECT join_model, posting_policy FROM rooms WHERE room_id = '${roomExpert}'`,
    );
    expect(exp[0]).toMatchObject({
      join_model: 'request_approval',
      posting_policy: 'experts_and_stewards',
    });
    const res = await client.unsafe(
      `SELECT join_model, posting_policy FROM rooms WHERE room_id = '${roomRestricted}'`,
    );
    expect(res[0]).toMatchObject({ join_model: 'request_approval', posting_policy: 'all_members' });
  });

  it('gives every story a home room (none room-less)', async () => {
    const rows = await client.unsafe(
      `SELECT count(*)::int AS n FROM stories WHERE room_id IS NULL`,
    );
    expect((rows[0] as unknown as { n: number }).n).toBe(0);
    const roomless = await client.unsafe(
      `SELECT room_id FROM stories WHERE story_id = '${storyRoomless}'`,
    );
    expect((roomless[0] as unknown as { room_id: string }).room_id).toBe(COMMONS);
  });

  it('forces room_only for private-room stories and keeps public-room stories public', async () => {
    expect(await visOf('stories', storyInPublic)).toBe('public');
    expect(await visOf('stories', storyInRestricted)).toBe('room_only');
    expect(await visOf('stories', storyInExpert)).toBe('room_only');
    expect(await visOf('stories', storyRoomless)).toBe('public'); // Commons is public
  });

  it('preserves the public near-duplicate cluster (tier indexes constrain only exact URL)', async () => {
    const rows = await client.unsafe(
      `SELECT story_id, visibility FROM stories WHERE story_id IN ('${storyNearA}', '${storyNearB}')`,
    );
    expect(rows.length).toBe(2);
    expect(
      rows.every((r) => (r as unknown as { visibility: string }).visibility === 'public'),
    ).toBe(true);
  });

  it('holds the MONOTONIC-visibility property (public iff the home room is public)', async () => {
    const rows = await client.unsafe(
      `SELECT count(*)::int AS n FROM stories s JOIN rooms r ON s.room_id = r.room_id
       WHERE (s.visibility = 'public') <> (r.visibility = 'public')`,
    );
    expect((rows[0] as unknown as { n: number }).n).toBe(0);
  });

  it('is idempotent: re-running the backfill + Commons seed changes nothing', async () => {
    const snapshot = async () =>
      client.unsafe(`SELECT story_id, room_id, visibility FROM stories ORDER BY story_id`);
    const before = await snapshot();
    // Re-run the (idempotent) backfill migration + the Commons seed.
    for (const stmt of await readStatements('0016_ws_q_stories_backfill'))
      await client.unsafe(stmt);
    await client.unsafe(
      `INSERT INTO rooms (room_id, name, slug, room_type, visibility, join_model, posting_policy)
       VALUES ('${COMMONS}', 'Commons', 'commons', 'global_topic', 'public', 'open', 'all_members')
       ON CONFLICT (room_id) DO NOTHING`,
    );
    const after = await snapshot();
    expect(after).toEqual(before);
    const commons = await client.unsafe(
      `SELECT count(*)::int AS n FROM rooms WHERE room_id = '${COMMONS}'`,
    );
    expect((commons[0] as unknown as { n: number }).n).toBe(1);
  });
});
