// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export function createDbClient(connectionString: string) {
  const sql = postgres(connectionString);
  return drizzle(sql, { schema });
}

/** The drizzle client returned by {@link createDbClient}. */
export type DbClient = ReturnType<typeof createDbClient>;

/** The transaction handle drizzle passes to a `db.transaction(cb)` callback. */
export type DbTransaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];

/**
 * A query executor: the base client OR an open transaction.  Store adapters
 * type their handle as this so the SAME adapter runs standalone or inside a
 * wrapping transaction (e.g. the all-or-nothing development seed, which binds
 * every content store to one `db.transaction(...)` so a mid-seed failure can
 * never leave a partial corpus).  Every method the adapters use — `insert`,
 * `select`, `update`, `delete`, and nested `transaction` (a savepoint) —
 * exists on both members.
 */
export type DbExecutor = DbClient | DbTransaction;

/**
 * Absolute path of this package's generated SQL migrations, for
 * `drizzle-orm`'s `migrate()` — consumers (gated integration tests, ops
 * tooling) should never hand-build a relative path into the package.
 */
export function migrationsFolder(): string {
  return fileURLToPath(new URL('../drizzle', import.meta.url));
}
