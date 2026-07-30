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

/**
 * Every table a migration statement CREATES, whatever spelling it used.
 *
 * The gate's entire value is seeing what no Drizzle enumeration can, so a legal
 * spelling it cannot read is not a small gap — it is a green gate over a table it
 * never judged.  The pattern this replaces was
 * `CREATE TABLE (?:IF NOT EXISTS )?"(private_…)"`, and it missed:
 *
 *  - SCHEMA-QUALIFIED names.  `CREATE TABLE "public"."private_room_ops"` puts
 *    `public` where the capture group looks, so it does not match `private_` and
 *    the statement vanishes entirely.  This is not hypothetical — the chain
 *    already carries `CREATE TABLE "compliance"."…"` statements, so the spelling
 *    is in use in this very directory.
 *  - UNQUOTED identifiers.  `CREATE TABLE private_room_ops (…)` is valid SQL and
 *    is what a hand-authored migration written from memory looks like.
 *  - lower- or mixed-case `create table`, which Postgres accepts.
 *  - `UNLOGGED` / `TEMPORARY` and any extra whitespace or newline between the
 *    keywords.
 *
 * So: match the statement generically, take the LAST identifier (the table, not
 * its schema), and let the caller filter by prefix.  Unquoted identifiers fold to
 * lower case exactly as Postgres folds them; quoted ones keep their case.
 *
 * Comments are deliberately NOT stripped.  A commented-out `CREATE TABLE
 * "private_x"` would be reported and fail the parity assertion, which is the safe
 * direction: the alternative is a stripper whose own bugs hide a real statement.
 */
const CREATE_TABLE_STATEMENT = new RegExp(
  [
    'CREATE\\s+',
    '(?:(?:GLOBAL|LOCAL)\\s+)?',
    '(?:(?:TEMP|TEMPORARY|UNLOGGED)\\s+)?',
    'TABLE\\s+',
    '(?:IF\\s+NOT\\s+EXISTS\\s+)?',
    // Optional schema qualifier, quoted or bare, discarded.
    '(?:(?:"[^"]+"|[A-Za-z_][\\w$]*)\\s*\\.\\s*)?',
    // The table name itself.
    '("[^"]+"|[A-Za-z_][\\w$]*)',
  ].join(''),
  'gi',
);

function tablesCreatedBy(sql: string): string[] {
  const created: string[] = [];
  for (const match of sql.matchAll(CREATE_TABLE_STATEMENT)) {
    const raw = match[1];
    if (raw === undefined) continue;
    created.push(raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase());
  }
  return created;
}

/** Every `private_*` table the FULL migration chain creates. */
async function privateTablesInMigrations(): Promise<string[]> {
  const drizzleDir = join(import.meta.dirname, '../../drizzle');
  const created = new Set<string>();
  for (const file of await readdir(drizzleDir)) {
    if (!file.endsWith('.sql')) continue;
    const sql = await readFile(join(drizzleDir, file), 'utf8');
    for (const name of tablesCreatedBy(sql)) {
      if (name.startsWith('private_')) created.add(name);
    }
  }
  return [...created].sort();
}

describe("the migration reader, which is this gate's premise", () => {
  // A corpus-only assertion cannot prove the reader handles a spelling the corpus
  // does not yet contain, and "not yet" is exactly when a gate has to hold.
  it('reads every legal spelling of a CREATE TABLE', () => {
    expect(tablesCreatedBy('CREATE TABLE "private_room_stubs" (a int);')).toEqual([
      'private_room_stubs',
    ]);
    // The spelling that vanished completely: the schema went where the table name
    // was expected, so the statement matched nothing at all.
    expect(tablesCreatedBy('CREATE TABLE "public"."private_room_ops" (a int);')).toEqual([
      'private_room_ops',
    ]);
    expect(tablesCreatedBy('CREATE TABLE public.private_room_ops (a int);')).toEqual([
      'private_room_ops',
    ]);
    expect(tablesCreatedBy('create table if not exists private_room_ops (a int);')).toEqual([
      'private_room_ops',
    ]);
    expect(tablesCreatedBy('CREATE  UNLOGGED\n  TABLE\n  "private_room_ops" (a int);')).toEqual([
      'private_room_ops',
    ]);
    // Unquoted folds like Postgres folds it; quoted keeps its case.
    expect(tablesCreatedBy('CREATE TABLE Private_Room_Ops (a int);')).toEqual(['private_room_ops']);
    expect(tablesCreatedBy('CREATE TABLE "Private_Room_Ops" (a int);')).toEqual([
      'Private_Room_Ops',
    ]);
    // And it does not invent tables out of adjacent DDL.
    expect(tablesCreatedBy('ALTER TABLE "private_room_stubs" ADD COLUMN a int;')).toEqual([]);
    expect(tablesCreatedBy('CREATE INDEX ON "private_room_stubs" (a);')).toEqual([]);
  });

  it('finds the schema-qualified creates already in the chain', async () => {
    // Proof against the real corpus that qualified statements are read at all:
    // the compliance schema uses them, and the old pattern could not see one.
    const drizzleDir = join(import.meta.dirname, '../../drizzle');
    const names = new Set<string>();
    for (const file of await readdir(drizzleDir)) {
      if (!file.endsWith('.sql')) continue;
      for (const name of tablesCreatedBy(await readFile(join(drizzleDir, file), 'utf8'))) {
        names.add(name);
      }
    }
    expect(names.has('financial_compliance_case')).toBe(true);
  });
});

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
