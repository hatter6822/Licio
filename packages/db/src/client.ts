// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/**
 * The Postgres NOTICE fields this package is willing to hand a logger.
 *
 * A NOTICE carries far more than these three — `detail`, `hint`, `where`,
 * `internal_query`, `position` — and those are precisely the fields that echo
 * QUERY TEXT and ROW VALUES back to the client (a unique-violation DETAIL reads
 * `Key (email)=(alice@example.com) already exists`).  Projecting to
 * severity/code/message keeps the diagnostic value while ensuring the notice
 * path can never become a side channel that carries user data into logs.
 */
export interface PostgresNotice {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
}

export interface DbClientOptions {
  /**
   * Receives every Postgres NOTICE, projected to {@link PostgresNotice}.
   *
   * Supplying one is how a consumer routes notices into ITS logger (the API
   * boot passes a pino sink).  Omitting it DISCARDS them — which is the point:
   * postgres.js's own default for an unset `onnotice` is
   * `console.log(parseError(x))`, an unstructured write of the WHOLE notice
   * object straight to stdout.  That bypasses pino (and therefore its redaction
   * paths) in the server, and floods the vitest output with raw notice objects
   * whenever the migration chain replays.  `onnotice` is therefore ALWAYS set
   * below, never left to the library default.
   */
  readonly onNotice?: (notice: PostgresNotice) => void;
}

export function createDbClient(connectionString: string, options: DbClientOptions = {}) {
  const { onNotice } = options;
  const client = postgres(connectionString, {
    onnotice: (notice) => {
      onNotice?.({
        severity: notice['severity'] ?? 'NOTICE',
        code: notice['code'] ?? '',
        message: notice['message'] ?? '',
      });
    },
  });
  return drizzle(client, { schema });
}

/**
 * Round-trip liveness check against the database (`select 1`) — the readiness
 * probe consumers point at.  Lives here so callers never hand-build SQL against
 * the client (the parameterized-queries-only rule).
 */
export async function pingDatabase(db: DbClient): Promise<void> {
  await db.execute(sql`select 1`);
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
