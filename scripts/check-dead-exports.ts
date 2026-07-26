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
// THIS FILE IS POLICY ONLY.  What a file exports, and which sites use each
// export, are questions about the TypeScript language, and they are answered by
// the TypeScript compiler in `resolve-export-references.ts` — not parsed here.
// Both halves were hand-rolled once, over text and then over a token stream, and
// each round of review found another piece of ordinary syntax the parser did not
// model (a generator's `*`, a declarator list, a `const enum`, a block comment
// mid-declaration, `as`/`satisfies`, a `<` comparison, a generic arrow's `<T,>`,
// a template interpolation nested in another).  Every fix was correct and the
// list still had no end, because the list IS the grammar.  What remains here is
// the part that is genuinely this project's to decide:
//
//   • WHICH exports are in scope (values, not types; named, not default);
//   • WHICH files are judged versus merely scanned for references;
//   • what a reasoned entry-point opt-out looks like;
//   • how a finding is reported and what the reader should do about it.
//
// SCOPE: NAMED exported values.  Every shape that publishes one — a
// `function`/`class`/`enum`, each binding of a `const`/`let`/`var` declarator
// list or destructuring pattern, the locals an `export { … }` clause publishes,
// an `export { a as b }` alias, and an `export * as name from '…'` namespace
// binding — is enumerated from the module's export table, so no shape needs a
// pattern of its own.
//
// DEFAULT EXPORTS ARE OUT OF SCOPE, and not as an exemption: `export default`
// publishes the binding `default`, so the declaration's own name is module-local
// and every importer picks its own (`import Anything from './x.js'`, or
// `mod.default` after a dynamic import).  The name is under no obligation to
// appear anywhere else, so its occurrence count says nothing.  Judging a default
// export means asking whether the MODULE is reachable, which is a different
// question from the one this gate answers.
//
// Named exports of a DYNAMICALLY imported module are IN scope.  An earlier cut
// exempted such modules wholesale, on the reasoning that a dynamic import "does
// not name the symbols it goes on to use" — but it does: `mod.createRoom()` and
// `const { createRoom } = await import(…)` both name it, and the resolver
// credits both.  What the whole-module exemption actually did was blank 112
// non-test files, most of them lazily loaded UI, and the only thing it hid
// beyond one default export was a genuinely dead symbol.
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
// A CLUSTER of dead exports that reference each other is still reported one
// layer per run: a dead `f()` that reads a dead `A` keeps `A` referenced until
// `f` goes.  That converges, and the direction is the safe one — it never
// demands the deletion of something still in use.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declarationKey,
  type ExportedBinding,
  type ReferenceSite,
  resolveExportReferences,
} from './resolve-export-references.js';

const ROOT = resolve(import.meta.dirname, '..');

export interface DeadExport {
  file: string;
  name: string;
  kind: string;
  line: number;
}

export interface SourceFile {
  path: string;
  content: string;
  /** True ⇒ scanned for references, never judged ({@link isReferenceOnlyPath}). */
  isTest: boolean;
}

/**
 * An explicit, REASONED opt-out for an export the compiler cannot see a use of.
 *
 * There is exactly one such shape here: a module loaded by URL at RUNTIME.  The
 * two `/src/private-p2p/e2e-*-harness.ts` files are fetched through the Vite dev
 * module graph by a Playwright `page.evaluate`, because a raw evaluate cannot
 * resolve a bare specifier — so no TypeScript import edge exists by
 * construction, and no amount of binding resolution will invent one.
 *
 * Deliberately PER-DECLARATION and reason-bearing, not a path rule and not a
 * whole-module pass: a new export added to one of those harnesses that nothing
 * loads is still reported.  `\S` after the colon makes the reason mandatory —
 * a bare marker is indistinguishable from a mistake.
 */
const ENTRY_MARKER = /(?:\/\/|\/\*|^\s*\*).*dead-exports-entry:\s*\S/;

/** A line that is nothing but comment — how far up {@link isEntryPoint} walks. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*\/?)/;

/** Whether the declaration on `line` (1-based) carries a reasoned entry marker. */
function isEntryPoint(lines: readonly string[], line: number): boolean {
  if (ENTRY_MARKER.test(lines[line - 1] ?? '')) return true;
  for (let i = line - 2; i >= 0; i -= 1) {
    const candidate = lines[i] ?? '';
    if (candidate.trim() === '') continue;
    if (!COMMENT_LINE.test(candidate)) return false;
    if (ENTRY_MARKER.test(candidate)) return true;
  }
  return false;
}

/** How the analyses learn which sites USE a binding. */
export interface ReferenceOracle {
  usesOf(file: string, offset: number): readonly ReferenceSite[];
}

