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
// SCOPE: NAMED exported values, in all four shapes that publish one —
//   • `function`/`class`/`enum`, which name themselves after the keyword
//     (generators included: `function*` puts a `*` where a space would go);
//   • `const`/`let`/`var`, walked as a DECLARATOR LIST rather than a single
//     name, so `export const live = 1, other = 2` and `export const { a, b } =
//     obj` publish every binding they introduce, not just the first;
//   • the local values an `export { … }` clause publishes;
//   • the binding an `export * as name from '…'` namespace re-export publishes
//     — a runtime name no declaration keyword introduces, so it needs its own
//     pattern.  A plain `export * from` does NOT: those names keep the spelling
//     they are already scanned under.
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

/**
 * Declaration keywords whose exports carry runtime weight, split by SHAPE.
 *
 * A `function`/`class`/`enum` introduces exactly one name and it follows the
 * keyword, so a pattern reads it.  A `const`/`let`/`var` introduces a
 * DECLARATOR LIST — `export const live = 1, other = 2`, or a destructuring
 * pattern — and reading only the first name leaves every later binding outside
 * the gate even though each is a named runtime export.  Those are walked over
 * the token stream instead ({@link declarationBindings}).
 */
const NAMED_DECLARATION_KEYWORDS = ['function', 'class', 'enum'] as const;
const BINDING_KEYWORDS = ['const', 'let', 'var'] as const;

/** A runaway guard: no real declarator list is anywhere near this long. */
const MAX_DECLARATOR_TOKENS = 4096;

/**
 * Every name a declarator list BINDS, from the tokens after its keyword.
 *
 * Handles the two shapes a single-name pattern cannot see — a comma list
 * (`export const live = 1, other = 2`) and a destructuring pattern
 * (`export const { a, b: renamed } = obj`) — while skipping what only LOOKS
 * like a binding: a TypeScript annotation after `:`, an initializer after `=`,
 * a property key before `:` inside a pattern, and a default value inside one.
 *
 * Where it is unsure it MISSES a binding rather than inventing one.  The angle
 * counter is the case: `<`/`>` are counted while skipping an annotation so the
 * comma in `Map<string, number>` does not read as a declarator separator, and a
 * genuine `<` comparison in an initializer inflates it — which ends the walk
 * early.  That direction can only produce a false NEGATIVE (a dead export goes
 * unreported); the opposite would invent a name and fail a correct branch.
 */
function declarationBindings(
  tokens: readonly Token[],
): Array<{ readonly name: string; readonly start: number }> {
  const names: Array<{ name: string; start: number }> = [];
  let depth = 0; // (), [], {}
  let angle = 0; // <> — counted only while skipping
  let taking = true; // in a BINDING position, rather than skipping to the next
  let patternDepth = 0; // >0 while inside this declarator's destructuring pattern

  for (let i = 0; i < tokens.length && i < MAX_DECLARATOR_TOKENS; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;

    if (token.kind !== 'punct') {
      if (token.kind !== 'ident' || !taking) continue;
      // Inside a pattern, `key:` names a PROPERTY — the binding follows the `:`.
      const next = tokens[i + 1];
      if (patternDepth > 0 && next?.kind === 'punct' && next.value === ':') continue;
      names.push({ name: token.value, start: token.start });
      // A plain binding closes the window until the next declarator; a pattern
      // stays open, since it introduces several.
      if (patternDepth === 0) taking = false;
      continue;
    }

    const punct = token.value;
    if (punct === '(' || punct === '[' || punct === '{') {
      depth += 1;
      if (taking && patternDepth === 0 && punct !== '(') patternDepth = depth;
      continue;
    }
    if (punct === ')' || punct === ']' || punct === '}') {
      depth = Math.max(0, depth - 1);
      if (patternDepth > 0 && depth < patternDepth) {
        patternDepth = 0;
        taking = false; // the pattern is complete; its `=` initializer follows
      }
      continue;
    }
    if (depth === 0 && punct === ';') break;
    if (patternDepth > 0 && depth >= patternDepth) {
      if (punct === '=')
        taking = false; // a DEFAULT value inside the pattern
      else if (punct === ',') taking = true;
      continue;
    }
    if (depth !== 0) continue;
    if (!taking) {
      if (punct === '<') angle += 1;
      else if (punct === '>') angle = Math.max(0, angle - 1);
      else if (punct === ',' && angle === 0) taking = true;
      continue;
    }
    // At a binding position, `:` opens an annotation and `=` an initializer.
    if (punct === ':' || punct === '=') taking = false;
  }
  return names;
}

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

/** `export declare …`, `export abstract class …`, `export async function …`. */
const DECLARATION_MODIFIERS = new Set(['declare', 'abstract', 'async']);

/** Keyword sets, as lookups over the token stream. */
const NAMED_KEYWORDS: ReadonlySet<string> = new Set(NAMED_DECLARATION_KEYWORDS);
const BINDING_KEYWORD_SET: ReadonlySet<string> = new Set(BINDING_KEYWORDS);

