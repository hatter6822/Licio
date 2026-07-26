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
// SCOPE: NAMED exported values — `const`/`let`/`var`/`function`/`class`/`enum`,
// the local values an `export { … }` clause publishes, and the binding an
// `export * as name from '…'` namespace re-export publishes (that last one is a
// runtime name no declaration keyword introduces, so it needs its own pattern —
// a plain `export * from` does NOT, since those names keep the spelling they are
// already scanned under).
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
// `const { createRoom } = await import(…)` both spell the name, so the scan sees
// them exactly as it sees a static import.  What the whole-module exemption
// actually did was blank 112 non-test files, most of them lazily loaded UI, and
// the only thing it hid beyond one default export was a genuinely dead symbol.
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
// CODE outside its own declaration.  Comments and string literals are stripped
// first — a JSDoc naming the symbol it documents is the most common thing
// written next to a declaration, and counting it would let every documented
// export pass with no consumer.  A name that collides with an unrelated symbol
// still hides a dead export, but that is a false NEGATIVE, which merely lets one
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
import { interpolationSpans, type Token, tokenize } from './js-sink-analyzer.js';

const ROOT = resolve(import.meta.dirname, '..');

/** Declaration keywords whose exports carry runtime weight. */
const VALUE_KEYWORDS = ['const', 'let', 'var', 'function', 'class', 'enum'] as const;

// `[ \t]*` rather than `\s*`: with the `m` flag a `\s*` would let the match
// START on the preceding newline, putting every reported line number one early.
const EXPORTED_VALUE_RE = new RegExp(
  `^[ \\t]*export[ \\t]+(default[ \\t]+)?(?:declare[ \\t]+)?(?:abstract[ \\t]+)?(?:async[ \\t]+)?(${VALUE_KEYWORDS.join('|')})[ \\t]+([A-Za-z_$][\\w$]*)`,
  'gm',
);

export interface ExportedValue {
  name: string;
  kind: string;
  line: number;
  /**
   * `export default …` — the published binding is `default`, not this name.
   *
   * The declaration name is MODULE-LOCAL: every importer chooses its own
   * (`import Anything from './x.js'`, or `mod.default` after a dynamic import),
   * so the name need never appear outside the file even when the module is used
   * constantly.  An identifier scan cannot judge these, so it does not try.
   */
  isDefault: boolean;
  /**
   * How many times the name occurs in its own DECLARATION — the baseline a real
   * reference has to exceed.
   *
   * `export const X` writes `X` once.  `export { X }` writes it once in the
   * clause AND once at the local declaration the clause publishes, so two
   * occurrences still mean "nothing uses it".  `export { local as X }` writes
   * the exported name only in the clause, so one.
   */
  selfOccurrences: number;
}

/**
 * `export { a, b as c }` WITHOUT a `from` — a clause publishing local values.
 *
 * A re-export (`export { x } from './y.js'`) is deliberately NOT matched: it is
 * barrel plumbing, and the underlying declaration is already scanned where it
 * lives.  `export type { … }` and `type` specifiers inside a clause are skipped
 * — types are out of scope by the policy above.
 */
const EXPORT_CLAUSE_RE = /^[ \t]*export[ \t]*\{([^}]*)\}[ \t]*(?!from)[;\s]*$/gm;

/**
 * `export * as name from './x.js'` — a NAMESPACE re-export.
 *
 * Unlike the plain `export * from` beside it, this publishes one named runtime
 * binding (`name`, a module-namespace object), and no declaration keyword
 * introduces it — so neither the keyword pattern nor the clause parser sees it,
 * and a dead one would slip through.  Consumers spell the name (`queue.enqueue`
 * after `import { queue } from '…'`), so the ordinary identifier scan judges it
 * once it is reported.
 *
 * `export * from './x.js'` stays out: it republishes names under their own
 * spelling, each already scanned at the declaration it comes from — the same
 * reasoning that excludes `export { x } from './y.js'`.
 */
const EXPORT_NAMESPACE_RE = /^[ \t]*export[ \t]+\*[ \t]+as[ \t]+([A-Za-z_$][\w$]*)[ \t]+from\b/gm;

