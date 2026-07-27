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
import { HISTORICAL_EXEMPTIONS, isHistoricallyExempt } from '../identifier-limits.js';

const DB_URL = process.env['DATABASE_URL'];
const COMMONS = 'c0000000-0000-4000-8000-000000000000';
/** Journal idx 0–13 are pre-WS-Q.  Phase 2 applies idx 14 → END (the WS-Q chain
 *  AND everything after it, incl. the WS-Q.* / WS-R / WS-S migrations) over the
 *  seeded pre-WS-Q dataset, so the post-WS-Q CHECKs/triggers (e.g. the §4.1
 *  room-axes coherence constraints + the §8.3 no-p2p-content trigger this suite
 *  exercises) run against real data. */
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

/**
 * A truncation Postgres REPORTED while applying a migration.
 *
 * `NOTICE: identifier "…" will be truncated to "…"` is Postgres's own account
 * of the defect, and it is emitted for every route a name can arrive by — a
 * literal `CREATE`, a name Drizzle derived, and a name built at runtime inside
 * `EXECUTE format(…)`.  Nothing static covers that last one in general, which
 * is why this is the authoritative half of the 63-byte check and
 * `check:sql-identifiers` is the fast pre-check beside it.
 */
interface Truncation {
  readonly tag: string;
  readonly message: string;
}

const TRUNCATION = /identifier .* will be truncated/i;

/** The name Postgres was GIVEN, out of its own truncation notice. */
function intendedName(message: string): string | undefined {
  return /identifier "([^"]+)" will be truncated/i.exec(message)?.[1];
}

