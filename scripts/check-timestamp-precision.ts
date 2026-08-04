// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Timestamp-precision gate — the database may not hold an instant this
// application cannot represent.
//
// `timestamptz` defaults to MICROSECOND precision.  Nothing here can hold one:
// every timestamp is produced by, and read back through, a JavaScript `Date`,
// which is milliseconds.  Those extra three digits are write-only, and the
// mismatch is not inert — it silently deletes rows from paged reads.
//
// A keyset cursor is a value the application read out of the column and sent
// back (`(created_at, id) < (cursor, id)`).  Read through a `Date` it has been
// rounded DOWN, so it names an instant strictly BEFORE the row it came from; in
// a descending page every row sharing that millisecond with more microseconds
// sorts after the cursor and is skipped — permanently, since the next cursor
// moves further away.  The id tiebreaker cannot save it: ids are compared only
// once the timestamps compare EQUAL, which a rounded cursor never does against
// its own row.  And the page just comes back SHORT, which is how a caller
// decides it reached the end — so a moderation-notice DSAR export and a room's
// thread scan each reported themselves complete having dropped rows.
//
// TWO HALVES, BECAUSE EITHER ALONE DRIFTS.  The Drizzle schema is what the
// query builder believes; the migration SQL is what the server actually has.
// A `precision: 3` declaration over a column the migration created bare is a
// column that still holds microseconds while every reader is told otherwise —
// which is worse than neither, because it reads as fixed.  So:
//
//   1. SCHEMA — a `timestamp(…)` call in `packages/db/src/schema/**` is a
//      failure.  `instant()` is the only way to declare one, and it carries the
//      precision.  This is deliberately stricter than "must pass precision: 3":
//      one helper means one place to change, and four schema files had each
//      already written their own local copy of it, which is the whole argument.
//
//   2. MIGRATIONS — a `timestamptz` / `timestamp with time zone` written
//      without `(3)` in `packages/db/drizzle/*.sql` is a failure, in CREATE
//      TABLE, ADD COLUMN and ALTER COLUMN TYPE alike.
//
// The migration half judges the chain from `…_timestamp_millisecond_precision`
// onward, and that is NOT an exemption for what came before.  An applied
// migration is a historical fact — rewriting one changes what a server that
// already ran it is believed to have, which is a worse defect than the one
// being fixed.  The earlier migrations created bare `timestamptz` columns and
// that migration ALTERs every one of them; they are superseded, not excused,
// and the gated integration test is what confirms the resulting state on a real
// server.  The boundary is located by NAME rather than by index so there is no
// list to maintain, and a chain missing that migration is an error, not a pass.
//
// The authoritative check is neither of these: it is the gated integration test
// that asks the SERVER for `datetime_precision` on every column it actually has
// (`timestamp-precision.integration.test.ts`).  A static gate can only read what
// was written down.  This one exists because it runs on every PR without a
// database, and it catches the mistake at the point it is made.
//
// FAIL-CLOSED.  Finding no schema files, or no migrations, or a source that did
// not parse, is an ERROR and not a pass: a gate that reports success over code
// it never read is worth less than no gate, because it is believed.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyntaxKind } from 'typescript/unstable/ast';
import { lineAt, newlineIndex, type ParsedSource, walk, withParsedSources } from './ts-source.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/** The Drizzle column builder that must not be called directly. */
const FORBIDDEN_BUILDER = 'timestamp';

/** Where the one sanctioned call lives. */
const HELPER_FILE = 'packages/db/src/schema/_custom.ts';

/** The migration that establishes the invariant; the chain is judged from here. */
const PRECISION_MIGRATION = '_timestamp_millisecond_precision.sql';

