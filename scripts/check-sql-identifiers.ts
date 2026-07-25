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
 * Split SQL into the spans that can hold an identifier, discarding the spans
 * that cannot: `--` line comments, `/* … *\/` block comments (nesting, which
 * Postgres allows), `'…'` string literals (with the `''` escape), and
 * `$tag$ … $tag$` dollar-quoted bodies' delimiters.
 *
 * Scanning rather than regex-replacing because the constructs interleave: a
 * string can contain `--`, a comment can contain an apostrophe, and a
 * sequential set of replaces gets both wrong. Dollar-quoted BODIES are kept
 * (migration 0097's `DO $$ … $$` block contains real DDL), while the string
 * literals inside them are still dropped.
 *
 * Yields `{ text, quoted }` runs: `quoted` marks a `"…"` delimited identifier,
 * which may legally contain characters a bare identifier may not.
 */
export function* identifierCandidates(sql: string): Generator<{ text: string; quoted: boolean }> {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    // -- line comment
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    // /* block comment */ (Postgres nests these)
    if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const t = sql.slice(i, i + 2);
        if (t === '/*') {
          depth += 1;
          i += 2;
        } else if (t === '*/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      continue;
    }
    // 'string literal' — '' is an escaped quote, not a terminator
    if (sql[i] === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i += 1;
            break;
          }
        } else i += 1;
      }
      continue;
    }
    // $tag$ … $tag$ — skip only the DELIMITERS so the body is still scanned
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollar) {
      i += dollar[0].length;
      continue;
    }
    // "quoted identifier" — `""` is an ESCAPED quote inside the name, not a
    // terminator. Stopping at the first quote would split a single 64-byte
    // identifier into two sub-limit halves, and both would pass. The DECODED
    // name is what Postgres stores and therefore what must be measured.
    if (sql[i] === '"') {
      i += 1;
      let decoded = '';
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            decoded += '"';
            i += 2;
          } else {
            i += 1;
            closed = true;
            break;
          }
        } else {
          decoded += sql[i];
          i += 1;
        }
      }
      if (!closed) return; // unterminated: stop rather than mis-parse the rest
      yield { text: decoded, quoted: true };
      continue;
    }
    // bare identifier / keyword token
    const bare = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
    if (bare) {
      yield { text: bare[0], quoted: false };
      i += bare[0].length;
      continue;
    }
    i += 1;
  }
}

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
 * Scans BOTH `"quoted"` and bare identifiers. The bare case matters because
 * migrations here are hand-authored: `CREATE INDEX a…64_bytes ON t (c)` is
 * valid SQL that Postgres truncates just as silently, and — unlike the quoted
 * case — the catalog backstop can never recover it after the fact, because the
 * server stores only the 63-byte result. The static scan is the ONLY general
 * protection against it, so it has to see unquoted names.
 *
 * Scanning every bare token (not just DDL name positions) is safe precisely
 * because the only thing reported is a token OVER the limit: no SQL keyword is
 * anywhere near 63 bytes, so a bare token that long is an identifier by
 * construction. That avoids enumerating every DDL form — `CREATE INDEX`,
 * `ADD CONSTRAINT`, `CREATE TRIGGER`, `RENAME CONSTRAINT … TO …` — and the
 * inevitable gap in that list.
 *
 * Length is measured in BYTES, not characters: `NAMEDATALEN` bounds the byte
 * length, so a multi-byte identifier truncates sooner than its character count
 * suggests (and truncation can even split a UTF-8 sequence).
 */
export function findOverlongIdentifiers(filename: string, sql: string): IdentifierViolation[] {
  const violations: IdentifierViolation[] = [];
  const seen = new Set<string>();
  for (const { text } of identifierCandidates(sql)) {
    if (seen.has(text)) continue;
    seen.add(text);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > PG_MAX_IDENTIFIER_BYTES && !HISTORICAL_EXEMPTIONS.has(text)) {
      violations.push({ file: filename, identifier: text, bytes });
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
