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
  `^[ \\t]*export[ \\t]+(?:default[ \\t]+)?(?:declare[ \\t]+)?(?:abstract[ \\t]+)?(?:async[ \\t]+)?(${VALUE_KEYWORDS.join('|')})[ \\t]+([A-Za-z_$][\\w$]*)`,
  'gm',
);

export interface ExportedValue {
  name: string;
  kind: string;
  line: number;
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

/** Every exported value declared in one source file. */
export function exportedValues(source: string): ExportedValue[] {
  const out: ExportedValue[] = [];
  EXPORTED_VALUE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = EXPORTED_VALUE_RE.exec(source);
  while (match !== null) {
    const kind = match[1];
    const name = match[2];
    if (kind !== undefined && name !== undefined) {
      out.push({
        name,
        kind,
        line: source.slice(0, match.index).split('\n').length,
        selfOccurrences: 1,
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
        });
      }
    }
    clause = EXPORT_CLAUSE_RE.exec(source);
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

/** Normalize a repo-relative path: collapse `.`/`..` and drop the extension. */
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/').replace(/\.(tsx?|jsx?)$/, '');
}

/**
 * The repo-relative, extension-less paths of every module reached DYNAMICALLY —
 * `import('./X.js')`, or a bare quoted `/src/…` path (how a Playwright
 * `page.evaluate` block loads an in-page harness).  Neither form names the
 * symbols it goes on to use, so a word scan cannot see them.
 *
 * Specifiers are RESOLVED against the importing file rather than reduced to a
 * basename.  Keying on the basename meant one `import('../meri/index.js')`
 * exempted every `index.ts` in the repository — and `index`, `service`,
 * `routes`, `types` are exactly the names a monorepo repeats — silently
 * disabling the gate across most of the tree.
 *
 * A STATIC `import { x } from './X.js'` is NOT included: it spells out every
 * symbol it takes, so the word scan already covers it.  A BARE specifier
 * (`@licio/private-p2p`) is skipped too — a package entry point is reached
 * through its own exports, which the scan sees.
 */
export function dynamicallyImportedModules(
  files: ReadonlyArray<{ path: string; content: string }>,
): Set<string> {
  const modules = new Set<string>();
  const dynamicImport = /import\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const absoluteSrc = /['"`](\/src\/[^'"`]+)['"`]/g;
  for (const file of files) {
    const dir = file.path.split('/').slice(0, -1).join('/');
    dynamicImport.lastIndex = 0;
    for (const match of file.content.matchAll(dynamicImport)) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith('.')) continue;
      modules.add(normalizePath(`${dir}/${specifier}`));
    }
    absoluteSrc.lastIndex = 0;
    for (const match of file.content.matchAll(absoluteSrc)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      // `/src/…` is served by the Vite dev server, so it is rooted at apps/web.
      modules.add(normalizePath(`apps/web${specifier}`));
    }
  }
  return modules;
}

/** A file's repo-relative, extension-less path, as the set above reports it. */
export function moduleKeyOf(file: string): string {
  return normalizePath(file);
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
  const dynamicModules = dynamicallyImportedModules(files);
  // ONE pass over the corpus building an identifier→count table, rather than
  // re-scanning every file per declaration.  The naive form is
  // O(declarations × bytes) — thousands of exports against a ~13 MB corpus —
  // which took long enough that the gate's own test timed out.
  //
  // Counted over CODE ONLY: a declaration's own JSDoc almost always names it, so
  // counting prose would let every documented export pass with no consumer.
  const occurrences = new Map<string, number>();
  for (const file of files) {
    for (const [name, count] of identifierCounts(file.content)) {
      occurrences.set(name, (occurrences.get(name) ?? 0) + count);
    }
  }

  const dead: DeadExport[] = [];
  for (const file of files) {
    if (file.isTest) continue;
    if (dynamicModules.has(moduleKeyOf(file.path))) continue;
    for (const declaration of exportedValues(file.content)) {
      // At or below the declaration's own footprint means nothing USES it.
      if ((occurrences.get(declaration.name) ?? 0) <= declaration.selfOccurrences) {
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