/**
 * Every exported value in one lexing of a source, parsed from the TOKEN STREAM.
 *
 * Written against tokens rather than raw text because the text approach kept
 * losing to valid syntax it had not anticipated — a generator's `*`, a
 * declarator list, a `const enum`, and finally a BLOCK COMMENT in the middle of
 * a declaration.  A comment is legal between `export` and `const`, and between
 * a clause's braces beside a specifier; both are ordinary TypeScript that a
 * whitespace-and-identifier pattern cannot see, and an unreferenced export
 * hiding behind one would pass the gate.  The lexer already discards comments
 * and already knows what a string, a template and a regex are, so parsing from
 * its output ends that whole class of miss rather than patching one more form.
 *
 * `export` is taken as a declaration keyword unless it is plainly something
 * else: a property read (`obj.export`) or an object key (`{ export: 1 }`).
 */
function parseExportedValues(
  source: string,
  tokens: readonly Token[],
): Array<{ value: ExportedValue; start: number }> {
  const out: Array<{ value: ExportedValue; start: number }> = [];
  const identAt = (index: number): string | null => {
    const token = tokens[index];
    return token?.kind === 'ident' ? token.value : null;
  };
  const punctAt = (index: number): string | null => {
    const token = tokens[index];
    return token?.kind === 'punct' ? token.value : null;
  };
  const emit = (
    name: string,
    kind: string,
    start: number,
    selfOccurrences: number,
    isDefault: boolean,
  ): void => {
    out.push({
      value: {
        name,
        kind,
        line: source.slice(0, start).split('\n').length,
        selfOccurrences,
        isDefault,
      },
      start,
    });
  };

  for (let i = 0; i < tokens.length; i += 1) {
    if (identAt(i) !== 'export') continue;
    const before = punctAt(i - 1);
    if (before === '.' || before === '?.') continue; // a property read
    if (punctAt(i + 1) === ':') continue; // an object key

    let j = i + 1;
    const isDefault = identAt(j) === 'default';
    if (isDefault) j += 1;
    while (DECLARATION_MODIFIERS.has(identAt(j) ?? '')) j += 1;

    const keyword = identAt(j);
    // TYPES are out of scope in every spelling — see the policy above.
    if (keyword === 'type' || keyword === 'interface') continue;

    // `const enum X`: the `const` belongs to the ENUM, not to a binding list.
    if (keyword === 'const' && identAt(j + 1) === 'enum') {
      const name = identAt(j + 2);
      const at = tokens[j + 2]?.start;
      if (name !== null && at !== undefined) emit(name, 'enum', at, 1, isDefault);
      continue;
    }

    if (keyword !== null && NAMED_KEYWORDS.has(keyword)) {
      // A GENERATOR puts a `*` between the keyword and the name.
      const k = punctAt(j + 1) === '*' ? j + 2 : j + 1;
      const name = identAt(k);
      const at = tokens[k]?.start;
      if (name !== null && at !== undefined) emit(name, keyword, at, 1, isDefault);
      continue;
    }

    if (keyword !== null && BINDING_KEYWORD_SET.has(keyword)) {
      // A declarator LIST: every binding it introduces, not just the first.
      const slice = tokens.slice(j + 1, j + 1 + MAX_DECLARATOR_TOKENS);
      for (const binding of declarationBindings(slice)) {
        emit(binding.name, keyword, binding.start, 1, false);
      }
      continue;
    }

    if (punctAt(j) === '{') {
      // A CLAUSE publishing local values.  A re-export (`… } from './y.js'`) is
      // deliberately skipped: it is barrel plumbing, and the declaration it
      // republishes is already scanned where it lives.
      const groups: Token[][] = [[]];
      let k = j + 1;
      for (let guard = 0; k < tokens.length && guard < MAX_DECLARATOR_TOKENS; k += 1, guard += 1) {
        if (punctAt(k) === '}') break;
        if (punctAt(k) === ',') {
          groups.push([]);
          continue;
        }
        const token = tokens[k];
        // biome-ignore lint/style/noNonNullAssertion: `groups` is never empty.
        if (token !== undefined) groups[groups.length - 1]!.push(token);
      }
      i = k;
      if (identAt(k + 1) === 'from') continue; // barrel plumbing
      for (const group of groups) {
        const names = group.filter((token) => token.kind === 'ident').map((token) => token.value);
        const first = group[0];
        if (first === undefined || names.length === 0) continue;
        // `export { type A }` publishes a TYPE.  `type` is also a legal name, so
        // it is the modifier only when another name follows that is not `as`.
        if (names[0] === 'type' && names.length > 1 && names[1] !== 'as') continue;
        const asAt = names.indexOf('as');
        const local = names[0] ?? '';
        const exported = asAt === -1 ? local : (names[asAt + 1] ?? '');
        if (!/^[A-Za-z_$][\w$]*$/.test(exported) || exported === 'default') continue;
        // An UNALIASED specifier repeats the local declaration's name, so the
        // name occurs twice before any real use.
        emit(exported, 'export', first.start, exported === local ? 2 : 1, false);
      }
      continue;
    }

    if (punctAt(j) === '*') {
      // `export * as name from '…'` publishes ONE named runtime binding that no
      // declaration keyword introduces.  A plain `export * from` does not: those
      // names keep the spelling they are already scanned under.
      if (identAt(j + 1) !== 'as' || identAt(j + 3) !== 'from') continue;
      const name = identAt(j + 2);
      const at = tokens[j + 2]?.start;
      // `export * as default from '…'` is legal ES2020 and publishes `default`,
      // whose name is module-local at every importer — out of scope.
      if (name !== null && name !== 'default' && at !== undefined) {
        emit(name, 'namespace', at, 1, false);
      }
    }
  }
  return out;
}

