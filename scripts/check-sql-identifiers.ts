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
 * Keywords after which a dollar-quoted span is PROCEDURAL CODE rather than a
 * data value: `DO $$ … $$` and `CREATE FUNCTION … AS $$ … $$`. Only after one
 * of these is the body real SQL whose identifiers must be measured.
 */
const PROCEDURAL_BEFORE_DOLLAR: ReadonlySet<string> = new Set(['do', 'as']);

/**
 * Split SQL into the spans that can hold an identifier, discarding the spans
 * that cannot: `--` line comments, `/* … *\/` block comments (nesting, which
 * Postgres allows), `'…'` string literals (with the `''` escape), and
 * dollar-quoted VALUE literals.
 *
 * Scanning rather than regex-replacing because the constructs interleave: a
 * string can contain `--`, a comment can contain an apostrophe, and a
 * sequential set of replaces gets both wrong.
 *
 * Dollar quoting is CONTEXT-DEPENDENT and both readings are needed. After `DO`
 * or `AS` the body is procedural code — migration 0097's `DO $$ … $$` block
 * contains real DDL whose identifiers must be measured — so only the
 * delimiters are skipped. Everywhere else `$$…$$` is just a string literal
 * (`INSERT … VALUES ($$text$$)`), and tokenising that as SQL would report the
 * prose inside it as an over-long identifier and fail a perfectly valid
 * migration. Treating every dollar-quoted span as code makes the gate reject
 * correct input; treating every one as data would blind it to 0097's DDL.
 *
 * Yields `{ text, quoted }` runs: `quoted` marks a `"…"` delimited identifier,
 * which may legally contain characters a bare identifier may not.
 */
export function* identifierCandidates(sql: string): Generator<{ text: string; quoted: boolean }> {
  let i = 0;
  const n = sql.length;
  // The last bare token seen, lower-cased — decides how the next `$tag$` reads.
  let lastToken = '';
  // The tag of the PROCEDURAL body currently open, if any. Its matching close
  // is a delimiter to skip, not the start of a new literal (the token before it
  // is `END`, which would otherwise read as data).
  let openProceduralTag: string | null = null;
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
    // $tag$ … $tag$ — data literal or procedural body, per the context above.
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      if (openProceduralTag === tag) {
        // Closing delimiter of the procedural body: skip the delimiter only.
        openProceduralTag = null;
        i += tag.length;
        continue;
      }
      if (openProceduralTag === null && PROCEDURAL_BEFORE_DOLLAR.has(lastToken)) {
        // `DO $$` / `AS $$`: the body is code, so scan it.
        openProceduralTag = tag;
        i += tag.length;
        continue;
      }
      // A value literal (including one nested inside a procedural body): skip
      // the ENTIRE span. An unterminated literal consumes the rest rather than
      // spilling its prose into the identifier stream.
      const close = sql.indexOf(tag, i + tag.length);
      i = close === -1 ? n : close + tag.length;
      lastToken = '';
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
    // Bare identifier / keyword token. Postgres's unquoted-identifier set is
    // NOT ASCII-only: any character with the high bit set is a valid letter, so
    // `é…` is one identifier the server truncates like any other. An
    // ASCII-only class silently skipped the leading `é` and measured only the
    // shorter suffix, letting a 64-byte name through.
    const bare = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/.exec(sql.slice(i));
    if (bare) {
      // `$` is legal INSIDE a bare identifier, so `END$$` would otherwise be
      // consumed whole and the dollar-quote delimiter never seen \u2014 leaving a
      // procedural body open for the rest of the file. Stop the token at a
      // `$$`, which can only be a delimiter.
      const dd = bare[0].indexOf('$$');
      const text = dd > 0 ? bare[0].slice(0, dd) : bare[0];
      lastToken = text.toLowerCase();
      yield { text, quoted: false };
      i += text.length;
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
 * Each exemption is SCOPED TO THE FILES that already contain it: the migration
 * that originally created the name, plus 0097 itself (which must spell the old
 * name to rename it). A name-only exemption would be a permanent licence to
 * reuse these five names — a NEW migration spelling one would inherit the pass
 * and be truncated exactly as before, which is the very defect this gate
 * exists to catch. Immutable history is the reason to exempt; it does not
 * extend to files that have not been written yet.
 *
 * This list is CLOSED. Do not add to it: a new over-long identifier is a bug to
 * fix in the migration being written, not a precedent to extend.
 */
const RENAME_MIGRATION = '0097_constraint_name_truncation.sql';

const HISTORICAL_EXEMPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'debate_arenas_challenger_contribution_id_contributions_contribution_id_fk',
    new Set(['0056_ws_t_debate_arena.sql', RENAME_MIGRATION]),
  ],
  [
    'debate_arenas_target_contribution_id_contributions_contribution_id_fk',
    new Set(['0056_ws_t_debate_arena.sql', RENAME_MIGRATION]),
  ],
  [
    'steward_governance_vote_election_id_steward_election_election_id_fk',
    new Set(['0035_ws_u_ai_governed_rooms.sql', RENAME_MIGRATION]),
  ],
  [
    'room_governance_prompt_model_id_room_governance_model_model_id_fk',
    new Set(['0035_ws_u_ai_governed_rooms.sql', RENAME_MIGRATION]),
  ],
  [
    'room_agent_binding_prompt_id_room_governance_prompt_prompt_id_fk',
    new Set(['0035_ws_u_ai_governed_rooms.sql', RENAME_MIGRATION]),
  ],
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
    if (bytes > PG_MAX_IDENTIFIER_BYTES && !HISTORICAL_EXEMPTIONS.get(text)?.has(filename)) {
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
