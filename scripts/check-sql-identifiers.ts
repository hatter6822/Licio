// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SQL identifier-length gate (SPEC §6.12 schema hygiene).
//
// Postgres does NOT reject an identifier longer than `NAMEDATALEN - 1` (63
// bytes by default) — it silently TRUNCATES it and emits only a NOTICE, which
// scrolls past in migrate output.  That is benign until two DIFFERENT intended
// names agree on their first 63 bytes: they then truncate to the SAME stored
// name, and either the second CREATE fails with a duplicate-object error at
// migrate time, or a later `DROP CONSTRAINT` / `ALTER … RENAME` silently
// targets whichever one exists.  Five Drizzle-derived foreign-key names were
// already landing truncated (renamed by migration 0097).
//
// TWO CHECKS, and the division between them is the point.
//
//   • THIS gate reads the hand-authored migration SQL with the REAL POSTGRES
//     PARSER (`libpg-query`, the server's own grammar compiled to WASM).  It
//     needs no database, so it catches a name in the Lint job before anything
//     is applied.
//   • The migration harness (`packages/db/src/__tests__`) listens for
//     Postgres's own `identifier … will be truncated` NOTICE while applying the
//     whole chain.  That is AUTHORITATIVE, and it covers the two routes no
//     static read can: a name DERIVED by Drizzle rather than spelled out, and
//     one composed at runtime inside `EXECUTE format(…)`.
//
// That division is why this file is short.  It used to hand-write a SQL lexer —
// quoted bodies with `""` escapes, `U&"…"` with `UESCAPE`, `E'…'`, dollar
// quoting, which `$tag$` spans are PROCEDURAL versus data, and an interpreter
// for `EXECUTE`, `format()` and `||` concatenation so it could reconstruct
// dynamically-built names.  Roughly ten commits added one more case each:
// "decode `""` in SQL identifiers", "handle `E''` and UTF-8 clipping", "three
// SQL lexer gaps", "expand EXECUTE format()", "classify SQL bodies by
// LANGUAGE".  The lexing is now the parser's, and the dynamic construction is
// answered exactly by Postgres itself rather than approximately here.
//
// HOW A TRUNCATION IS VISIBLE HERE.  The parser is the server's, so it applies
// the server's limit: an over-long identifier comes back ALREADY TRUNCATED, and
// the original length is not recoverable from the tree.  That is not a defect,
// it is the same normalisation the gate exists to detect — so the gate reads the
// SIGNATURE instead of the length.
//
// A truncated ASCII name is EXACTLY 63 bytes, always; a multi-byte one is
// clipped to a character boundary, so it lands between 60 and 63.  Every
// truncation therefore shows up in that band, and nothing outside it can be one
// — the test is sound, and a name inside it is either genuinely that long or was
// cut, which the parser cannot tell apart.  So the gate asks for the genuine
// ones to be DECLARED, and the migration harness settles the rest by listening
// to Postgres.
//
// WHAT COUNTS AS AN IDENTIFIER.  Every string in the parse tree, except the
// three things that are legitimately long and are not names: literal CONSTANTS,
// procedural BODIES, and COMMENT prose.  Over-collecting is deliberate and
// safe, because the only thing reported is a string OVER the limit and no SQL
// keyword or enum tag is anywhere near 63 bytes — so this needs no list of the
// DDL forms that can name something, and cannot have a gap in one.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'libpg-query';
import {
  isHistoricallyExempt,
  migrationTag,
  PG_MAX_IDENTIFIER_BYTES,
} from '../packages/db/src/identifier-limits.js';

export { PG_MAX_IDENTIFIER_BYTES } from '../packages/db/src/identifier-limits.js';

/**
 * Node keys whose STRING payload is prose or data, never a name.
 *
 * `A_Const` is a literal constant; `CommentStmt.comment` is prose.  A
 * procedural body arrives as the argument of a `DefElem` named `as` (a function
 * body) — plpgsql text, which this gate does not read and the harness covers.
 */
const BODY_DEFNAMES: ReadonlySet<string> = new Set(['as', 'body']);

/** A parse-tree node, as the parser hands it back. */
type TreeNode = Record<string, unknown> | unknown[] | string | number | boolean | null;

/**
 * Every identifier one migration's SQL names.
 *
 * The walk carries two exclusions down with it rather than testing field names
 * on the way out, so a constant nested inside an expression and a body nested
 * inside a `DO` are both skipped wherever they appear.
 */
export async function identifiersIn(sql: string): Promise<string[]> {
  const tree = (await parse(sql)) as { stmts?: unknown };
  const found: string[] = [];

  const walk = (node: TreeNode, inConstant: boolean, inBody: boolean): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const each of node) walk(each as TreeNode, inConstant, inBody);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        // `CommentStmt.comment` is the only prose field; everything else that
        // survives the two flags is a name.
        if (!inConstant && !inBody && key !== 'comment') found.push(value);
        continue;
      }
      const defname =
        key === 'DefElem' && value !== null && typeof value === 'object'
          ? String((value as Record<string, unknown>)['defname'] ?? '')
          : '';
      walk(
        value as TreeNode,
        inConstant || key === 'A_Const',
        inBody || BODY_DEFNAMES.has(defname),
      );
    }
  };

  walk((tree.stmts ?? []) as TreeNode, false, false);
  return found;
}

