// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2/1.5 — the ENROLMENT half of the server non-storage contract.
//
// `checkPrivateServerTables()` derives its table set from the schema now
// (`privateServerTables()`: everything `schema/private-room.ts` exports, plus
// every table whose SQL name starts with `private_`), and reports a table with
// no §8.2 allowlist as `unregistered_table` rather than skipping it.  That
// closes the Drizzle side.
//
// This file closes the other side, which no export enumeration can reach.
// Migrations here are hand-authored (CLAUDE.md forbids `db:generate`) and no
// schema↔migration parity test exists, so a
// `CREATE TABLE "private_room_op_heads"` with no matching `pgTable` export is a
// live server table that `privateServerTables()` cannot see at all.  The
// requirement is therefore derived from the MIGRATION CHAIN — the same pattern
// as the compliance-table parity in `isolation.test.ts`.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkPrivateServerTables,
  PRIVATE_ALLOWLISTED_TABLE_NAMES,
  privateServerTables,
} from '../private-room-guard.js';

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
    expect(await privateTablesInMigrations()).toEqual([...PRIVATE_ALLOWLISTED_TABLE_NAMES]);
  });

  it('finds each enrolled name in the chain that creates it (no phantom entries)', async () => {
    // The converse direction: an allowlist entry naming a table no migration
    // creates would make the guard look broader than it is.
    const created = new Set(await privateTablesInMigrations());
    for (const name of PRIVATE_ALLOWLISTED_TABLE_NAMES) {
      expect(created.has(name), `${name} is allowlisted but no migration creates it`).toBe(true);
    }
  });

  it('the Drizzle-derived scope agrees with the allowlist, and every table is judged', () => {
    // `privateServerTables()` is the set the guard actually walks.  If it ever
    // drifts below the allowlist, columns stop being checked silently; if it
    // drifts above, the extra table surfaces as `unregistered_table` rather
    // than passing unexamined.
    const derived = privateServerTables();
    expect(derived.map((entry) => entry.name)).toEqual([...PRIVATE_ALLOWLISTED_TABLE_NAMES]);
    expect(derived.every((entry) => entry.allowed !== undefined)).toBe(true);
    expect(checkPrivateServerTables()).toEqual([]);
  });
});