/** Every exported value declared in one source file. */
export function exportedValues(source: string): ExportedValue[] {
  const out: ExportedValue[] = [];
  EXPORTED_VALUE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = EXPORTED_VALUE_RE.exec(source);
  while (match !== null) {
    const kind = match[2];
    const name = match[3];
    if (kind !== undefined && name !== undefined) {
      out.push({
        name,
        kind,
        line: source.slice(0, match.index).split('\n').length,
        selfOccurrences: 1,
        isDefault: match[1] !== undefined,
      });
    }
    match = EXPORTED_VALUE_RE.exec(source);
  }

  EXPORT_CLAUSE_RE.lastIndex = 0;
  let clause: RegExpExecArray | null = EXPORT_CLAUSE_RE.exec(source);
  while (clause !== null) {
    const body = clause[1] ?? '';
    const line = source.slice(0, clause.index).split('\n').length;
    // `export type { … }` publishes only types.
    if (!/^[ \t]*export[ \t]+type\b/.test(clause[0])) {
      for (const raw of body.split(',')) {
        const specifier = raw.trim();
        if (specifier.length === 0 || /^type\s/.test(specifier)) continue;
        const parts = specifier.split(/\s+as\s+/);
        const local = (parts[0] ?? '').trim();
        const exported = (parts[1] ?? local).trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(exported) || exported === 'default') continue;
        out.push({
          name: exported,
          kind: 'export',
          line,
          // An UNALIASED specifier repeats the local declaration's name, so the
          // name occurs twice before any real use.
          selfOccurrences: exported === local ? 2 : 1,
          // `export { x as default }` is filtered out above, so a clause
          // specifier that reaches here always publishes its own name.
          isDefault: false,
        });
      }
    }
    clause = EXPORT_CLAUSE_RE.exec(source);
  }

  EXPORT_NAMESPACE_RE.lastIndex = 0;
  let namespace: RegExpExecArray | null = EXPORT_NAMESPACE_RE.exec(source);
  while (namespace !== null) {
    const name = namespace[1];
    // `export * as default from '…'` is legal ES2020 and publishes `default`,
    // whose name is module-local at every importer — out of scope like any other
    // default export.
    if (name !== undefined && name !== 'default') {
      out.push({
        name,
        kind: 'namespace',
        line: source.slice(0, namespace.index).split('\n').length,
        // The name is written ONCE, in the clause; the specifier beside it is a
        // string literal, which the identifier scan does not count.
        selfOccurrences: 1,
        isDefault: false,
      });
    }
    namespace = EXPORT_NAMESPACE_RE.exec(source);
  }
  return out;
}

/**
 * Every IDENTIFIER occurrence in one source, as code — comments, strings, regex
 * literals and template TEXT excluded, template INTERPOLATIONS included.
 *
 * Lexed with the repo's existing tokeniser (`js-sink-analyzer.ts`) rather than a
 * second hand-rolled stripper.  A naive one is not merely imprecise, it is
 * WRONG in the dangerous direction: this file's own regexes contain quote
 * characters (`/['"`]/`), so a stripper that does not understand regex literals
 * treats one as an unterminated string and swallows the code after it — turning
 * live symbols into false "dead" reports that would block a correct branch.
 * The tokeniser already handles all four constructs, and its `preferRegex`
 * dual-pass resolves the one genuinely undecidable `/` case; both passes are
 * unioned by taking the HIGHER count, so a mis-lex can only over-count (a false
 * negative — safe) and never under-count.
 */
