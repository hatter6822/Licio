// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unreferenced-export gate.
//
// An exported VALUE that nothing references is not neutral: it is compiled,
// linted, type-checked, reviewed and (in `apps/web`) bundled, and it is a trap —
// the next reader assumes a helper that sits next to live code is the way to do
// the thing, when it may have been superseded years ago.  Worse, several of the
// ones this repo accumulated were not leftovers at all but UNWIRED GUARANTEES:
// a doctrine constant (`CO_APPROVAL_CAPABILITIES`) that no gate consulted, a
// client call (`verifyTotp`) for a capability no UI could reach, a validated
// prefix spelled twice.  "Nothing references it" is exactly the signal that
// separates those from working code, which is why it is worth a gate.
//
// SCOPE: exported values — `const`/`let`/`var`/`function`/`class`/`enum`.
//
// TYPES ARE DELIBERATELY OUT OF SCOPE.  A `type`/`interface` is erased at build:
// it costs no bytes and no runtime behaviour.  Nearly all of this repo's
// unreferenced types are MECHANICAL PROJECTIONS of a value that IS live — a
// `z.infer<typeof xSchema>` beside its schema, a `typeof table.$inferSelect`
// beside its Drizzle table, a `(typeof CONST_ARRAY)[number]`.  Those are
// idiomatic and, more to the point, UNIFORM: every table having a `Row` type is
// a property worth more than the absence of the handful nothing imports yet,
// and pruning to only-the-used ones would make the surface arbitrary.
//
// The analysis is intentionally simple and errs toward SILENCE: an identifier is
// "referenced" if it appears as a whole word anywhere in the tracked TypeScript
// outside its own declaration line.  A name that collides with an unrelated
// symbol therefore hides a dead export — a false NEGATIVE, which merely lets one
// through, rather than a false positive that would block a correct branch.
//
// A CLUSTER of dead exports that reference each other is reported one layer per
// run: a dead `f()` that reads a dead `A` keeps `A` "referenced" until `f` goes.
// That converges (each run removes a layer) and the direction is the safe one —
// it never demands the deletion of something still in use.
//
// Deliberately dependency-free so the `scripts`-rooted vitest project can unit
// test the pure core directly.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');

/** Declaration keywords whose exports carry runtime weight. */
const VALUE_KEYWORDS = ['const', 'let', 'var', 'function', 'class', 'enum'] as const;

// `[ \t]*` rather than `\s*`: with the `m` flag a `\s*` would let the match
// START on the preceding newline, putting every reported line number one early.
const EXPORTED_VALUE_RE = new RegExp(
  `^[ \\t]*export[ \\t]+(?:default[ \\t]+)?(?:declare[ \\t]+)?(?:abstract[ \\t]+)?(?:async[ \\t]+)?(${VALUE_KEYWORDS.join('|')})[ \\t]+([A-Za-z_$][\\w$]*)`,
  'gm',
);

export interface ExportedValue {
  name: string;
  kind: string;
  line: number;
}

/** Every exported value declared in one source file. */
export function exportedValues(source: string): ExportedValue[] {
  const out: ExportedValue[] = [];
  EXPORTED_VALUE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = EXPORTED_VALUE_RE.exec(source);
  while (match !== null) {
    const kind = match[1];
    const name = match[2];
    if (kind !== undefined && name !== undefined) {
      out.push({ name, kind, line: source.slice(0, match.index).split('\n').length });
    }
    match = EXPORTED_VALUE_RE.exec(source);
  }
  return out;
}

/**
 * Whether a module is reached DYNAMICALLY — `import('…/stem.js')`, or a bare
 * quoted `/src/…/stem.ts` path (how a Playwright `page.evaluate` block loads an
 * in-page harness).  Neither form names the symbols it goes on to use, so a
 * word scan cannot see them and such a module must be exempt.
 *
 * A STATIC `import { x } from './stem.js'` is NOT this: it spells out every
 * symbol it takes, so the word scan already covers it.
 */
