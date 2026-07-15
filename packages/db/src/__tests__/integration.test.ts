// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests (WS-D.1.1, WS-D.3.2).  These run ONLY
// when DATABASE_URL points at a real Postgres (e.g. `docker compose up postgres`);
// CI has no database service, so they are skipped there.  They validate what
// in-memory adapters cannot: the migration applies, the constraints/trigger fire,
// cascades work, and the schema-isolation BFS holds over the LIVE foreign-key
// graph introspected from information_schema.
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test
import { randomUUID } from 'node:crypto';
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertContextsClassified,
  checkSchemaIsolation,
  type IntrospectionRow,
  ISOLATION_CONTEXTS,
  introspectEventPartitions,
  introspectSchemaGraph,
} from '../isolation.js';
import * as schema from '../schema/index.js';
import { sessions, userAuth, users, webauthnCredentials } from '../schema/index.js';

const DB_URL = process.env['DATABASE_URL'];

/** Narrow an insert/returning result to a defined row (no non-null assertions). */
function must<T>(value: T | undefined, message = 'expected a row'): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function userInsert(over: { handle?: string; email?: string | null } = {}) {
  return {
    handle: over.handle ?? `u_${randomUUID().slice(0, 8)}`,
    displayName: 'Integration User',
    email: over.email === undefined ? `${randomUUID().slice(0, 8)}@example.com` : over.email,
    ageBandIfKnown: 'adult' as const,
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
  };
}

describe.skipIf(!DB_URL)('WS-D Postgres integration', () => {
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;

  beforeAll(async () => {
    client = postgres(DB_URL as string, { max: 1 });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
  });

  afterAll(async () => {
    await client?.end();
  });

  it('round-trips a user through the JSONB columns', async () => {
    const inserted = must((await db.insert(users).values(userInsert()).returning())[0]);
    const found = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.userId, inserted.userId),
    });
    expect(found?.privacySettings.sensitive_topic_handling).toBe('strict');
    expect(found?.accountState).toBe('active');
    await db.delete(users).where(sql`${users.userId} = ${inserted.userId}`);
  });

  it('auto-updates updated_at on modification via the trigger (createdAt unchanged)', async () => {
    const u = must((await db.insert(users).values(userInsert()).returning())[0]);
    await new Promise((r) => setTimeout(r, 10));
    const updated = must(
      (
        await db
          .update(users)
          .set({ displayName: 'Renamed' })
          .where(sql`${users.userId} = ${u.userId}`)
          .returning()
      )[0],
    );
    expect(updated.updatedAt.getTime()).toBeGreaterThan(u.updatedAt.getTime());
    expect(updated.createdAt.getTime()).toBe(u.createdAt.getTime());
    await db.delete(users).where(sql`${users.userId} = ${u.userId}`);
  });

  it('allows many NULL-email users but enforces case-insensitive email uniqueness', async () => {
    const a = await db
      .insert(users)
      .values(userInsert({ email: null }))
      .returning();
    const b = await db
      .insert(users)
      .values(userInsert({ email: null }))
      .returning();
    expect(a[0] && b[0]).toBeTruthy(); // two NULL emails coexist (partial index)

    const email = `Dup_${randomUUID().slice(0, 8)}@Example.com`;
    await db.insert(users).values(userInsert({ email }));
    await expect(
      db.insert(users).values(userInsert({ email: email.toLowerCase() })),
    ).rejects.toThrow();
  });

  it('rejects a handle that violates the CHECK constraint', async () => {
    await expect(db.insert(users).values(userInsert({ handle: 'ab' }))).rejects.toThrow();
    await expect(db.insert(users).values(userInsert({ handle: 'has space' }))).rejects.toThrow();
  });

  it('cascades delete to sessions, user_auth, and credentials', async () => {
    const uid = must((await db.insert(users).values(userInsert()).returning())[0]).userId;
    await db.insert(userAuth).values({ userId: uid });
    await db.insert(sessions).values({
      sessionId: randomUUID(),
      userId: uid,
      authMethod: 'webauthn',
      deviceLabel: 'iOS/Safari',
    });
    await db.insert(webauthnCredentials).values({
      credentialId: Buffer.from(`cred-${uid}`),
      userId: uid,
      publicKey: Buffer.from('pk'),
      deviceType: 'platform',
    });

    await db.delete(users).where(sql`${users.userId} = ${uid}`);
    const remaining = await db.execute(
      sql`SELECT
        (SELECT count(*) FROM sessions WHERE user_id = ${uid}) AS s,
        (SELECT count(*) FROM user_auth WHERE user_id = ${uid}) AS a,
        (SELECT count(*) FROM webauthn_credentials WHERE user_id = ${uid}) AS c`,
    );
    const row = remaining[0] as { s: string; a: string; c: string };
    expect(`${row.s}${row.a}${row.c}`).toBe('000');
  });

  it('has NO password column on user_auth (no password path can exist)', async () => {
    const cols = await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_auth'`,
    );
    const names = cols.map((r) => (r as { column_name: string }).column_name);
    expect(names.some((n) => /pass(word|hash)/i.test(n))).toBe(false);
  });

  it('proves wallet↔ranking isolation over the LIVE foreign-key graph (WS-D.3.2)', async () => {
    const runQuery = async (q: string): Promise<IntrospectionRow[]> =>
      (await client.unsafe(q)) as unknown as IntrospectionRow[];
    const graph = await introspectSchemaGraph(runQuery);
    expect(checkSchemaIsolation(graph, ISOLATION_CONTEXTS).isolated).toBe(true);

    // Every table in a context schema must be classified (fail-closed) —
    // wallet, knomosis, AND the WS-N compliance schema (migration 0088).
    const rels = await client.unsafe(
      `SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN ('wallet', 'knomosis', 'compliance')`,
    );
    const relations = (rels as unknown as Array<{ table_schema: string; table_name: string }>).map(
      (r) => `${r.table_schema}.${r.table_name}`,
    );
    expect(
      assertContextsClassified(relations, ISOLATION_CONTEXTS, ['wallet', 'knomosis', 'compliance'])
        .classified,
    ).toBe(true);

    // Every LIVE partition of the events log must itself be a classified
    // ranking table: partitions are ordinary relations a view or FK can
    // target directly, and `public` cannot be wholly fail-closed, so this is
    // the runtime complement of the static migration-parity test.
    const partitions = await introspectEventPartitions(runQuery);
    expect(partitions.length).toBeGreaterThanOrEqual(8);
    for (const partition of partitions) {
      expect(ISOLATION_CONTEXTS.rankingTables.has(partition)).toBe(true);
    }
  });
});
