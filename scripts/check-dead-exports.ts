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
// "REFERENCED" MEANS THE BINDING, NOT THE NAME.  This module finds WHAT is
// exported; `resolve-export-references.ts` asks the TypeScript compiler which
// sites actually use each one.  The split matters: an earlier cut counted
// occurrences of the NAME across the corpus, which is exact only when a name is
// unique — an unused `export const status` passed the moment any file mentioned
// an unrelated `status`, so common names were effectively exempt.  Binding
// resolution has no such blind spot, and it retired several special cases with
// it: an overload set needs no aggregation (every signature is a declaration of
// one symbol), and "which mentions belong to the declaration" is the symbol's
// own declaration ranges rather than an occurrence baseline.
//
// A CLUSTER of dead exports that reference each other is still reported one
// layer per run: a dead `f()` that reads a dead `A` keeps `A` referenced until
// `f` goes.  That converges, and the direction is the safe one — it never
// demands the deletion of something still in use.
//
// The PARSING here stays dependency-free and pure, so the `scripts`-rooted
// vitest project unit-tests it directly; the resolver is tested against a real
// compiler in `resolve-export-references.test.ts`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolationSpans, type Token, tokenize } from './js-sink-analyzer.js';
import {
  declarationKey,
  type ReferenceSite,
  resolveExportReferences,
} from './resolve-export-references.js';

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
  let angle = 0; // <> — counted only inside a TYPE ANNOTATION (see below)
  let taking = true; // in a BINDING position, rather than skipping to the next
  let annotating = false; // skipping a `:` annotation rather than an `=` initializer
  let patternDepth = 0; // >0 while inside this declarator's destructuring pattern

  for (let i = 0; i < tokens.length && i < MAX_DECLARATOR_TOKENS; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;

    if (token.kind !== 'punct') {
      if (token.kind !== 'ident') continue;
      if (!taking) {
        // `as` and `satisfies` open TYPE context inside an initializer, so the
        // angles after them are type arguments after all:
        //   `export const L = { … } as const satisfies Record<keyof K, string>;`
        // Without this the `,` inside `Record<…>` read as a declarator
        // separator and `string` was recorded as an exported binding — caught
        // by the gate's own refusal to run when the parser and the compiler
        // disagree about what a file exports, which is what that check is for.
        if (token.value === 'as' || token.value === 'satisfies') annotating = true;
        continue;
      }
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
      // ONLY at the pattern's own depth.  A comma nested inside a default's
      // initializer — `{ a = f(first, phantom), b }` — separates that call's
      // ARGUMENTS, not the pattern's bindings, and treating it as a separator
      // recorded `phantom` as an exported binding: a nonexistent dead export
      // that would fail a correct branch, which is the direction this walk is
      // built never to fail in.
      if (depth === patternDepth) {
        if (punct === '=')
          taking = false; // a DEFAULT value inside the pattern
        else if (punct === ',') taking = true;
      }
      continue;
    }
    if (depth !== 0) continue;
    if (!taking) {
      // Angles are TYPE syntax only inside an ANNOTATION.  In an initializer a
      // `<` is a comparison: `export const live = left < right, other = 2`
      // counted it as an unclosed type-argument list, swallowed the declarator
      // comma, and never recorded `other` — an unreferenced export passing the
      // gate.  Which kind of skip this is has to be read HERE, because the
      // binding above has already closed `taking` by the time the `:` or `=`
      // arrives.
      if (angle === 0 && punct === ':') annotating = true;
      else if (angle === 0 && punct === '=') annotating = false;
      else if (annotating && punct === '<') angle += 1;
      else if (annotating && punct === '>') angle = Math.max(0, angle - 1);
      else if (punct === ',' && angle === 0) {
        taking = true;
        annotating = false;
      }
      continue;
    }
    // At a binding position, `:` and `=` both end it; the skip branch above
    // then reads which one it was.
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
   * Byte offset of the declaration's NAME.
   *
   * The handle the reference resolver needs: it asks the compiler which BINDING
   * lives at this position, then reports the sites that use it.  There is no
   * occurrence-baseline field any more — "which mentions belong to the
   * declaration itself" is answered by the symbol's own declaration ranges,
   * which is exact and, unlike a count, needs no special case for an overload
   * set (every signature is a declaration of one symbol).
   */
  offset: number;
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
  const imported = importedLocalNames(tokens);
  const identAt = (index: number): string | null => {
    const token = tokens[index];
    return token?.kind === 'ident' ? token.value : null;
  };
  const punctAt = (index: number): string | null => {
    const token = tokens[index];
    return token?.kind === 'punct' ? token.value : null;
  };
  const emit = (name: string, kind: string, start: number, isDefault: boolean): void => {
    out.push({
      value: {
        name,
        kind,
        line: source.slice(0, start).split('\n').length,
        offset: start,
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
      if (name !== null && at !== undefined) emit(name, 'enum', at, isDefault);
      continue;
    }

    if (keyword !== null && NAMED_KEYWORDS.has(keyword)) {
      // A GENERATOR puts a `*` between the keyword and the name.
      const k = punctAt(j + 1) === '*' ? j + 2 : j + 1;
      const name = identAt(k);
      const at = tokens[k]?.start;
      if (name !== null && at !== undefined) emit(name, keyword, at, isDefault);
      continue;
    }

    if (keyword !== null && BINDING_KEYWORD_SET.has(keyword)) {
      // A declarator LIST: every binding it introduces, not just the first.
      const slice = tokens.slice(j + 1, j + 1 + MAX_DECLARATOR_TOKENS);
      for (const binding of declarationBindings(slice)) {
        emit(binding.name, keyword, binding.start, false);
      }
      continue;
    }

    if (punctAt(j) === '{') {
      // A CLAUSE publishing local values, or a RE-EXPORT (`… } from './y.js'`).
      //
      // An unaliased re-export is barrel plumbing: `export { live } from` names
      // the same binding its declaration already publishes, and that is where it
      // is scanned.  An ALIASED one is not — `export { live as obsolete } from`
      // introduces `obsolete`, a public runtime name that exists NOWHERE else,
      // so skipping the whole clause let an entirely unused alias pass forever
      // while `live` stayed busy elsewhere.
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
      const isReexport = identAt(k + 1) === 'from';
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
        if (isReexport) {
          // Only the ALIAS is a new name; `export { live } from` is plumbing.
          if (exported === local) continue;
          // A re-export clause body is excluded from the identifier count (it is
          // not a USE — see `reexportClauseSpans`), so the alias has no
          // self-occurrence to discount: any count at all is a real consumer.
          emit(exported, 'reexport', first.start, false);
          continue;
        }
        // An UNALIASED specifier republishing an IMPORTED name is the
        // two-statement spelling of `export { X } from` — plumbing, scanned at
        // the declaration it came from.
        if (exported === local && imported.has(local)) continue;
        emit(exported, 'export', first.start, false);
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
        emit(name, 'namespace', at, false);
      }
    }
  }
  return out;
}

/** A site that names exports of another module: `import { A } from 'M'`, or
 *  `const { A } = await import('M')`. */
export interface ImportedNames {
  /** Byte offset of the module-specifier STRING token. */
  readonly specifierOffset: number;
  /** The EXPORT-side names taken from that module. */
  readonly names: readonly string[];
  /** Where to record the reference. */
  readonly offset: number;
}

/**
 * Every place this file names exports OF ANOTHER MODULE, static or dynamic.
 *
 * Resolving identifiers alone is not enough for either form, for the same
 * underlying reason: the identifier the file writes is not the symbol the other
 * module declares.
 *
 *   • `const { readCourierPower } = await import(M)` binds a NEW LOCAL, so the
 *     compiler answers with that local and M's export looks unreferenced.
 *   • `import { queue } from './index.js'` resolves through `getAliasedSymbol`,
 *     which walks all the way to the ORIGINAL declaration — so a barrel's own
 *     `export * as queue from './queue.js'` binding is skipped over and looks
 *     unreferenced even though that is precisely the name being imported.
 *
 * Both are fixed by asking the COMPILER which module the specifier denotes and
 * crediting the export it names.  Nothing is guessed: an import clause and a
 * destructuring pattern both bind BY EXPORT NAME, so the name written here IS
 * the export's name, with no aliasing or shadowing possible.
 *
 * `export … from 'M'` is deliberately NOT included — republishing is not
 * consuming, which is the rule the declaration parser already applies.
 */
export function importedNames(source: string): ImportedNames[] {
  const found = new Map<number, ImportedNames>();
  for (const preferRegex of [false, true]) {
    const tokens = tokenize(source, preferRegex);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token?.kind !== 'ident') continue;

      // STATIC: `import { A, B as c } from 'M'` — the export side is before `as`.
      if (token.value === 'import' && tokens[i + 1]?.value === '{') {
        const names: string[] = [];
        let k = i + 2;
        let expect = true;
        for (
          let guard = 0;
          k < tokens.length && guard < MAX_DECLARATOR_TOKENS;
          k += 1, guard += 1
        ) {
          const inner = tokens[k];
          if (inner === undefined) break;
          if (inner.kind === 'punct') {
            if (inner.value === '}') break;
            if (inner.value === ',') expect = true;
            continue;
          }
          if (inner.kind !== 'ident') continue;
          if (inner.value === 'type') continue; // a type-only specifier
          if (inner.value === 'as') {
            expect = false; // the local alias follows; the export name is taken
            continue;
          }
          if (expect) {
            names.push(inner.value);
            expect = false;
          }
        }
        const from = tokens[k + 1];
        const specifier = tokens[k + 2];
        if (from?.value === 'from' && specifier?.kind === 'string' && names.length > 0) {
          found.set(specifier.start, {
            specifierOffset: specifier.start,
            names,
            offset: token.start,
          });
        }
        i = k;
        continue;
      }

      // DYNAMIC: `const { A } = await import('M')`.
      if (token.value !== 'import') continue;
      const open = tokens[i + 1];
      const specifier = tokens[i + 2];
      if (open?.value !== '(' || specifier?.kind !== 'string') continue;
      if (tokens[i + 3]?.value !== ')') continue;
      let k = i - 1;
      while (k >= 0 && tokens[k]?.kind === 'ident' && tokens[k]?.value === 'await') k -= 1;
      if (tokens[k]?.value !== '=') continue;
      k -= 1;
      if (tokens[k]?.value !== '}') continue;
      const patternEnd = k;
      let depth = 0;
      for (; k >= 0; k -= 1) {
        const inner = tokens[k];
        if (inner?.kind !== 'punct') continue;
        if (inner.value === '}') depth += 1;
        else if (inner.value === '{') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (k < 0) continue;
      const names: string[] = [];
      for (let m = k + 1; m < patternEnd; m += 1) {
        const inner = tokens[m];
        if (inner?.kind !== 'ident') continue;
        // `{ a: renamed }` binds `renamed`; the EXPORT is the key `a`.
        if (tokens[m - 1]?.kind === 'punct' && tokens[m - 1]?.value === ':') continue;
        names.push(inner.value);
      }
      if (names.length > 0) {
        found.set(specifier.start, {
          specifierOffset: specifier.start,
          names,
          offset: tokens[k]?.start ?? specifier.start,
        });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.specifierOffset - b.specifierOffset);
}

/**
 * Local names bound by an `import { … } from '…'` clause.
 *
 * `import { X } from './a.js'; export { X };` is the two-statement spelling of
 * `export { X } from './a.js'` — the same binding, republished under the same
 * name.  The gate already treats the one-statement form as PLUMBING, scanned at
 * the declaration it comes from, and the two-statement form has to follow, or
 * every module that imports-then-exports reports that surface dead.
 *
 * An ALIASED republish (`export { X as Y }`) stays a declaration: `Y` is a new
 * public name that exists nowhere else.
 */
function importedLocalNames(tokens: readonly Token[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token?.kind !== 'ident' || token.value !== 'import') continue;
    const after = tokens[i + 1];
    // `import(` is a dynamic import EXPRESSION, not a binding clause.
    if (after?.kind === 'punct' && after.value === '(') continue;
    let j = i + 1;
    let sawFrom = false;
    const local: string[] = [];
    let expectBinding = true;
    for (let guard = 0; j < tokens.length && guard < MAX_DECLARATOR_TOKENS; j += 1, guard += 1) {
      const current = tokens[j];
      if (current === undefined) break;
      if (current.kind === 'string') break; // the specifier ends the statement
      if (current.kind === 'punct') {
        if (current.value === ',' || current.value === '{') expectBinding = true;
        continue;
      }
      if (current.kind !== 'ident') continue;
      if (current.value === 'from') {
        sawFrom = true;
        break;
      }
      if (current.value === 'as') {
        local.pop(); // the name AFTER `as` is the local binding
        expectBinding = true;
        continue;
      }
      if (current.value === 'type') continue;
      if (expectBinding) {
        local.push(current.value);
        expectBinding = false;
      }
    }
    if (sawFrom) for (const name of local) names.add(name);
    i = j;
  }
  return names;
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
 * The `{ … }` bodies of EVERY `export { … }` clause, re-export or not.
 *
 * Publishing a name is not consuming it.  A barrel's `export { orphan } from
 * './x.js'` would otherwise keep `orphan` alive on its own, and a local
 * `export { foo }` clause would vouch for `foo` — in both cases an export
 * standing as its own only reference.  The resolver skips identifiers inside
 * these spans, which is the same rule the declaration parser applies when it
 * treats a clause as a DECLARATION rather than a use.
 */
function exportClauseSpans(tokens: readonly Token[]): Array<[number, number]> {
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
    if (close !== undefined) spans.push([open.start, close.end]);
    i = k;
  }
  return spans;
}

/**
 * Byte offsets of every IDENTIFIER in one source that could be a USE.
 *
 * Lexed with the repo's existing tokeniser (`js-sink-analyzer.ts`) rather than a
 * second hand-rolled stripper.  A naive one is not merely imprecise, it is
 * WRONG in the dangerous direction: this file's own regexes contain quote
 * characters (`/['"`]/`), so a stripper that does not understand regex literals
 * treats one as an unterminated string and swallows the code after it — leaving
 * real references unseen and turning live symbols into false "dead" reports.
 *
 * The two `preferRegex` lexings are UNIONED.  Only positions matter here, and
 * the compiler decides what actually lives at each one — an offset that is not
 * an identifier resolves to nothing and costs a slot in one batched request.
 * Over-offering is therefore free, while missing an offset would hide a real
 * reference, so the union is the safe direction.
 */
export function identifierOffsets(source: string): number[] {
  const offsets = new Set<number>();
  for (const preferRegex of [false, true]) {
    const top = tokenize(source, preferRegex);
    const plumbing = exportClauseSpans(top);
    const inPlumbing = (offset: number): boolean =>
      plumbing.some(([from, to]) => offset >= from && offset < to);
    const walk = (tokens: readonly Token[]): void => {
      for (const token of tokens) {
        if (token.kind === 'ident') {
          if (!inPlumbing(token.start)) offsets.add(token.start);
        } else if (token.kind === 'template' && token.value.includes('${')) {
          // Only the `${…}` bodies are code; the chunks between them are prose.
          for (const span of interpolationSpans(token.value, token.start, preferRegex)) {
            for (const inner of tokenize(source, preferRegex, {
              from: span.offset,
              stopAtUnmatchedBrace: true,
            })) {
              if (inner.kind === 'ident' && !inPlumbing(inner.start)) offsets.add(inner.start);
            }
          }
        }
      }
    };
    walk(top);
  }
  return [...offsets].sort((a, b) => a - b);
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

/** Exported values of a non-test file that are in scope for either analysis. */
function* scannableDeclarations(
  files: readonly SourceFile[],
): Generator<{ file: SourceFile; declaration: ExportedValue }> {
  for (const file of files) {
    if (file.isTest) continue;
    const lines = file.content.split('\n');
    for (const declaration of exportedValues(file.content)) {
      // A default export's name is module-local (see `ExportedValue.isDefault`),
      // so nothing outside the module is obliged to spell it.
      if (declaration.isDefault) continue;
      if (isEntryPoint(lines, declaration.line)) continue;
      yield { file, declaration };
    }
  }
}

/** How the analyses learn which sites USE a binding. */
export interface ReferenceOracle {
  usesOf(file: string, offset: number): readonly ReferenceSite[];
}

/**
 * Pure: every exported value the oracle finds NO use for.
 *
 * Uses are counted across ALL files including tests — exporting a helper so a
 * unit test can reach it is a legitimate reason to export, and this gate has no
 * business second-guessing it.
 */
export function findDeadExports(
  files: readonly SourceFile[],
  oracle: ReferenceOracle,
): DeadExport[] {
  const dead: DeadExport[] = [];
  for (const { file, declaration } of scannableDeclarations(files)) {
    if (oracle.usesOf(file.path, declaration.offset).length > 0) continue;
    dead.push({
      file: file.path,
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
  files: readonly SourceFile[],
  oracle: ReferenceOracle,
): DeadExport[] {
  const internal: DeadExport[] = [];
  for (const { file, declaration } of scannableDeclarations(files)) {
    const uses = oracle.usesOf(file.path, declaration.offset);
    if (uses.length === 0) continue; // dead, reported by the gate above
    if (uses.some((use) => use.file !== file.path)) continue;
    internal.push({
      file: file.path,
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
 * The real oracle: resolve every identifier in the corpus to its binding.
 *
 * Refuses to answer on incomplete input.  A tracked file no project's program
 * contains is invisible, and an export used only from such a file would look
 * dead — a FALSE POSITIVE, which is the one failure mode a gate in CI must
 * never have.  Likewise a declaration whose name offset resolves to no symbol:
 * the parser found an export the compiler does not agree exists, and guessing
 * either way is worse than stopping.
 */
function buildOracle(files: readonly SourceFile[]): ReferenceOracle {
  const declarations = [...scannableDeclarations(files)].map(({ file, declaration }) => ({
    file: file.path,
    offset: declaration.offset,
  }));
  const resolved = resolveExportReferences({
    files: files.map((file) => file.path),
    identifierOffsets: (_file, source) => identifierOffsets(source),
    importedNames: (_file, source) => importedNames(source),
    declarations,
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
  if (resolved.unresolved.length > 0) {
    console.error(
      `check:dead-exports CANNOT RUN — ${resolved.unresolved.length} parsed declaration(s) resolved\n` +
        '  to no symbol. The parser and the compiler disagree about what is exported here:',
    );
    for (const entry of resolved.unresolved.slice(0, 20)) {
      console.error(`  - ${entry.file} @${entry.offset}`);
    }
    process.exit(2);
  }
  return {
    usesOf: (file, offset) => resolved.uses.get(declarationKey(file, offset)) ?? [],
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

  const oracle = buildOracle(files);

  if (process.argv.includes('--internal-only')) {
    const internal = findInternalOnlyExports(files, oracle);
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

  const dead = findDeadExports(files, oracle);
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