export function dynamicallyImportedStems(sources: Iterable<string>): Set<string> {
  const stems = new Set<string>();
  const patterns = [/import\s*\(\s*['"`]([^'"`]+)['"`]/g, /['"`](\/src\/[^'"`]+)['"`]/g];
  for (const source of sources) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        const stem = (specifier.split('/').pop() ?? '').replace(/\.(js|ts|tsx|jsx)$/, '');
        if (stem.length > 0) stems.add(stem);
      }
    }
  }
  return stems;
}

/** A file's stem, as `dynamicallyImportedStems` reports it. */
export function stemOf(file: string): string {
  return (file.split('/').pop() ?? '').replace(/\.(tsx?|jsx?)$/, '');
}

export interface DeadExport {
  file: string;
  name: string;
  kind: string;
  line: number;
}

export interface SourceFile {
  path: string;
  content: string;
  /** Declarations here are scanned only when false (tests may export freely). */
  isTest: boolean;
}

/**
 * Pure: every exported value referenced NOWHERE but its own declaration.
 *
 * References are counted across ALL files including tests — exporting a helper
 * so a unit test can reach it is a legitimate reason to export, and this gate
 * has no business second-guessing it.
 */
export function findDeadExports(files: readonly SourceFile[]): DeadExport[] {
  const dynamicStems = dynamicallyImportedStems(files.map((f) => f.content));
  // ONE pass over the corpus building an identifier→count table, rather than
  // re-scanning every file per declaration.  The naive form is
  // O(declarations × bytes) — thousands of exports against a ~13 MB corpus —
  // which took long enough that the gate's own test timed out.
  const occurrences = new Map<string, number>();
  const identifier = /[A-Za-z_$][\w$]*/g;
  for (const file of files) {
    for (const match of file.content.matchAll(identifier)) {
      const word = match[0];
      occurrences.set(word, (occurrences.get(word) ?? 0) + 1);
    }
  }

  const dead: DeadExport[] = [];
  for (const file of files) {
    if (file.isTest) continue;
    if (dynamicStems.has(stemOf(file.path))) continue;
    for (const declaration of exportedValues(file.content)) {
      // Exactly one occurrence repo-wide IS the declaration itself.
      if ((occurrences.get(declaration.name) ?? 0) <= 1) {
        dead.push({
          file: file.path,
          name: declaration.name,
          kind: declaration.kind,
          line: declaration.line,
        });
      }
    }
  }
  return dead;
}

/** Test-ish paths: their own exports are not scanned (references still count). */
export function isTestPath(path: string): boolean {
  return (
    /(?:^|\/)__tests__\//.test(path) ||
    /\.(test|spec)\.tsx?$/.test(path) ||
    /(?:^|\/)e2e\//.test(path) ||
    /(?:^|\/)test\//.test(path) ||
    /test-helpers|test-vectors|-fixtures|(?:^|\/)fixtures\//.test(path)
  );
}

function main(): void {
  const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter((path) => path.length > 0)
    .filter((path) => !path.includes('/dist/') && !path.endsWith('.d.ts'))
    // Generated: the router tree is rewritten by the TanStack plugin.
    .filter((path) => !path.endsWith('routeTree.gen.ts'));

  // `git ls-files` reports paths git TRACKS, which during a refactor includes a
  // file already removed from the working tree.  Skip what cannot be read rather
  // than crashing — a gate that dies mid-refactor is a gate people disable.
  const files: SourceFile[] = [];
  for (const path of tracked) {
    let content: string;
    try {
      content = readFileSync(resolve(ROOT, path), 'utf-8');
    } catch {
      continue;
    }
    files.push({ path, content, isTest: isTestPath(path) });
  }

  const dead = findDeadExports(files);
  if (dead.length > 0) {
    console.error(
      `check:dead-exports FAILED — ${dead.length} exported value(s) nothing references:`,
    );
    for (const entry of dead) {
      console.error(`  - ${entry.file}:${entry.line}  ${entry.kind} ${entry.name}`);
    }
    console.error(
      '\n  Each is one of three things. Decide WHICH before acting:\n' +
        '    1. An unwired guarantee — a doctrine constant, limit, or client call that\n' +
        '       SHOULD be consulted somewhere. Wire it up (CLAUDE.md implement-the-\n' +
        '       improvement rule); do not delete the evidence of a missing gate.\n' +
        '    2. One of two spellings of a live value. Make this one the single source\n' +
        '       and delete the duplicate literal, not the documented constant.\n' +
        '    3. Genuinely vestigial. Delete it.\n' +
        '  If it is used only INSIDE its file, drop the `export` keyword instead.',
    );
    process.exit(1);
  }

  console.log(
    `check:dead-exports passed: ${files.filter((f) => !f.isTest).length} source files, every exported value is referenced.`,
  );
}

// Run as a CLI only; importing for tests must not trigger the scan.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