/**
 * Names that genuinely sit at the limit, and are therefore NOT truncations.
 *
 * The parser cannot distinguish these from a cut name, so they are declared
 * once.  Each is scoped to the migrations it appears in, and an entry that
 * stops matching is itself an error — the same discipline the other allowlists
 * in `scripts/` keep.
 */
export const LEGITIMATE_LIMIT_NAMES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'model_ratification_ballot_vote_id_model_ratification_vote_id_fk',
    new Set(['0037_ws_u_model_ratification']),
  ],
]);

/** The narrowest a UTF-8 clip to a character boundary can leave a cut name. */
const NARROWEST_CLIP_BYTES = PG_MAX_IDENTIFIER_BYTES - 3;

/**
 * Whether an identifier's length is the SIGNATURE of a possible truncation.
 *
 * Exactly at the limit for ASCII; down to a character boundary below it when
 * multi-byte, since Postgres clips rather than splitting a UTF-8 sequence.
 */
function isAtTruncationSignature(identifier: string): boolean {
  const bytes = Buffer.byteLength(identifier, 'utf8');
  if (bytes === PG_MAX_IDENTIFIER_BYTES) return true;
  const multiByte = bytes !== identifier.length;
  return multiByte && bytes >= NARROWEST_CLIP_BYTES;
}

export interface IdentifierViolation {
  file: string;
  identifier: string;
  bytes: number;
}

/**
 * Identifiers Postgres would truncate in one migration's SQL.
 *
 * Length is measured in BYTES, not characters: `NAMEDATALEN` bounds the byte
 * length, so a multi-byte identifier truncates sooner than its character count
 * suggests — and truncation can even split a UTF-8 sequence.
 */
export async function findOverlongIdentifiers(
  filename: string,
  sql: string,
): Promise<IdentifierViolation[]> {
  const violations: IdentifierViolation[] = [];
  const seen = new Set<string>();
  const tag = migrationTag(filename);
  for (const identifier of await identifiersIn(sql)) {
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    if (!isAtTruncationSignature(identifier)) continue;
    if (isHistoricallyExempt(identifier, filename)) continue;
    if (LEGITIMATE_LIMIT_NAMES.get(identifier)?.has(tag) === true) continue;
    violations.push({ file: filename, identifier, bytes: Buffer.byteLength(identifier, 'utf8') });
  }
  return violations;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '..');
  const dir = resolve(root, 'packages/db/drizzle');
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`SQL identifier check FAILED: ${dir} is not a directory`);
    process.exit(1);
  }

  const violations: IdentifierViolation[] = [];
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of names) {
    // A migration that does not PARSE is one this gate cannot judge, and
    // reporting it clean would be the silent failure the gate exists to stop.
    try {
      violations.push(
        ...(await findOverlongIdentifiers(name, readFileSync(join(dir, name), 'utf-8'))),
      );
    } catch (error) {
      console.error(`SQL identifier check FAILED — ${name} did not parse:\n  ${String(error)}`);
      process.exit(1);
    }
  }

  if (violations.length > 0) {
    console.error(
      `SQL identifier check FAILED — these sit at Postgres's ${PG_MAX_IDENTIFIER_BYTES}-byte limit,` +
        ' so each is either exactly that long or was TRUNCATED from something longer:',
    );
    for (const violation of violations) {
      console.error(`  - ${violation.file}: "${violation.identifier}" (${violation.bytes} bytes)`);
    }
    console.error(
      '\n  Give the object an EXPLICIT shorter name. For a Drizzle foreign key that means the\n' +
        '  table-level `foreignKey({ columns, foreignColumns, name })` form — inline\n' +
        '  `.references()` cannot name a constraint, so it derives\n' +
        '  `<table>_<column>_<fktable>_<fkcolumn>_fk`, which overflows easily.\n' +
        '\n  If the name is GENUINELY within the limit, declare it in LEGITIMATE_LIMIT_NAMES\n' +
        "  (scripts/check-sql-identifiers.ts). The parser applies the server's own limit, so\n" +
        '  it cannot tell a name that is exactly 63 bytes from one it just cut — the migration\n' +
        "  harness settles that authoritatively by listening for Postgres's truncation NOTICE.",
    );
    process.exit(1);
  }

  console.log(
    `SQL identifier check passed: ${names.length} migrations parsed, no undeclared identifier at the ${PG_MAX_IDENTIFIER_BYTES}-byte limit.`,
  );
}

// Run as a CLI only; importing for tests must not trigger the scan.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('SQL identifier check FAILED to run:', error);
    process.exit(1);
  });
}
