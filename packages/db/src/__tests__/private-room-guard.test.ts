// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2/1.5 — the ENROLMENT half of the server non-storage contract.
// `checkPrivateServerTables()` is per-COLUMN exhaustive but per-TABLE
// hand-maintained: it iterates `PRIVATE_SERVER_TABLES`, so a third
// `private_*` server table is not "in violation", it is simply never looked
// at — and `check:no-p2p-server-content` still reports green over it.
//
// The requirement is derived from the MIGRATION CHAIN, not from the Drizzle
// exports.  Migrations here are hand-authored (CLAUDE.md forbids
// `db:generate`) and no schema↔migration parity test exists, so a
// `CREATE TABLE "private_room_op_heads"` with no matching `pgTable` export
// would be invisible to an export scan while still being a live server table.
// Same pattern as the compliance-table parity in `isolation.test.ts`.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIVATE_SERVER_TABLES } from '../private-room-guard.js';

/** Every `private_*` table the FULL migration chain creates. */
async function privateTablesInMigrations(): Promise<string[]> {
  const drizzleDir = join(import.meta.dirname, '../../drizzle');
  const created = new Set<string>();
  for (const file of await readdir(drizzleDir)) {
    if (!file.endsWith('.sql')) continue;
    const sql = await readFile(join(drizzleDir, file), 'utf8');
    for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"(private_[^"]+)"/g)) {
      if (match[1]) created.add(match[1]);
    }
  }
  return [...created].sort();
}

describe('WS-S.1.5 private-room server tables are enrolled, not remembered', () => {
  it('guards exactly the private_* tables the FULL migration chain creates', async () => {
    // A new `private_*` table fails here until someone gives it an explicit
    // §8.2 column allowlist in `private-room-guard.ts` — which is the point:
    // the allowlist is the guarantee, and an unenrolled table has none.
    expect(await privateTablesInMigrations()).toEqual(
      PRIVATE_SERVER_TABLES.map((entry) => entry.name).sort(),
    );
  });

  it('finds each enrolled name in the chain that creates it (no phantom entries)', async () => {
    // The converse direction: an allowlist entry naming a table no migration
    // creates would make the guard look broader than it is.
    const created = new Set(await privateTablesInMigrations());
    for (const { name } of PRIVATE_SERVER_TABLES) {
      expect(created.has(name), `${name} is allowlisted but no migration creates it`).toBe(true);
    }
  });
});