export interface PrecisionFinding {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

/** Schema half: every `timestamp(…)` call outside the helper. */
export function findSchemaDeclarations(sources: readonly ParsedSource[]): PrecisionFinding[] {
  const findings: PrecisionFinding[] = [];
  for (const source of sources) {
    if (source.path === HELPER_FILE) continue;
    const offsets = newlineIndex(source.content);
    for (const node of walk(source.root)) {
      // A call whose callee is the bare identifier `timestamp` — read from the
      // parse, so `timestamp` as a property, a local, or a word in a comment or
      // string is not a hit, and no declaration shape needs a pattern of its own.
      if (node.kind !== SyntaxKind.CallExpression) continue;
      const callee = node.expression;
      if (callee?.kind !== SyntaxKind.Identifier || callee.text !== FORBIDDEN_BUILDER) continue;
      findings.push({
        file: source.path,
        line: lineAt(offsets, node.getStart()),
        detail: `${FORBIDDEN_BUILDER}(…) declares a MICROSECOND column — use instant()`,
      });
    }
  }
  return findings;
}

/** Migration half: a `timestamptz` in SQL that does not pin `(3)`. */
export function findBareMigrationTypes(
  files: readonly { readonly path: string; readonly content: string }[],
): PrecisionFinding[] {
  const findings: PrecisionFinding[] = [];
  // Both spellings Postgres accepts.  `(?!\s*\()` catches the bare form; a
  // wrong precision (e.g. `(6)`) is caught by the explicit alternative.
  const bare =
    /\btimestamptz\b(?!\s*\(\s*3\s*\))|\btimestamp\s+with\s+time\s+zone\b(?!\s*\(\s*3\s*\))/gi;
  for (const { path, content } of files) {
    const lines = content.split('\n');
    for (const [index, raw] of lines.entries()) {
      // Comments explain the migration; they are not DDL.
      const line = raw.replace(/--.*$/, '');
      bare.lastIndex = 0;
      const match = bare.exec(line);
      if (match === null) continue;
      findings.push({
        file: path,
        line: index + 1,
        detail: `${match[0].trim()} without (3) — the column would hold microseconds`,
      });
    }
  }
  return findings;
}

/**
 * Every file under a directory, from the FILESYSTEM.
 *
 * Not `git ls-files <glob>`: git pathspecs are not shell globs, and
 * `…/schema/ ** /*.ts` matched only the one file that happens to sit in a
 * subdirectory — so the first cut of this gate read 1 of 35 schema files and
 * printed "passed".  Its own emptiness guard let that through, because 1 is not
 * 0.  A directory walk has no pattern to get wrong, and it sees a file that is
 * written but not yet staged — which is precisely when a gate is most useful.
 */
const filesUnder = (dir: string, ext: string): string[] => {
  const walkDir = (at: string): string[] =>
    readdirSync(resolve(ROOT, at), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walkDir(`${at}/${entry.name}`)
        : entry.name.endsWith(ext)
          ? [`${at}/${entry.name}`]
          : [],
    );
  return walkDir(dir).sort();
};

async function main(): Promise<void> {
  const schemaPaths = filesUnder('packages/db/src/schema', '.ts').filter(
    (path) => !path.endsWith('.test.ts'),
  );
  const allMigrations = filesUnder('packages/db/drizzle', '.sql');

  // The chain from the migration that establishes the invariant.  Its absence
  // is an error: it would mean the ALTERs that make the earlier migrations
  // superseded are gone, so judging only the tail would report a pass over a
  // database still holding microseconds.
  const boundary = allMigrations.findIndex((path) => path.endsWith(PRECISION_MIGRATION));
  if (boundary === -1) {
    throw new Error(
      `no migration ending ${PRECISION_MIGRATION} — the chain that narrows every existing column is missing; refusing to pass`,
    );
  }
  const migrationPaths = allMigrations.slice(boundary);

  // Fail-closed: an empty side means the globs stopped matching, not that the
  // code is clean.  Reporting a pass there is the failure mode this gate is
  // guarding against everywhere else.
  if (schemaPaths.length === 0) {
    throw new Error('no schema sources matched packages/db/src/schema/**.ts — refusing to pass');
  }
  if (migrationPaths.length === 0) {
    throw new Error('no migrations matched packages/db/drizzle/*.sql — refusing to pass');
  }

  const read = (path: string) => ({ path, content: readFileSync(resolve(ROOT, path), 'utf-8') });
  const schemaSources = schemaPaths.map(read);
  const migrations = migrationPaths.map(read);

  const findings = [
    ...withParsedSources(schemaSources, (parsed) => findSchemaDeclarations(parsed)),
    ...findBareMigrationTypes(migrations),
  ];

  if (findings.length > 0) {
    console.error(
      `check:timestamp-precision FAILED — ${findings.length} column(s) at microsecond precision:`,
    );
    for (const finding of findings) {
      console.error(`  - ${finding.file}:${finding.line}  ${finding.detail}`);
    }
    console.error(
      '\n  A `timestamptz` defaults to MICROSECONDS, which no JavaScript `Date` can\n' +
        '  hold — so a keyset cursor read back from the column names an instant just\n' +
        '  BEFORE its own row, and every row sharing that millisecond is dropped from\n' +
        '  the next page.  The page comes back short, which is exactly how a caller\n' +
        '  decides it has reached the end.\n\n' +
        `  In a schema file: use instant('col') from ./_custom.js.\n` +
        '  In a migration: write timestamptz(3).',
    );
    process.exit(1);
  }

  console.log(
    `check:timestamp-precision passed: ${schemaSources.length} schema sources and ${migrations.length} migrations declare milliseconds only.`,
  );
}

// Run as a CLI only; importing for tests must not trigger the scan.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('check:timestamp-precision FAILED to run:', error);
    process.exit(1);
  });
}