export function identifierCounts(source: string): Map<string, number> {
  const best = new Map<string, number>();
  for (const preferRegex of [false, true]) {
    const pass = new Map<string, number>();
    const add = (name: string): void => pass.set(name, (pass.get(name) ?? 0) + 1);
    const walk = (tokens: readonly Token[]): void => {
      for (const token of tokens) {
        if (token.kind === 'ident') add(token.value);
        else if (token.kind === 'template' && token.value.includes('${')) {
          // Only the `${…}` bodies are code; the literal chunks between them are
          // prose and stay excluded.
          for (const span of interpolationSpans(token.value, 0, preferRegex)) {
            walk(tokenize(span.text, preferRegex));
          }
        }
      }
    };
    walk(tokenize(source, preferRegex));
    for (const [name, count] of pass) best.set(name, Math.max(best.get(name) ?? 0, count));
  }
  return best;
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
 * Identifier counts per file and summed across the corpus.
 *
 * ONE pass building the tables, rather than re-scanning every file per
 * declaration.  The naive form is O(declarations × bytes) — thousands of exports
 * against a ~13 MB corpus — which took long enough that the gate's own test
 * timed out.
 *
 * Counted over CODE ONLY: a declaration's own JSDoc almost always names it, so
 * counting prose would let every documented export pass with no consumer.
 */
function indexCorpus(files: readonly SourceFile[]): {
  perFile: Map<string, Map<string, number>>;
  total: Map<string, number>;
} {
  const perFile = new Map<string, Map<string, number>>();
  const total = new Map<string, number>();
  for (const file of files) {
    const counts = identifierCounts(file.content);
    perFile.set(file.path, counts);
    for (const [name, count] of counts) total.set(name, (total.get(name) ?? 0) + count);
  }
  return { perFile, total };
}

/** Exported values of a non-test file that are in scope for either analysis. */
function* scannableDeclarations(
  files: readonly SourceFile[],
): Generator<{ file: SourceFile; declaration: ExportedValue }> {
  for (const file of files) {
    if (file.isTest) continue;
    for (const declaration of exportedValues(file.content)) {
      // A default export's name is module-local (see `ExportedValue.isDefault`),
      // so its occurrence count carries no information either way.
      if (declaration.isDefault) continue;
      yield { file, declaration };
    }
  }
}

/**
 * Pure: every exported value referenced NOWHERE but its own declaration.
 *
 * References are counted across ALL files including tests — exporting a helper
 * so a unit test can reach it is a legitimate reason to export, and this gate
 * has no business second-guessing it.
 */
export function findDeadExports(files: readonly SourceFile[]): DeadExport[] {
  const { total } = indexCorpus(files);
  const dead: DeadExport[] = [];
  for (const { file, declaration } of scannableDeclarations(files)) {
    // At or below the declaration's own footprint means nothing USES it.
    if ((total.get(declaration.name) ?? 0) <= declaration.selfOccurrences) {
      dead.push({
        file: file.path,
        name: declaration.name,
        kind: declaration.kind,
        line: declaration.line,
      });
    }
  }
  return dead;
}

/**
 * Pure: every exported value USED, but only inside the file that declares it —
 * the `export` keyword buys nothing and widens the module's surface.
 *
 * Reported by `--internal-only`, NOT by the default gate and NOT in CI.  The
 * repository has ~894 of these and they are not one defect repeated: a large
 * share are deliberate API surface (`@licio/shared` is the schema/constant SSOT
 * and `@licio/db` follows Drizzle's export-every-table idiom), and 56 are the
 * `Drizzle*`/`InMemory*` store adapters whose EXPORTED name is what
 * `check:prod-parity` matches on.  Un-exporting those would be a regression, so
 * the sweep needs per-site judgement and lands as its own work
 * (`docs/planning/audit-residuals-2026-07.md`).  This mode exists so that debt
 * is a command rather than a memory, and it already exits non-zero so it can
 * become a gate the day the list is empty.
 *
 * Disjoint from {@link findDeadExports}: a symbol used nowhere at all is dead,
 * not internal-only, and is reported there instead.
 */
export function findInternalOnlyExports(files: readonly SourceFile[]): DeadExport[] {
  const { perFile, total } = indexCorpus(files);
  const internal: DeadExport[] = [];
  for (const { file, declaration } of scannableDeclarations(files)) {
    const own = perFile.get(file.path)?.get(declaration.name) ?? 0;
    // Used somewhere (else it is DEAD, reported by the gate above) …
    if (own <= declaration.selfOccurrences) continue;
    // … and every occurrence in the corpus is one of this file's own.
    if ((total.get(declaration.name) ?? 0) !== own) continue;
    internal.push({
      file: file.path,
      name: declaration.name,
      kind: declaration.kind,
      line: declaration.line,
    });
  }
  return internal;
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

  if (process.argv.includes('--internal-only')) {
    const internal = findInternalOnlyExports(files);
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
