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
   * Where every Postgres NOTICE goes, projected to {@link PostgresNotice}.
   *
   * REQUIRED, and `'discard'` is a real answer rather than a missing one.  This
   * package always sets postgres.js's `onnotice` — its unset default is
   * `console.log(parseError(x))`, an unstructured write of the WHOLE notice
   * object straight to stdout, bypassing pino and its redaction paths — so
   * omitting a sink here never fell back to the library, it DROPPED the notice.
   * That is the right behaviour for a test and the wrong one for a server, and
   * as an optional field it was indistinguishable from having thought about it:
   * two production clients (WS-R LCAP, WS-S rendezvous) silently discarded
   * every `WARNING` until review found them one at a time.
   *
   * Making the field mandatory moves that from a convention to a compiler
   * obligation — a new call site cannot be written without deciding, and
   * `'discard'` is greppable in a way that an absent option is not.
   */
  readonly onNotice: ((notice: PostgresNotice) => void) | 'discard';
}

export function createDbClient(connectionString: string, options: DbClientOptions) {
  const { onNotice } = options;
  const client = postgres(connectionString, {
    onnotice: (notice) => {
      if (onNotice === 'discard') return;
      onNotice({
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
