// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Vitest globalSetup for the apps/api project: when the gated integration env
// is present (DATABASE_URL), run the Drizzle migration chain ONCE, in the main
// process, before the parallel test workers start.
//
// Why this exists.  Every gated suite calls `migrate()` in its own `beforeAll`.
// Against an ALREADY-migrated database each such call is a harmless no-op, but
// against a FRESH one (CI's ephemeral Postgres) many workers reach their first
// migrate() at the same moment and race on identical DDL — two sessions both run
// `CREATE SCHEMA "wallet"` and one dies on pg_namespace's unique index (23505),
// failing whichever suite lost the race.  Migrating once up front makes every
// in-suite migrate() a no-op, so the race cannot occur.  A session-level
// advisory lock serialises even this single migration against any other process
// that might share the same database.
import { createDbClient, migrationsFolder } from '@licio/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/** Arbitrary stable key so any two processes migrating this DB serialise. */
const MIGRATION_ADVISORY_LOCK_KEY = 4_021_997;

/** The postgres-js client drizzle exposes on `db.$client` (structural subset). */
interface RawClient {
  unsafe(query: string): Promise<unknown>;
  end(options?: { timeout?: number }): Promise<void>;
}

export async function setup(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  // No gated DB env → the integration suites skip (`describe.skipIf(!DB_URL)`);
  // there is nothing to migrate and no race to prevent.
  if (url === undefined || url === '') return;
  const db = createDbClient(url);
  const client = (db as unknown as { $client: RawClient }).$client;
  try {
    // The key is a numeric literal (never user input) — safe to interpolate.
    await client.unsafe(`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`);
    try {
      await migrate(db, { migrationsFolder: migrationsFolder() });
    } finally {
      await client.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
