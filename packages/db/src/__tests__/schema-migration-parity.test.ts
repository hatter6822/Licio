// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EVERY INDEX THE MIGRATIONS CREATE IS ALSO DECLARED IN THE SCHEMA.
//
// The migrations are hand-authored and the Drizzle schema is written alongside them, so
// nothing forces the two to agree — and `pnpm db:push` builds a database from the SCHEMA
// alone.  An index that exists only in a migration is therefore one `db:push` DROPS, on
// a development database, silently, with the application still running.
//
// For a performance index that is a slow query.  For the three the moderation audit chain
// stands on it is worse than that, and worse in a way nothing would report: without
// `moderation_audit_chain_parent_uq` two writers reading the same head both append to it
// and the chain FORKS — and each branch verifies perfectly in isolation, because a fork
// is only detectable from the constraint that prevented it.  Without
// `moderation_audit_chain_genesis_uq` a second genesis starts a second chain nothing
// links to.  Both produce a tamper-evident structure that is no longer evidence.
//
// Four such indexes shipped undeclared in this branch (0115, 0117, 0118), which is what
// this test is for.  It is not gated: it reads the schema and the migration files, so it
// runs everywhere `pnpm test` does.
import { readFile } from 'node:fs/promises';
import { generateDrizzleJson } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as schema from '../schema/index.js';

/** Index / unique-constraint names the Drizzle schema declares. */
function declaredNames(): Set<string> {
  // The snapshot generator is the same one `db:push` uses, so this reads the schema
  // exactly as the tool that would drop the difference does.
  const snapshot = generateDrizzleJson(schema as Record<string, unknown>) as {
    tables?: Record<string, { name: string; indexes?: object; uniqueConstraints?: object }>;
  };
  const names = new Set<string>();
  for (const table of Object.values(snapshot.tables ?? {})) {
    for (const name of Object.keys(table.indexes ?? {})) names.add(name);
    for (const name of Object.keys(table.uniqueConstraints ?? {})) names.add(name);
  }
  return names;
}

/** Table names the Drizzle schema knows about — the scope of the comparison.  A
 *  migration may create an index on a table the schema deliberately does not model
 *  (a pure-SQL artefact), and `db:push` leaves those alone. */
function knownTables(): Set<string> {
  const snapshot = generateDrizzleJson(schema as Record<string, unknown>) as {
    tables?: Record<string, { name: string }>;
  };
  return new Set(Object.values(snapshot.tables ?? {}).map((t) => t.name));
}

/** Index name → table, folded over the whole migration chain in journal order so a
 *  later DROP removes an earlier CREATE. */
async function liveIndexes(): Promise<Map<string, string>> {
  const dir = new URL('../../drizzle/', import.meta.url);
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', dir), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const live = new Map<string, string>();
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const sql = await readFile(new URL(`${entry.tag}.sql`, dir), 'utf8');
    // `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] "name" … ON "table"`.  The
    // gap is bounded so the `ON` of a *different* statement cannot be captured.
    for (const m of sql.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF NOT EXISTS\s+)?"?([\w-]+)"?[\s\S]{0,80}?\bON\s+"?([\w-]+)"?/gi,
    )) {
      live.set(m[1] as string, m[2] as string);
    }
    for (const m of sql.matchAll(
      /ALTER TABLE\s+(?:ONLY\s+)?"?([\w-]+)"?\s+ADD CONSTRAINT\s+"?([\w-]+)"?\s+UNIQUE/gi,
    )) {
      live.set(m[2] as string, m[1] as string);
    }
    for (const m of sql.matchAll(/DROP\s+INDEX\s+(?:IF EXISTS\s+)?"?([\w-]+)"?/gi))
      live.delete(m[1] as string);
    for (const m of sql.matchAll(/DROP CONSTRAINT\s+(?:IF EXISTS\s+)?"?([\w-]+)"?/gi))
      live.delete(m[1] as string);
  }
  return live;
}

describe('the schema declares what the migrations create', () => {
  it('reads a real chain, so a scan that stopped matching cannot pass', async () => {
    // Both sides have to be non-trivial or every assertion below is vacuous.
    const live = await liveIndexes();
    expect(live.size).toBeGreaterThan(200);
    expect(declaredNames().size).toBeGreaterThan(200);
    // And the four that motivated this test are actually in the scanned set.
    for (const name of [
      'moderation_audit_ordinal_key',
      'moderation_audit_case_ordinal_idx',
      'moderation_audit_chain_parent_uq',
      'moderation_audit_chain_genesis_uq',
    ]) {
      expect(live.get(name)).toBe('moderation_audit');
    }
  });

  it('declares every surviving migration index on a modelled table', async () => {
    const declared = declaredNames();
    const known = knownTables();
    const undeclared = [...(await liveIndexes())]
      .filter(([name, table]) => known.has(table) && !declared.has(name))
      .map(([name, table]) => `${table}.${name}`)
      .sort();

    // Naming them rather than counting: whoever trips this needs to add the declaration
    // to `src/schema/`, not to relax the bound.
    expect(undeclared).toEqual([]);
  });
});