describe.skipIf(!DB_URL)('WS-Q.6.1 migration validation harness', () => {
  let root: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  const truncations: Truncation[] = [];
  let applying = '';
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
    client = postgres(url.toString(), {
      max: 1,
      // Postgres tells us when it truncates; the only thing needed is to listen.
      onnotice: (notice) => {
        const message = String(notice['message'] ?? '');
        if (TRUNCATION.test(message)) truncations.push({ tag: applying, message });
      },
    });

    const tags = await migrationTags();

    // --- Phase 1: the pre-WS-Q schema (idx 0–13) -----------------------------
    for (const tag of tags.slice(0, WSQ_BOUNDARY)) {
      applying = tag;
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

    // --- Phase 2: idx 14 → END (the WS-Q chain + every later migration) -------
    for (const tag of tags.slice(WSQ_BOUNDARY)) {
      applying = tag;
      for (const stmt of await readStatements(tag)) await client.unsafe(stmt);
    }
    applying = '';
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

  // POSTGRES ITSELF reports every truncation, naming the identifier it was
  // given and the one it stored.  That is the whole check: it needs no parser,
  // and it covers the three routes a name arrives by — spelled in the SQL,
  // DERIVED by Drizzle, or composed at runtime inside `EXECUTE format(…)`,
  // the last of which nothing static can resolve in general.
  //
  // What this replaces was necessarily indirect: Postgres cannot STORE a name
  // over 63 bytes, so a query for `length > 63` is empty by construction, and
  // the only static evidence was a name of EXACTLY 63 bytes weighed against an
  // allowlist of legitimate ones.  A notice says what happened instead of
  // inferring it from what survived.
  it('applies every migration without Postgres truncating an identifier', () => {
    const unexpected = truncations.filter(
      (each) => !isHistoricallyExempt(intendedName(each.message) ?? '', each.tag),
    );
    expect(
      unexpected.map((each) => `${each.tag}: ${each.message}`),
      'Postgres truncated an identifier while applying the migration chain. Two intended ' +
        'names that agree on their first 63 bytes collapse to one stored name — give the ' +
        'constraint/index an explicit shorter name.',
    ).toEqual([]);
  });

  it('sees every exempted truncation actually happen (no stale entry)', () => {
    // The exemptions describe applied HISTORY, so each one must still be
    // observed.  An entry that stops matching means the migration it excuses
    // has changed, and the excuse should go with it — the same allowlist
    // discipline the static gate keeps.
    const observed = new Set(
      truncations.flatMap((each) => {
        const name = intendedName(each.message);
        return name === undefined ? [] : [name];
      }),
    );
    expect([...HISTORICAL_EXEMPTIONS.keys()].filter((name) => !observed.has(name))).toEqual([]);
  });

  // The renamed constraints must still ENFORCE what they always did — a rename
  // that quietly dropped an ON DELETE action would be worse than the truncation.
  it('keeps every renamed foreign key enforcing its original reference', async () => {
    const rows = await client.unsafe(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN (
          'debate_arenas_challenger_contribution_fk',
          'debate_arenas_target_contribution_fk',
          'steward_governance_vote_election_fk',
          'room_governance_prompt_model_fk',
          'room_agent_binding_prompt_fk')
        ORDER BY conname`,
    );
    const defs = Object.fromEntries(
      rows.map((r) => {
        const row = r as unknown as { conname: string; def: string };
        return [row.conname, row.def];
      }),
    );
    expect(defs['debate_arenas_challenger_contribution_fk']).toBe(
      'FOREIGN KEY (challenger_contribution_id) REFERENCES contributions(contribution_id) ON DELETE CASCADE',
    );
    expect(defs['debate_arenas_target_contribution_fk']).toBe(
      'FOREIGN KEY (target_contribution_id) REFERENCES contributions(contribution_id) ON DELETE CASCADE',
    );
    expect(defs['steward_governance_vote_election_fk']).toBe(
      'FOREIGN KEY (election_id) REFERENCES knomosis.steward_election(election_id) ON DELETE CASCADE',
    );
    expect(defs['room_governance_prompt_model_fk']).toBe(
      'FOREIGN KEY (model_id) REFERENCES knomosis.room_governance_model(model_id) ON DELETE CASCADE',
    );
    // RESTRICT, not CASCADE: a prompt still bound to a room must not be deletable.
    expect(defs['room_agent_binding_prompt_fk']).toBe(
      'FOREIGN KEY (prompt_id) REFERENCES knomosis.room_governance_prompt(prompt_id) ON DELETE RESTRICT',
    );
  });

  // WS-S.1.3b / §8.3 — the database guard (migration 0045): NO server table may
  // accumulate rows for a Private P2P room.  Proves the trigger applied cleanly
  // AND rejects p2p-room rows on EVERY room-referencing table (the content roots
  // `stories`/`threads` + the non-content `room_stewards`/`room_subscriptions`/
  // `lenses`) — the deepest, code-path-independent defense below the
  // service-layer 409/404 guards — while a server room is unaffected.
  it('§8.3 trigger rejects ALL server rows referencing a Private P2P room', async () => {
    const uid = randomUUID();
    // Post-chain schema: 0076 dropped reputation_summary_private.
    await client.unsafe(
      `INSERT INTO users (user_id, handle, display_name, privacy_settings, personalization_settings)
       VALUES ('${uid}', 'p2p_${uid.slice(0, 8)}', 'P2P', '{}'::jsonb, '{}'::jsonb)`,
    );
    const p2pRoom = randomUUID();
    // A COHERENT p2p room (the 0043 CHECKs must pass): room_keys + private +
    // invite + a directory mode.  The room SHELL is allowed; its CONTENT is not.
    await client.unsafe(
      `INSERT INTO rooms (room_id, name, slug, room_type, visibility, join_model, posting_policy, storage_mode, authority_model, directory_mode)
       VALUES ('${p2pRoom}', 'Secret', 'sec-${p2pRoom.slice(0, 8)}', 'global_topic', 'private', 'invite', 'all_members', 'p2p', 'room_keys', 'unlisted')`,
    );
    const sid = randomUUID();
    const meta = `'{"submission_type":"original_brief","body":"x"}'::jsonb`;
    const topics = `ARRAY['${randomUUID()}']::uuid[]`;
    // A story referencing the p2p room is rejected by the trigger (the message
    // is asserted so a missing-column error could never pass this for the wrong
    // reason).
    await expect(
      client.unsafe(
        `INSERT INTO stories (story_id, canonical_url, title, title_hash, submitted_by, room_id, topic_ids, submission_type, submission_metadata)
         VALUES ('${sid}', NULL, 'nope', 'h-${sid.slice(0, 8)}', '${uid}', '${p2pRoom}', ${topics}, 'original_brief', ${meta})`,
      ),
    ).rejects.toThrow(/Private P2P room/);
    // A thread referencing the p2p room is rejected too (its story never exists,
    // but the trigger guards the thread table independently).
    await expect(
      client.unsafe(
        `INSERT INTO threads (thread_id, story_id, room_id, branch_index)
         VALUES ('${randomUUID()}', '${sid}', '${p2pRoom}', 0)`,
      ),
    ).rejects.toThrow(/Private P2P room/);
    // The NON-content room-referencing tables are guarded too (§11.4: a p2p room
    // has no platform steward / server subscription / server lens).
    await expect(
      client.unsafe(
        `INSERT INTO room_stewards (room_id, user_id, role)
         VALUES ('${p2pRoom}', '${uid}', 'community_steward')`,
      ),
    ).rejects.toThrow(/Private P2P room/);
    // Post-chain schema: 0076 dropped room_subscriptions.notification_preferences.
    await expect(
      client.unsafe(
        `INSERT INTO room_subscriptions (room_id, user_id, status)
         VALUES ('${p2pRoom}', '${uid}', 'active')`,
      ),
    ).rejects.toThrow(/Private P2P room/);
    await expect(
      client.unsafe(
        `INSERT INTO lenses (lens_id, room_id, name, lens_type)
         VALUES ('${randomUUID()}', '${p2pRoom}', 'Expert', 'expert')`,
      ),
    ).rejects.toThrow(/Private P2P room/);
    // Appendix-D-style: zero server content rows exist for the p2p room.
    const n = await client.unsafe(
      `SELECT count(*)::int AS n FROM stories WHERE room_id = '${p2pRoom}'`,
    );
    expect((n[0] as unknown as { n: number }).n).toBe(0);
  });

  // WS-S.1.1 / §4.1/§23.2 — the migration-0043 coherence CHECKs must REJECT an
  // incoherent axis tuple at the storage layer, mirroring the `@licio/shared`
  // `roomAxesSchema` superRefine.  Each case violates EXACTLY ONE constraint
  // (the others stay satisfiable) and asserts that constraint's name fires, so a
  // raw INSERT / old API path / migration can never persist an incoherent P2P
  // (or mislabeled server) room.  The COHERENT-row acceptance is proven by the
  // §8.3 trigger test above (which first inserts a valid p2p room).
  it.each([
    // storage='p2p' but platform authority — violates storage↔authority.
    {
      label: 'a p2p room with platform authority',
      storage: 'p2p',
      authority: 'platform',
      visibility: 'private',
      join: 'invite',
      directory: "'unlisted'",
      constraint: 'rooms_storage_authority_coherence',
    },
    // storage='server' but room_keys authority — violates storage↔authority.
    {
      label: 'a server room with room_keys authority',
      storage: 'server',
      authority: 'room_keys',
      visibility: 'public',
      join: 'open',
      directory: 'NULL',
      constraint: 'rooms_storage_authority_coherence',
    },
    // p2p but publicly visible — violates p2p⇒private.
    {
      label: 'a public p2p room',
      storage: 'p2p',
      authority: 'room_keys',
      visibility: 'public',
      join: 'invite',
      directory: "'unlisted'",
      constraint: 'rooms_p2p_visibility_private',
    },
    // p2p but open-join — violates p2p⇒invite.
    {
      label: 'an open-join p2p room',
      storage: 'p2p',
      authority: 'room_keys',
      visibility: 'private',
      join: 'open',
      directory: "'unlisted'",
      constraint: 'rooms_p2p_join_model_invite',
    },
    // p2p with no directory mode — violates p2p⇒directory_mode NOT NULL.
    {
      label: 'a p2p room with no directory mode',
      storage: 'p2p',
      authority: 'room_keys',
      visibility: 'private',
      join: 'invite',
      directory: 'NULL',
      constraint: 'rooms_p2p_requires_directory_mode',
    },
    // server room carrying a directory mode — violates server⇒directory_mode NULL.
    {
      label: 'a server room carrying a directory mode',
      storage: 'server',
      authority: 'platform',
      visibility: 'private',
      join: 'invite',
      directory: "'listed'",
      constraint: 'rooms_server_no_directory_mode',
    },
  ])(
    '§4.1 coherence CHECK rejects $label',
    async ({ storage, authority, visibility, join, directory, constraint }) => {
      const id = randomUUID();
      await expect(
        client.unsafe(
          `INSERT INTO rooms (room_id, name, slug, room_type, visibility, join_model, posting_policy, storage_mode, authority_model, directory_mode)
           VALUES ('${id}', 'X', 'x-${id.slice(0, 8)}', 'global_topic', '${visibility}', '${join}', 'all_members', '${storage}', '${authority}', ${directory})`,
        ),
      ).rejects.toThrow(new RegExp(constraint));
    },
  );
});