/**
 * Every exported value declared in one source file, in SOURCE ORDER.
 *
 * INTERSECTS the two regex-preference lexings rather than unioning them.  For
 * identifier COUNTS a mis-lex may only over-count (a false negative, safe); for
 * DECLARATIONS the safe direction is the opposite — a name only one lexing
 * believes in could fail a correct branch, so both must agree on it.
 */
export function exportedValues(source: string): ExportedValue[] {
  const [lenient, strict] = [false, true].map((preferRegex) =>
    parseExportedValues(source, tokenize(source, preferRegex)),
  );
  const agreed = new Set((strict ?? []).map((entry) => `${entry.start}:${entry.value.name}`));
  return (lenient ?? [])
    .filter((entry) => agreed.has(`${entry.start}:${entry.value.name}`))
    .sort((a, b) => a.start - b.start)
    .map((entry) => entry.value);
}

/**
 * The `{ … }` bodies of `export { … } from '…'` RE-EXPORT clauses.
 *
 * A barrel republishing a name is not a consumer of it.  Counting the barrel's
 * occurrence as a reference meant an export could be dead — declared once,
 * re-exported once, imported nowhere — and still pass, because its own barrel
 * vouched for it.  `export * from` needs no span: it names nothing.
 */
function reexportClauseSpans(tokens: readonly Token[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token?.kind !== 'ident' || token.value !== 'export') continue;
    let j = i + 1;
    const next = tokens[j];
    if (next?.kind === 'ident' && next.value === 'type') j += 1;
    const open = tokens[j];
    if (open?.kind !== 'punct' || open.value !== '{') continue;
    let k = j + 1;
    for (let guard = 0; k < tokens.length && guard < MAX_DECLARATOR_TOKENS; k += 1, guard += 1) {
      const inner = tokens[k];
      if (inner?.kind === 'punct' && inner.value === '}') break;
    }
    const close = tokens[k];
    const after = tokens[k + 1];
    if (close !== undefined && after?.kind === 'ident' && after.value === 'from') {
      spans.push([open.start, close.end]);
    }
    i = k;
  }
  return spans;
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
    const top = tokenize(source, preferRegex);
    // A RE-EXPORT is plumbing, not a use.  `export { orphan } from './x.js'` in
    // a barrel nobody imports would otherwise keep `orphan` "referenced" by the
    // barrel alone, and a dead export could hide behind one indefinitely — the
    // same reasoning that already excludes re-export clauses from being counted
    // as DECLARATIONS.  A real consumer still spells the name where it imports
    // it, so a live symbol is unaffected.
    const plumbing = reexportClauseSpans(top);
    const isPlumbing = (offset: number): boolean =>
      plumbing.some(([start, end]) => offset >= start && offset < end);
    const pass = new Map<string, number>();
    const add = (name: string): void => pass.set(name, (pass.get(name) ?? 0) + 1);
    const walk = (tokens: readonly Token[]): void => {
      for (const token of tokens) {
        if (token.kind === 'ident') {
          if (!isPlumbing(token.start)) add(token.value);
        } else if (token.kind === 'template' && token.value.includes('${')) {
          // Only the `${…}` bodies are code; the literal chunks between them are
          // prose and stay excluded.
          for (const span of interpolationSpans(token.value, 0, preferRegex)) {
            walk(tokenize(span.text, preferRegex));
          }
        }
      }
    };
    walk(top);
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
    // AGGREGATE by name within the file before yielding.  A TypeScript OVERLOAD
    // SET is several declarations of one name — every signature plus the
    // implementation — and each writes the name once.  Compared individually,
    // three declarations of an unused `orphan` give a corpus total of three
    // against a baseline of one apiece, so the export looks referenced by its
    // own signatures.  Summing the footprint makes the comparison honest, and
    // the set is reported once, at its FIRST declaration.
    const byName = new Map<string, ExportedValue>();
    for (const declaration of exportedValues(file.content)) {
      // A default export's name is module-local (see `ExportedValue.isDefault`),
      // so its occurrence count carries no information either way.
      if (declaration.isDefault) continue;
      const seen = byName.get(declaration.name);
      if (seen === undefined) byName.set(declaration.name, { ...declaration });
      else seen.selfOccurrences += declaration.selfOccurrences;
    }
    for (const declaration of byName.values()) yield { file, declaration };
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
