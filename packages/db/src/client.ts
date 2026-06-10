// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export function createDbClient(connectionString: string) {
  const sql = postgres(connectionString);
  return drizzle(sql, { schema });
}

/**
 * Absolute path of this package's generated SQL migrations, for
 * `drizzle-orm`'s `migrate()` — consumers (gated integration tests, ops
 * tooling) should never hand-build a relative path into the package.
 */
export function migrationsFolder(): string {
  return fileURLToPath(new URL('../drizzle', import.meta.url));
}