/** The compiler's exports, minus the ones this project declines to judge. */
function* scannableExports(
  exports: readonly ExportedBinding[],
  files: readonly SourceFile[],
): Generator<ExportedBinding> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const lineCache = new Map<string, string[]>();
  for (const declaration of exports) {
    const file = byPath.get(declaration.file);
    if (file === undefined || file.isTest) continue;
    let lines = lineCache.get(file.path);
    if (lines === undefined) {
      lines = file.content.split('\n');
      lineCache.set(file.path, lines);
    }
    if (isEntryPoint(lines, declaration.line)) continue;
    yield declaration;
  }
}

/**
 * Pure: every exported value the oracle finds NO use for.
 *
 * Uses are counted across ALL files including tests — exporting a helper so a
 * unit test can reach it is a legitimate reason to export, and this gate has no
 * business second-guessing it.
 */
export function findDeadExports(
  exports: readonly ExportedBinding[],
  files: readonly SourceFile[],
  oracle: ReferenceOracle,
): DeadExport[] {
  const dead: DeadExport[] = [];
  for (const declaration of scannableExports(exports, files)) {
    if (oracle.usesOf(declaration.file, declaration.offset).length > 0) continue;
    dead.push({
      file: declaration.file,
      name: declaration.name,
      kind: declaration.kind,
      line: declaration.line,
    });
  }
  return dead;
}

/**
 * Pure: every exported value that IS used, but only from the file declaring it —
 * the `export` keyword buys nothing and widens the module's surface.
 *
 * Reported by `--internal-only`, NOT by the default gate and NOT in CI.  The
 * repository has hundreds and they are not one defect repeated: a large share
 * are deliberate API surface (`@licio/shared` is the schema/constant SSOT and
 * `@licio/db` follows Drizzle's export-every-table idiom), and the
 * `Drizzle*`/`InMemory*` store adapters are matched BY THEIR EXPORTED NAME by
 * `check:prod-parity`.  Un-exporting those would be a regression, so the sweep
 * needs per-site judgement and lands as its own work
 * (`docs/planning/audit-residuals-2026-07.md`).
 *
 * Disjoint from {@link findDeadExports}: a symbol used nowhere at all is dead,
 * not internal-only.
 */
export function findInternalOnlyExports(
  exports: readonly ExportedBinding[],
  files: readonly SourceFile[],
  oracle: ReferenceOracle,
): DeadExport[] {
  const internal: DeadExport[] = [];
  for (const declaration of scannableExports(exports, files)) {
    const uses = oracle.usesOf(declaration.file, declaration.offset);
    if (uses.length === 0) continue; // dead, reported by the gate above
    if (uses.some((use) => use.file !== declaration.file)) continue;
    internal.push({
      file: declaration.file,
      name: declaration.name,
      kind: declaration.kind,
      line: declaration.line,
    });
  }
  return internal;
}

/** Generated sources: rewritten by a plugin, so their exports are nobody's to fix. */
function isGeneratedPath(path: string): boolean {
  return path.endsWith('routeTree.gen.ts') || path.endsWith('.generated.ts');
}

/**
 * Files scanned for REFERENCES but never judged.
 *
 * Tests may export fixtures freely, and a generated file's declarations are
 * rewritten by its plugin — but both are real consumers, and dropping either
 * from the corpus would report what only they use as dead (the TanStack router
 * tree is the ONLY consumer of every route module's `Route`).
 *
 * One predicate rather than a rule spelled at each call site: the boot and the
 * analyses have to agree about which files are judged, and they disagreed for
 * exactly as long as generated paths were folded in at the boot alone.
 */
export function isReferenceOnlyPath(path: string): boolean {
  return isTestPath(path) || isGeneratedPath(path);
}

/**
 * Test-ish paths: their own exports are not scanned (references still count).
 *
 * Every pattern is ANCHORED to a directory boundary or a whole file name.  An
 * unanchored `-fixtures` matched anywhere in the path, so
 * `packages/governance/src/schemas/law-pack-fixtures.ts` — production schemas
 * exported from `@licio/governance` and consumed by the treasury readiness and
 * law-pack routes — was classified test-only and never judged.  A gate that
 * silently exempts production files by filename is worse than no gate on them,
 * because the coverage it claims is not the coverage it has.
 */
export function isTestPath(path: string): boolean {
  return (
    /(?:^|\/)__tests__\//.test(path) ||
    /\.(test|spec)\.tsx?$/.test(path) ||
    /(?:^|\/)e2e\//.test(path) ||
    /(?:^|\/)test\//.test(path) ||
    /(?:^|\/)test-vectors\//.test(path) ||
    /(?:^|\/)fixtures\//.test(path) ||
    /(?:^|\/)[\w.-]*test-helpers\.tsx?$/.test(path)
  );
}

