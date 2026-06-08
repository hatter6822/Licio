// SPDX-License-Identifier: AGPL-3.0-or-later
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export function createDbClient(connectionString: string) {
  const sql = postgres(connectionString);
  return drizzle(sql, { schema });
}
