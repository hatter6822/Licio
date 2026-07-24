// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SQL identifier-length gate (SPEC §6.12 schema hygiene).
//
// Postgres does NOT reject an identifier longer than `NAMEDATALEN - 1` (63
// bytes by default) — it silently TRUNCATES it and emits only a NOTICE, which
// scrolls past in migrate output. That is benign until two DIFFERENT intended
// names agree on their first 63 bytes: they then truncate to the SAME stored
// name, and either the second CREATE fails with a duplicate-object error at
// migrate time, or a later `DROP CONSTRAINT` / `ALTER … RENAME` silently
// targets whichever one exists. Five Drizzle-derived foreign-key names were
// already landing truncated (renamed by migration 0097); this gate is what
// stops the class from coming back.
//
// It scans the HAND-AUTHORED migration SQL — the only place an identifier
// actually reaches the server, since `db:generate` is never run on this repo
// (CLAUDE.md) — and fails on any quoted identifier over the limit. The
// companion gated integration test (`packages/db/src/__tests__`) asserts the
// same property over the MIGRATED DATABASE, which additionally covers names
// Drizzle derives rather than spells out.
//
// Deliberately dependency-free so the `scripts`-rooted vitest project can unit
// test the pure core directly.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Postgres `NAMEDATALEN - 1`: the longest identifier stored without truncation. */
export const PG_MAX_IDENTIFIER_BYTES = 63;

/**
 * Quoted SQL identifiers. Restricted to the unquoted-identifier charset
 * (`[A-Za-z_][A-Za-z0-9_$]*`) on purpose: a permissive `"[^"]+"` also matches
 * multi-line spans between two unrelated quotes — comment prose, `->>'…'`
 * JSON paths, `format()` templates — and reported them as enormous
 * "identifiers". Every real identifier in this schema is snake_case, so the
 * narrow form matches all of them and nothing else.
 */
const QUOTED_IDENTIFIER = /"([A-Za-z_][A-Za-z0-9_$]*)"/g;

/**
 * Over-long identifiers in migrations that are ALREADY APPLIED and therefore
 * immutable history. Migration 0097 renames what these created, so the live
 * schema carries the short names; the SQL text cannot be edited without
 * diverging from every database that has already run it.
 *
 * This list is CLOSED. Do not add to it: a new over-long identifier is a bug to
 * fix in the migration being written, not a precedent to extend.
 */
const HISTORICAL_EXEMPTIONS: ReadonlySet<string> = new Set([
  'debate_arenas_challenger_contribution_id_contributions_contribution_id_fk',
  'debate_arenas_target_contribution_id_contributions_contribution_id_fk',
  'steward_governance_vote_election_id_steward_election_election_id_fk',
  'room_governance_prompt_model_id_room_governance_model_model_id_fk',
  'room_agent_binding_prompt_id_room_governance_prompt_prompt_id_fk',
]);

export interface IdentifierViolation {
  file: string;
  identifier: string;
  bytes: number;
}

/**
 * Find identifiers Postgres would truncate in one migration's SQL. Pure.
 *
 * Length is measured in BYTES, not characters: `NAMEDATALEN` bounds the byte
 * length, so a multi-byte identifier truncates sooner than its character count
 * suggests (and truncation can even split a UTF-8 sequence).
 */
export function findOverlongIdentifiers(filename: string, sql: string): IdentifierViolation[] {
  const violations: IdentifierViolation[] = [];
  const seen = new Set<string>();
  for (const match of sql.matchAll(QUOTED_IDENTIFIER)) {
    const identifier = match[1];
    if (identifier === undefined || seen.has(identifier)) continue;
    seen.add(identifier);
    const bytes = Buffer.byteLength(identifier, 'utf8');
    if (bytes > PG_MAX_IDENTIFIER_BYTES && !HISTORICAL_EXEMPTIONS.has(identifier)) {
      violations.push({ file: filename, identifier, bytes });
    }
  }
  return violations;
}

function main(): void {
  const root = resolve(import.meta.dirname, '..');
  const dir = resolve(root, 'packages/db/drizzle');
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`SQL identifier check FAILED: ${dir} is not a directory`);
    process.exit(1);
  }

  const violations: IdentifierViolation[] = [];
  let scanned = 0;
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    scanned += 1;
    violations.push(...findOverlongIdentifiers(name, readFileSync(join(dir, name), 'utf-8')));
  }

  if (violations.length > 0) {
    console.error('SQL identifier check FAILED — Postgres would TRUNCATE these to 63 bytes:');
    for (const v of violations) {
      console.error(`  - ${v.file}: "${v.identifier}" (${v.bytes} bytes)`);
      console.error(`      truncates to "${v.identifier.slice(0, PG_MAX_IDENTIFIER_BYTES)}"`);
    }
    console.error(
      '\n  Give the object an EXPLICIT short name. For a Drizzle foreign key that means the\n' +
        '  table-level `foreignKey({ columns, foreignColumns, name })` form — inline\n' +
        '  `.references()` cannot name a constraint, so it derives\n' +
        '  `<table>_<column>_<fktable>_<fkcolumn>_fk`, which overflows easily.',
    );
    process.exit(1);
  }

  console.log(
    `SQL identifier check passed: ${scanned} migrations, no identifier over ${PG_MAX_IDENTIFIER_BYTES} bytes.`,
  );
}

// Run as a CLI only; importing for tests must not trigger the scan.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