/**
 * Enumerate and resolve the corpus, refusing to answer on incomplete input.
 *
 * A tracked file no project's program contains is invisible, and an export used
 * only from such a file would look dead — a FALSE POSITIVE, which is the one
 * failure mode a gate in CI must never have.  A module whose export table
 * cannot be read is the quieter mirror of it: its exports would go unjudged
 * while the gate reported success over them.
 */
function analyze(
  files: readonly SourceFile[],
  judgeRepublished = false,
): {
  exports: readonly ExportedBinding[];
  oracle: ReferenceOracle;
} {
  const resolved = resolveExportReferences({
    files: files.map((file) => file.path),
    judgeRepublished,
  });
  if (resolved.uncovered.length > 0) {
    console.error(
      `check:dead-exports CANNOT RUN — ${resolved.uncovered.length} tracked file(s) belong to no\n` +
        '  TypeScript project, so references from them are invisible and every export they\n' +
        '  alone consume would be reported dead. Add them to a tsconfig `include`:',
    );
    for (const file of resolved.uncovered.slice(0, 20)) console.error(`  - ${file}`);
    process.exit(2);
  }
  if (resolved.unreadable.length > 0) {
    console.error(
      `check:dead-exports CANNOT RUN — ${resolved.unreadable.length} module(s) whose export table\n` +
        '  could not be read. Their exports would go unjudged while the gate reported\n' +
        '  success over them:',
    );
    for (const file of resolved.unreadable.slice(0, 20)) console.error(`  - ${file}`);
    process.exit(2);
  }
  return {
    exports: resolved.exports,
    oracle: {
      usesOf: (file, offset) => resolved.uses.get(declarationKey(file, offset)) ?? [],
    },
  };
}

function main(): void {
  const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter((path) => path.length > 0)
    .filter((path) => !path.includes('/dist/') && !path.endsWith('.d.ts'));

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
    files.push({ path, content, isTest: isReferenceOnlyPath(path) });
  }

  // `--republished` widens the enumeration to UNCHANGED barrel re-exports.
  // Publishing a name is not consuming it, so those bindings are judgeable —
  // but they are ~244 module-barrel entries here, overwhelmingly the deliberate
  // SSOT-surface idiom rather than defects, so they are surveyed and tracked
  // (docs/planning/audit-residuals-2026-07.md) rather than blocking CI.
  const republishedOnly = process.argv.includes('--republished');
  const { exports, oracle } = analyze(files, republishedOnly);

  if (republishedOnly) {
    const stale = findDeadExports(exports, files, oracle);
    if (stale.length > 0) {
      console.error(`${stale.length} exported value(s) nothing references, barrels INCLUDED:`);
      for (const entry of stale) {
        console.error(`  - ${entry.file}:${entry.line}  ${entry.kind} ${entry.name}`);
      }
      console.error(
        '\n  A barrel entry nothing imports THROUGH the barrel is unused public surface —\n' +
          '  but most of these are module barrels publishing their schemas and constants as\n' +
          '  the SSOT surface, the same idiom `@licio/shared` and `@licio/db` follow, whether\n' +
          '  or not a consumer exists today. Judge each on that basis.\n' +
          '  Not run in CI: tracked debt, not a clean baseline\n' +
          '  (docs/planning/audit-residuals-2026-07.md).',
      );
      process.exit(1);
    }
    console.log('No exported value is unreferenced, barrels included.');
    return;
  }

  if (process.argv.includes('--internal-only')) {
    const internal = findInternalOnlyExports(exports, files, oracle);
    if (internal.length > 0) {
      console.error(`${internal.length} exported value(s) used ONLY inside their own file:`);
      for (const entry of internal) {
        console.error(`  - ${entry.file}:${entry.line}  ${entry.kind} ${entry.name}`);
      }
      console.error(
        '\n  Drop the `export` and keep the symbol — UNLESS the export is the point:\n' +
          '    • `@licio/shared` / `@licio/db` publish their schemas, constants and\n' +
          '      tables as the SSOT surface, whether or not a consumer exists today;\n' +
          '    • a `Drizzle*` / `InMemory*` store adapter is matched BY ITS EXPORTED\n' +
          '      NAME by check:prod-parity, so un-exporting one hides it from that gate.\n' +
          '  Not run in CI: the list is tracked debt, not a clean baseline\n' +
          '  (docs/planning/audit-residuals-2026-07.md).',
      );
      process.exit(1);
    }
    console.log('No exported value is confined to its declaring file.');
    return;
  }

  const dead = findDeadExports(exports, files, oracle);
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
