// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Compiler-backed export enumeration and reference resolution for
// `check:dead-exports`.
//
// This module answers both halves of the gate's question — WHAT does a file
// export, and WHICH sites use each one — by asking the TypeScript compiler,
// through the TypeScript 7 API (`typescript/unstable/sync`).  Neither half is
// parsed from text here, and that is the whole design.
//
// WHY NOT PARSE.  Both halves were once hand-rolled: first over raw text, then
// over a token stream.  Each round of review found another piece of ordinary
// TypeScript the parser did not model — a generator's `*`, a declarator list, a
// `const enum`, a block comment mid-declaration, `as`/`satisfies` opening type
// context, a `<` comparison, a generic arrow's `<T,>`, a template interpolation
// nested inside another.  Every one was a real defect and every fix was correct,
// but the list has no end: it is the TypeScript grammar, and the only artefact
// that knows all of it is the compiler.  So the compiler is what this asks.  A
// hand parser here can be wrong in the direction a CI gate must never be wrong
// in — inventing an export that does not exist fails a correct branch, and
// missing a real reference reports live code as dead.
//
// The cost model is per-REQUEST, not per-node: the API talks to the native
// compiler over a pipe, but a file's AST arrives as one blob and is decoded
// lazily on this side, so walking it is local work.  Whole-repository
// enumeration (~2000 files, ~2.2M nodes) costs about three seconds; the
// identifier resolution that follows is batched, `getSymbolAtPosition` taking a
// whole array of positions per round trip.
//
// WHAT THE COMPILER SETTLES, that no text scan can:
//   • DECLARATOR LISTS and destructuring — `export const a = 1, b = 2` and
//     `export const { a, b } = obj` are several bindings, and the compiler
//     reports each with its own declaration node;
//   • an EXPORT ALIAS is its own module binding — `export { foo as obsolete }`
//     publishes `obsolete`, a public name that exists nowhere else.  Its
//     declaration is the specifier's EXPORTED name, so uses of the local `foo`
//     inside the file do not keep the unused public alias alive;
//   • TYPES vs VALUES — read off `SymbolFlags`, through an alias where needed,
//     rather than inferred from a keyword;
//   • an OVERLOAD SET is one symbol with several declarations, so nothing needs
//     to aggregate signatures.
//
// IDENTITY IS THE DECLARATION SITE, not the symbol id.  A file may belong to
// more than one project — `apps/web/vite.config.ts` is owned by the root
// `tsconfig.base.json` while the module it imports is owned by
// `apps/web/tsconfig.json` — and each program mints its OWN symbol for the same
// declaration (584 here, 795 there).  Comparing ids would have reported every
// export consumed across such a boundary as dead.  A symbol's declaration
// handles carry `path` and a stable per-file node `index`, which agree in every
// project that parses the file, so those are what the tables are keyed on.
//
// What counts as a REFERENCE (and what does not):
//   • an occurrence inside one of the symbol's own DECLARATION ranges is the
//     declaration, not a use — which also makes a recursive call inside a
//     function no reason to keep that function alive;
//   • an occurrence inside an `export { … }` clause or an `export * as n from`
//     is PLUMBING: publishing a name is not consuming it, and without this every
//     clause export would vouch for itself;
//   • every other resolved occurrence is a use, in any file including the
//     declaring one (exporting a helper so its own module's test can reach it is
//     a legitimate reason to export).
//
// Alias CHAINS are followed one hop at a time and every symbol on the path is
// credited, so a consumer importing through a barrel keeps both the barrel's
// alias and the original declaration alive.
//
// DESTRUCTURING is the one form where an identifier is not the binding.  In
// `const { readCourierPower } = await import(M)` the name introduces a new
// LOCAL, so resolving it answers with that local and the export it came from
// looks unreferenced.
//
// The answer is the TYPE of what is destructured: `getPropertyOfType` on it
// returns the export's own symbol.  That is deliberately the ONLY rule here,
// because the alternative was tried.  A hand-written dataflow analysis grew a
// receiver walk (through parentheses, `as`, `await`, and a `.then` callback), a
// map of locals holding a namespace, and alias edges followed to a fixed point
// — and review still found six positions it did not cover: a parenthesized
// receiver, a parenthesized callback, a stored namespace, a static namespace
// import, an assignment target, an identifier alias.  Each fix was correct and
// the next position was always there, because a dataflow analysis was being
// written by hand beside a compiler that had already done one.
//
// The type knows every hop the value took.  A seventh position — an
// ASSIGNMENT-expression alias — arrived while this rewrite was in progress and
// needed no code at all.
//
// COVERAGE IS ASSERTED, not assumed.  A tracked file that belongs to no
// project's program is invisible, and an export used only from such a file would
// look dead — a FALSE POSITIVE, the one failure mode a gate in CI must never
// have.  So is a file the compiler treats as a module but whose module symbol
// cannot be read: its exports would silently not be judged at all.  Both are
// reported, and the caller refuses to run rather than guess.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import { API, type Project, SymbolFlags, type Symbol as TsSymbol } from 'typescript/unstable/sync';
import { asNode, asSyntax, type SourceRoot, type Syntax } from './ts-source.js';

const ROOT = resolve(import.meta.dirname, '..');

/** How far an alias chain is followed before it is treated as a cycle. */
const MAX_ALIAS_HOPS = 16;

/** Where a name resolved to a binding. */
export interface ReferenceSite {
  /** Repo-relative path. */
  readonly file: string;
  readonly offset: number;
}

/** One named value a file publishes, as the COMPILER reports it. */
export interface ExportedBinding {
  /** Repo-relative path of the declaring file. */
  readonly file: string;
  /** The EXPORTED name — for `export { a as b }`, `b`. */
  readonly name: string;
  /** A human label for the report: `const`, `function`, `class`, … */
  readonly kind: string;
  /** 1-based line of the declaration's name, for the report. */
  readonly line: number;
  /** Byte offset of the declaration's NAME: this binding's key. */
  readonly offset: number;
}

export interface ResolveInput {
  /** Repo-relative paths of every tracked source file to scan. */
  readonly files: readonly string[];
  /** Directory the paths are relative to.  Defaults to the repository root;
   *  a test points it at a fixture project so the resolver is exercised against
   *  real compiler behaviour rather than a stubbed oracle. */
  readonly root?: string;
  /** tsconfigs to open.  Defaults to every tracked one. */
  readonly configs?: readonly string[];
  /**
   * Also enumerate UNCHANGED barrel re-exports (`export { live } from './x'`).
   *
   * Off for the blocking gate and on for its survey.  Publishing a name is not
   * consuming it, so these bindings ARE judgeable and the question is worth
   * being able to ask — but in this repository they are ~244 module-barrel
   * entries, overwhelmingly the deliberate SSOT-surface idiom the gate's own
   * guidance names for `@licio/shared` and `@licio/db` rather than defects.
   * Failing CI on a convention is how a gate gets switched off, so the survey
   * reports them and `docs/planning/audit-residuals-2026-07.md` tracks them.
   */
  readonly judgeRepublished?: boolean;
}

export interface ResolvedReferences {
  /** Every named export the compiler reports, in file and source order. */
  readonly exports: readonly ExportedBinding[];
  /** `declarationKey` → the sites that genuinely USE that binding. */
  readonly uses: ReadonlyMap<string, readonly ReferenceSite[]>;
  /** Tracked files no project's program contained; non-empty ⇒ do not trust. */
  readonly uncovered: readonly string[];
  /** Module files whose export table could not be read; likewise disqualifying. */
  readonly unreadable: readonly string[];
}

/**
 * Stable key for a declaration site.
 *
 * The separator is written as the ESCAPE `\0`, never as a literal NUL byte. A
 * raw NUL makes Git classify the whole file as binary, so `git diff` reports
 * only "Binary files differ" and every later change to this gate - including a
 * security fix - loses line-level review. NUL is still the right delimiter at
 * RUNTIME: a path may contain a space, but never this.
 */
export function declarationKey(file: string, offset: number): string {
  return `${file}\0${offset}`;
}

/** Every tracked tsconfig — the root and base configs included, since between
 *  them they are what pulls e2e specs, vitest configs and loose scripts into a
 *  program at all. */
export function workspaceConfigs(): string[] {
  return execFileSync('git', ['ls-files', '*tsconfig*.json'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 1 << 24,
  })
    .split('\n')
    .filter((path) => path.length > 0 && !path.includes('node_modules'))
    .map((path) => resolve(ROOT, path));
}

/** Declaration kinds that publish a named value, mapped to their report label. */
const KIND_LABEL = new Map<number, string>([
  [SyntaxKind.FunctionDeclaration, 'function'],
  [SyntaxKind.ClassDeclaration, 'class'],
  [SyntaxKind.EnumDeclaration, 'enum'],
  [SyntaxKind.ModuleDeclaration, 'namespace'],
  [SyntaxKind.ExportSpecifier, 'export'],
  [SyntaxKind.NamespaceExport, 'namespace'],
]);

/** `const` / `let` / `var`, read from the declaration list that owns a binding. */
const BINDING_KEYWORD = /^(const|let|var)\b/;

/**
 * The label a report uses for one declaration.
 *
 * Cosmetic only — the gate's verdict never depends on it — so an unrecognised
 * shape degrades to a generic word rather than failing.
 */
function labelOf(node: Syntax, text: string): string {
  const known = KIND_LABEL.get(node.kind);
  if (known !== undefined) return known;
  if (node.kind === SyntaxKind.VariableDeclaration || node.kind === SyntaxKind.BindingElement) {
    // Walk out to the declaration LIST, whose first word is the keyword.
    let owner: Syntax | undefined = node;
    for (let hop = 0; owner !== undefined && hop < MAX_ALIAS_HOPS; hop += 1) {
      if (owner.kind === SyntaxKind.VariableDeclarationList) {
        return BINDING_KEYWORD.exec(text.slice(owner.getStart()))?.[1] ?? 'variable';
      }
      owner = owner.parent;
    }
    return 'variable';
  }
  return 'value';
}

/**
 * The name a node declares, as the COMPILER decodes it.
 *
 * Never the source spelling.  ES2022 allows an arbitrary module namespace name
 * — `import { "foo-bar" as local } from './a.js'`, `export { value as
 * "foo-bar" }` — and slicing the source yields `"foo-bar"` WITH its quotes,
 * which matches nothing in the module's export table (keyed `foo-bar`).  The
 * export then looks unreferenced and a correct branch fails.  `text` is the
 * decoded value for an identifier and a string literal alike, so reading it is
 * both simpler and right.
 */
function nameOf(node: Syntax | undefined): string | undefined {
  const value: unknown = node?.text;
  return typeof value === 'string' ? value : undefined;
}

/** Follow an alias to what it ultimately denotes; `undefined` if unresolvable. */
function aliasTarget(symbol: TsSymbol, project: Project): TsSymbol | undefined {
  if (!(symbol.flags & SymbolFlags.Alias)) return undefined;
  try {
    return project.checker.getAliasedSymbol(symbol);
  } catch {
    return undefined;
  }
}

/**
 * Whether a symbol publishes a VALUE — through an alias where it is one.
 *
 * Types are deliberately out of scope for the gate (they are erased at build and
 * nearly all of this repo's unreferenced ones are mechanical projections of a
 * live value), so this is what separates the two.  An alias carries no value
 * flag of its own, which is why `export { type A }` and `export { a }` are
 * distinguishable only after resolution.
 */
function publishesValue(symbol: TsSymbol, project: Project): boolean {
  if (symbol.flags & SymbolFlags.Value) return true;
  const target = aliasTarget(symbol, project);
  return target !== undefined && (target.flags & SymbolFlags.Value) !== 0;
}

/**
 * Whether an `export { … }` specifier merely REPUBLISHES a name unchanged.
 *
 * Publishing a name is not declaring one: `export { live } from './x.js'` and
 * its two-statement spelling `import { live } from './x.js'; export { live }`
 * both name a binding that is already judged where it is declared, so judging
 * them again would demand the deletion of a name that is genuinely in use.
 *
 * An ALIASED specifier is the opposite case and must be judged: `export { live
 * as obsolete }` introduces `obsolete`, a public runtime name that exists
 * NOWHERE else, so an entirely unused alias would otherwise pass forever.
 */
function isUnchangedRepublish(node: Syntax, project: Project): boolean {
  const name = node.name;
  if (name === undefined) return false;
  const exported = nameOf(name);
  const source = nameOf(node.propertyName) ?? exported;
  if (exported === undefined || exported !== source) return false; // `as` renamed it
  // `export { live } from './x.js'` — the specifier's own module specifier.
  if (node.parent?.parent?.moduleSpecifier !== undefined) return true;
  // `import { live } from './x.js'; export { live }` — the local it publishes
  // is itself an import binding, so this is the same republish in two statements.
  // `Syntax` is this module's reading view of the tree; the checker wants the
  // API's own node type, and the two describe the same object.
  const local = project.checker.getExportSpecifierLocalTargetSymbol(asNode(node));
  if (local === undefined || (local.flags & SymbolFlags.Alias) === 0) return false;
  // But the IMPORT may have done the renaming: `import { live as obsolete };
  // export { obsolete }` publishes a name the source module never had, and this
  // specifier carries no `propertyName` to show it.  Unchanged means unchanged
  // ALL THE WAY to the declaration, which is what the alias resolves to — so the
  // question is asked of the original name rather than of the local's flags.
  return project.checker.getAliasedSymbol(local)?.name === exported;
}

/** What one AST walk of a file collects. */
interface FileScan {
  /** Offsets of identifiers that could be a USE (plumbing already removed). */
  readonly offsets: number[];
  /** STATIC import clauses, for the specifier route. */
  readonly imports: Array<{ specifierOffset: number; names: string[]; offset: number }>;
  /**
   * Element accesses, whose KEY may name an export however it was spelled.
   *
   * Kept as nodes rather than offsets because the answer comes from the key's
   * TYPE, which the walk cannot ask for — the checker is only in hand once the
   * owning project is.
   */
  readonly accesses: Syntax[];
  /**
   * Offsets where a NAMESPACE is used without selecting a member from it.
   *
   * `Object.keys(mod)`, `for (const k in mod)`, `send(mod)`, `return mod` —
   * each observably consumes every export, and none of them spells one.  The
   * gate used to name the wholesale-consumption forms it knew (an object
   * spread, a `...rest` element), which meant every form it did NOT name
   * reported live exports dead.  So the question is inverted: a namespace that
   * is not being INDEXED has escaped, and everything in it is read.
   */
  readonly escapes: Syntax[];
  /**
   * Object destructuring sites: the names taken, and the node whose TYPE says
   * what they were taken FROM.
   *
   * The type is the whole answer.  `const { A } = mod` after
   * `import * as original from 'M'; const alias = original; const mod = alias`
   * has a pattern whose type is still M's namespace, so the compiler has
   * already done the dataflow — through aliases, `await`, `as`, parentheses,
   * and a `.then` callback's contextual parameter alike.
   */
  readonly destructures: Array<{
    at: number;
    source: Syntax;
    names: string[];
    /**
     * Whether a `...rest` element takes what the names did not.
     *
     * Object rest copies EVERY remaining enumerable own property, so it reads
     * exports it never spells — and a pattern's `rest` binding is a new local,
     * whose name is not a property of the module at all.  Asking for it by name
     * credited nothing and reported live exports dead.
     */
    rest: boolean;
    /**
     * Keys written as a COMPUTED name: `const { [key]: value } = mod`.
     *
     * Kept as nodes because the name is in the key's TYPE, which the walk
     * cannot ask for — the same question `mod[key]` turns on, so it is answered
     * the same way rather than by a rule about which spellings are allowed.
     */
    computed: Syntax[];
  }>;
}

/** Identifier parents that PUBLISH a name rather than consume one. */
const PLUMBING_PARENTS = new Set<number>([SyntaxKind.ExportSpecifier, SyntaxKind.NamespaceExport]);

/** Identifier parents that DECLARE the name rather than use the value. */
const BINDING_PARENTS = new Set<number>([
  SyntaxKind.NamespaceImport,
  SyntaxKind.ImportSpecifier,
  SyntaxKind.ImportClause,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.NamespaceExport,
  SyntaxKind.ExportSpecifier,
  SyntaxKind.QualifiedName,
]);

/**
 * Whether an identifier hands a VALUE over whole.
 *
 * Stated positively, and that is the correction.  It was written as "any
 * identifier that is not a member selection and not a binding", and a rule
 * defined by two exclusions admits everything nobody thought to exclude.  In
 * one file that was 334 property NAMES (`mod.LIVE` — the `LIVE`), 63 type
 * references, 60 parameter declarations, 44 interface members and every
 * declaration's own name.
 *
 * The type layer is the part that mattered.  `let x: typeof mod` resolves to
 * the MODULE symbol, so it would have credited the whole export set and
 * retired this gate for that module — a silent one, in the direction a gate
 * must never fail.  It also asked the checker for the type of nodes that are
 * not expressions, which it answers with a process-ending panic
 * (`checker.TypeData is *checker.TypeReference, not *checker.TupleType` —
 * `TupleType` being a type node, from inside the very range excluded below).
 * The crash was the honest half of the defect; the over-crediting was not
 * going to announce itself.
 */
function isNamespaceEscape(node: Syntax): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  const at = node.getStart();

  // Not in a TYPE.  The range is the compiler's own — `FirstTypeNode` through
  // `LastTypeNode` — rather than a list of type node kinds that would need a
  // new entry every time the grammar grows one.
  for (let above: Syntax | undefined = parent; above !== undefined; above = above.parent) {
    if (above.kind >= SyntaxKind.FirstTypeNode && above.kind <= SyntaxKind.LastTypeNode) {
      return false;
    }
  }

  // Not a NAME.  A declaration's own name, and the property half of `a.b` or
  // `{ b: … }`, sit in the parent's `name` — so one test covers a variable, a
  // parameter, a function, an interface member and a property access alike.
  // `{ mod }` is the exception that proves it: shorthand puts the VALUE there.
  if (parent.kind !== SyntaxKind.ShorthandPropertyAssignment && parent.name?.getStart() === at) {
    return false;
  }

  // Not import/export plumbing: publishing a name is not consuming the value.
  if (BINDING_PARENTS.has(parent.kind)) return false;

  // Not BOUND.  `const { A } = ns` takes exactly what the pattern spells and
  // the destructuring route credits it from the pattern's type; `const alias =
  // ns` and `alias = ns` hand the namespace to a local this same analysis goes
  // on to read.  Treating any of them as an escape credited every sibling
  // export.
  if (parent.kind === SyntaxKind.VariableDeclaration && parent.initializer?.getStart() === at) {
    return false;
  }
  // BOTH SIDES of an assignment: the right is the value being bound, and the
  // left is a LOCATION being written rather than an object being handed over.
  if (
    parent.kind === SyntaxKind.BinaryExpression &&
    parent.operatorToken?.kind === SyntaxKind.EqualsToken &&
    (parent.right?.getStart() === at || parent.left?.getStart() === at)
  ) {
    return false;
  }

  // Not SELECTING: the receiver of `mod.NAME` / `mod[key]` reads one export,
  // and that one is credited by name.
  const selecting =
    (parent.kind === SyntaxKind.PropertyAccessExpression ||
      parent.kind === SyntaxKind.ElementAccessExpression) &&
    parent.expression?.getStart() === at;
  return !selecting;
}

/**
 * The exports an element access names.
 *
 * `mod['LIVE']` reads an export, and so does `mod[key]` after
 * `const key = 'LIVE' as const` — the two differ only in where the string is
 * written, which is not a difference the module cares about.  Matching literal
 * NODE KINDS saw the first and missed the second, so the question is asked of
 * the key's TYPE instead: a string-literal type is a statically known name,
 * however it was spelled, and `getPropertyOfType` turns it into the export's own
 * symbol.  That also settles `'abc'[0]`, whose object type is a string and has
 * no such property, without a rule about which position the literal sits in.
 */
function elementAccessExports(node: Syntax, project: Project): TsSymbol[] {
  const argument = node.argumentExpression;
  const receiver = node.expression;
  if (argument === undefined || receiver === undefined) return [];
  const target = project.checker.getTypeAtLocation(asNode(receiver));
  if (target === undefined) return [];
  const key = project.checker.getTypeAtLocation(asNode(argument));
  if (key === undefined) return [];
  // A UNION of literal keys selects EVERY member it could be: after
  // `const k: keyof typeof mod = flag ? 'a' : 'b'`, `mod[k]` reads whichever of
  // the two the branch takes, so both are referenced.  Reading only a single
  // literal type left the rest looking dead.
  const constituents = key.isUnionType() ? key.getTypes() : [key];
  const named = constituents.filter((each) => each.isStringLiteralType());
  // A key whose type says NOTHING about which member it names may name any of
  // them, so the whole module is read.  That is the honest answer, and it is
  // the one that stops the gate rejecting valid code.
  if (named.length !== constituents.length || named.length === 0) {
    return [...project.checker.getPropertiesOfType(target)];
  }
  return named.flatMap((each) => {
    const property = project.checker.getPropertyOfType(target, String(each.value));
    return property === undefined ? [] : [property];
  });
}

/**
 * Collect, in one walk, the identifier offsets, the static import clauses, and
 * the destructuring sites.
 *
 * What this walk deliberately does NOT do is trace where a destructured value
 * came from.  It used to: a receiver walk through parentheses / `as` / `await`
 * / a `.then` callback, a map of locals holding a namespace, alias edges
 * followed to a fixed point.  Review found six positions that machinery did not
 * cover — a parenthesized receiver, a parenthesized callback, a stored
 * namespace, a static namespace import, an assignment target, an identifier
 * alias — because it was a dataflow analysis written by hand beside a compiler
 * that had already done one.  The TYPE of the pattern answers all six at once,
 * so the walk only has to say WHERE to ask.
 */
function scanFile(root: Syntax): FileScan {
  const scan: FileScan = {
    offsets: [],
    imports: [],
    destructures: [],
    accesses: [],
    escapes: [],
  };

  /** The EXPORT-side names a pattern or assignment target takes, and whether a
   *  `...rest` element sweeps up whatever those names left. */
  const namesOfPattern = (
    pattern: Syntax,
  ): { names: string[]; rest: boolean; computed: Syntax[] } => {
    const names: string[] = [];
    const computed: Syntax[] = [];
    let rest = false;
    pattern.forEachChild((element) => {
      // A DECLARATION's pattern holds `BindingElement`s; an ASSIGNMENT's target
      // is an object literal, whose members are shorthand or property
      // assignments.  Both name the property the same way — and both spell a
      // rest element their own way, `...x` as a dotted BindingElement in one and
      // as a SpreadAssignment in the other.
      if (element.kind === SyntaxKind.SpreadAssignment) {
        rest = true;
        return;
      }
      if (
        element.kind !== SyntaxKind.BindingElement &&
        element.kind !== SyntaxKind.ShorthandPropertyAssignment &&
        element.kind !== SyntaxKind.PropertyAssignment
      ) {
        return;
      }
      if (element.dotDotDotToken !== undefined) {
        rest = true;
        return;
      }
      // `{ a: renamed }` binds `renamed`; the EXPORT it names is the key `a`.
      const named = element.propertyName ?? element.name;
      if (named?.kind === SyntaxKind.ComputedPropertyName) {
        if (named.expression !== undefined) computed.push(named.expression);
        return;
      }
      const key = nameOf(named);
      if (key !== undefined) names.push(key);
    });
    return { names, rest, computed };
  };

  const destructure = (target: Syntax, source: Syntax): void => {
    const { names, rest, computed } = namesOfPattern(target);
    if (names.length > 0 || rest || computed.length > 0) {
      scan.destructures.push({ at: target.getStart(), source, names, rest, computed });
    }
  };

  const visit = (node: Syntax): void => {
    if (node.kind === SyntaxKind.Identifier) {
      const parentKind = node.parent?.kind;
      if (parentKind === undefined || !PLUMBING_PARENTS.has(parentKind)) {
        scan.offsets.push(node.getStart());
      }
      if (isNamespaceEscape(node)) scan.escapes.push(node);
    } else if (node.kind === SyntaxKind.ElementAccessExpression) {
      // `mod['LIVE']` names an export with a STRING rather than an identifier,
      // and so does `mod[key]` where `key` is a literal-typed constant.  Which
      // export — if any — is a question for the key's type.
      scan.accesses.push(node);
    } else if (node.kind === SyntaxKind.ImportDeclaration) {
      // STATIC: `import { A, B as c } from 'M'` — the export side precedes `as`.
      //
      // This route exists for a reason the property route does not cover: a
      // named import resolves through `getAliasedSymbol` all the way to the
      // ORIGINAL declaration, stepping over any barrel binding in between, so
      // the barrel's own alias would look unreferenced.
      const specifier = node.moduleSpecifier;
      const named = node.importClause?.namedBindings;
      if (specifier !== undefined && named?.kind === SyntaxKind.NamedImports) {
        const names: string[] = [];
        named.forEachChild((element) => {
          if (element.kind !== SyntaxKind.ImportSpecifier || element.isTypeOnly) return;
          const key = nameOf(element.propertyName ?? element.name);
          if (key !== undefined) names.push(key);
        });
        if (names.length > 0) {
          scan.imports.push({
            specifierOffset: specifier.getStart(),
            names,
            offset: node.getStart(),
          });
        }
      }
    } else if (node.name?.kind === SyntaxKind.ObjectBindingPattern) {
      // A binding pattern in a declaration or a parameter.  Its OWN type is
      // what it destructures — contextually typed for a callback parameter, so
      // `import(M).then(({ A }) => …)` needs no special case.
      destructure(node.name, node.name);
    } else if (
      node.kind === SyntaxKind.BinaryExpression &&
      node.operatorToken?.kind === SyntaxKind.EqualsToken &&
      node.left?.kind === SyntaxKind.ObjectLiteralExpression &&
      node.right !== undefined
    ) {
      // `({ A } = expr)` — the target is an object LITERAL, whose type is the
      // assignment's result rather than its source, so the RIGHT side is what
      // says where the names came from.
      destructure(node.left, node.right);
    }
    node.forEachChild(visit);
  };

  visit(root);
  return scan;
}

/**
 * Enumerate every named value `file` exports, as the compiler sees it.
 *
 * Only declarations that live IN THIS FILE are returned: a `export * from './x'`
 * puts another module's symbols in this one's export table, and those are judged
 * where they are written.
 */
function exportsOfFile(
  file: string,
  absolute: string,
  project: Project,
  text: string,
  judgeRepublished: boolean,
): Array<{ binding: ExportedBinding; keys: string[]; symbol: TsSymbol }> {
  const source = project.program.getSourceFile(absolute);
  if (source === undefined) return [];
  const moduleSymbol = project.checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) return [];

  const found: Array<{ binding: ExportedBinding; keys: string[]; symbol: TsSymbol }> = [];
  for (const symbol of project.checker.getExportsOfModule(moduleSymbol)) {
    // `export default …` publishes the binding `default`: the declaration's own
    // name is module-local and every importer picks its own, so the name is
    // under no obligation to appear anywhere else.  Judging it would mean asking
    // whether the MODULE is reachable, a different question from this one.
    if (symbol.name === 'default') continue;
    if (!publishesValue(symbol, project)) continue;

    for (const handle of symbol.declarations) {
      if (handle.path !== absolute) continue; // declared elsewhere; judged there
      const node = handle.resolve(project);
      const name = asSyntax(node).name;
      if (node === undefined || name === undefined) continue;
      if (
        !judgeRepublished &&
        node.kind === SyntaxKind.ExportSpecifier &&
        isUnchangedRepublish(asSyntax(node), project)
      ) {
        continue;
      }
      const offset = name.getStart();
      found.push({
        binding: {
          file,
          name: symbol.name,
          kind: labelOf(asSyntax(node), text),
          line: source.getLineAndCharacterOfPosition(offset).line + 1,
          offset,
        },
        keys: symbol.declarations.map((each) => `${each.path}#${each.index}`),
        symbol,
      });
    }
  }
  return found.sort((a, b) => a.binding.offset - b.binding.offset);
}

/**
 * Open the configured projects and answer which project OWNS each file.
 *
 * Ownership comes from each program's OWN file list rather than from directory
 * nesting: a file is resolvable exactly where the compiler put it, and guessing
 * by path produced "source file not found" for every e2e spec and tool config.
 */
function withProjects<T>(
  input: ResolveInput,
  body: (ownerOf: ReadonlyMap<string, Project>) => T,
): T {
  const root = input.root ?? ROOT;
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({
      openProjects: [...(input.configs ?? workspaceConfigs())],
    });
    const projects = snapshot.getProjects();
    if (projects.length === 0) throw new Error('no TypeScript projects could be opened');
    const ownerOf = new Map<string, Project>();
    for (const project of projects) {
      for (const file of project.program.getSourceFileNames()) {
        if (!ownerOf.has(file)) ownerOf.set(file, project);
      }
    }
    return body(ownerOf);
  } finally {
    api.close();
  }
}

/**
 * The gate's PRECONDITION alone: tracked files no project's program contains.
 *
 * A program LOAD rather than a resolution pass.  The full analysis answers this
 * too, but asking it that way costs the whole enumeration — a minute of work to
 * check a property that is settled the moment the programs are open.
 */
export function findUncoveredFiles(input: ResolveInput): string[] {
  const root = input.root ?? ROOT;
  return withProjects(input, (ownerOf) =>
    input.files.filter((file) => !ownerOf.has(resolve(root, file))),
  );
}

/**
 * Enumerate the corpus's exports and resolve every identifier to its binding.
 */
export function resolveExportReferences(input: ResolveInput): ResolvedReferences {
  const root = input.root ?? ROOT;
  const judgeRepublished = input.judgeRepublished === true;
  return withProjects(input, (ownerOf) => {
    /** `path#index` of a declaration → the sites that mention that binding. */
    const sites = new Map<string, ReferenceSite[]>();
    const uncovered: string[] = [];
    const unreadable: string[] = [];
    const exports: ExportedBinding[] = [];
    const declared: Array<{ binding: ExportedBinding; keys: string[]; symbol: TsSymbol }> = [];

    const credit = (symbol: TsSymbol, site: ReferenceSite): void => {
      for (const handle of symbol.declarations) {
        const key = `${handle.path}#${handle.index}`;
        const seen = sites.get(key);
        if (seen === undefined) sites.set(key, [site]);
        else seen.push(site);
      }
    };

    /**
     * Credit a symbol AND every alias hop behind it.
     *
     * One helper rather than a walk at each call site, because the two diverged:
     * the module-specifier branch credited only the symbol
     * `getExportsOfModule` handed back, so `export { VALUE as ALIAS } from
     * './m.js'` consumed as `const { ALIAS } = await import('./barrel.js')` kept
     * the barrel's alias alive and left the original `VALUE` — the declaration
     * actually being consumed — looking dead.  That is a FALSE POSITIVE, which
     * fails a correct branch.
     */
    const creditChain = (symbol: TsSymbol, site: ReferenceSite, project: Project): void => {
      let current = symbol;
      for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
        credit(current, site);
        const next = aliasTarget(current, project);
        if (next === undefined || next.id === current.id) break;
        current = next;
      }
    };

    for (const file of input.files) {
      const absolute = resolve(root, file);
      const project = ownerOf.get(absolute);
      if (project === undefined) {
        uncovered.push(file);
        continue;
      }
      const source = project.program.getSourceFile(absolute);
      if (source === undefined) {
        uncovered.push(file);
        continue;
      }
      const text = source.text;

      // A file the compiler treats as a module must yield an export table. If
      // it does not, its exports would silently go unjudged — quieter than a
      // false positive, but still coverage the gate would be claiming without
      // having.
      if (
        source.externalModuleIndicator !== undefined &&
        project.checker.getSymbolAtLocation(source) === undefined
      ) {
        unreadable.push(file);
        continue;
      }

      for (const entry of exportsOfFile(file, absolute, project, text, judgeRepublished)) {
        exports.push(entry.binding);
        declared.push(entry);
      }

      const scan = scanFile((source as unknown as SourceRoot).getOrCreateNodeAtIndex(0));

      // Names taken from ANOTHER module, resolved through the module symbol
      // rather than through the local identifier.  A destructured dynamic
      // import binds a new local (so the identifier answers with that local),
      // and a static import resolves all the way past any barrel binding in
      // between — in both cases the export actually named goes uncredited.
      for (const binding of scan.imports) {
        const moduleSymbol = project.checker.getSymbolAtPosition(absolute, binding.specifierOffset);
        if (moduleSymbol === undefined) continue;
        const exported = new Map(
          project.checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]),
        );
        for (const name of binding.names) {
          const symbol = exported.get(name);
          if (symbol !== undefined) creditChain(symbol, { file, offset: binding.offset }, project);
        }
      }

      // ELEMENT ACCESS, answered by the TYPE of the key rather than by its
      // node kind, so a constant carrying the name reads the same as the name.
      for (const access of scan.accesses) {
        for (const property of elementAccessExports(access, project)) {
          creditChain(property, { file, offset: access.getStart() }, project);
        }
      }

      // A NAMESPACE that escaped without being indexed: every export is read,
      // because whoever holds the object can read any of them.
      //
      // Asked of the TYPE, which is the same move that answers destructuring —
      // and for the same reason.  `import * as mod`, `const alias = mod`,
      // `let a; a = mod`, an `await`, an `as`: the type is the module namespace
      // through every one of those hops, so none of them needs a rule.  A
      // spread (`{ ...mod }`) is just an escape too, and its separate case is
      // gone with them.
      if (scan.escapes.length > 0) {
        const at = scan.escapes.map((each) => each.getStart());
        project.checker.getSymbolAtPosition(absolute, at).forEach((symbol, index) => {
          const escaped = scan.escapes[index];
          const offset = at[index];
          if (symbol === undefined || escaped === undefined || offset === undefined) return;
          const module = aliasTarget(symbol, project) ?? symbol;
          const isModule = (each: { kind: SyntaxKind }): boolean =>
            each.kind === SyntaxKind.SourceFile;
          // The name IS the module: `import * as mod; consume(mod)`.  One
          // batched symbol lookup answers this, which is most sites.
          if (module.declarations.some(isModule)) {
            for (const property of project.checker.getExportsOfModule(module)) {
              creditChain(property, { file, offset }, project);
            }
            return;
          }
          // Or a LOCAL holds it: `const alias = mod; consume(alias)`, and every
          // hop the value took — an assignment, an `await`, an `as` — is in the
          // TYPE, which is the same move that answers destructuring.  Asked
          // only of bindings, both because that is where the question arises
          // and because asking it of every escaping name walks the checker into
          // shapes it panics on.
          if (!module.declarations.some((each) => each.kind === SyntaxKind.VariableDeclaration)) {
            return;
          }
          const type = project.checker.getTypeAtLocation(asNode(escaped));
          if (type?.getSymbol()?.declarations.some(isModule) !== true) return;
          for (const property of project.checker.getPropertiesOfType(type)) {
            creditChain(property, { file, offset }, project);
          }
        });
      }

      // DESTRUCTURING, answered by the TYPE of what is destructured.  The
      // identifiers a pattern binds are new LOCALS, so resolving them answers
      // with the local; the property on the source type is the export itself.
      // Every hop the value took to get there — an alias, an `await`, an `as`,
      // a `.then` callback's contextual parameter — is already in that type,
      // which is why none of them needs a rule here.
      for (const site of scan.destructures) {
        const type = project.checker.getTypeAtLocation(asNode(site.source));
        if (type === undefined) continue;
        // A `...rest` element reads EVERY remaining enumerable property, so the
        // taken set is the type's whole property list rather than the names the
        // pattern happens to spell — and asking the type is the same move that
        // answered the named case, not a second mechanism beside it.
        // A COMPUTED key names its property through its type, exactly as
        // `mod[key]` does — so `const { [key]: value } = mod` is the same read.
        const named = [...site.names];
        for (const key of site.computed) {
          const keyType = project.checker.getTypeAtLocation(asNode(key));
          if (keyType?.isStringLiteralType() === true) named.push(String(keyType.value));
        }
        const taken = site.rest
          ? project.checker.getPropertiesOfType(type)
          : named.map((name) => project.checker.getPropertyOfType(type, name));
        for (const property of taken) {
          if (property !== undefined) {
            creditChain(property, { file, offset: site.at }, project);
          }
        }
      }

      if (scan.offsets.length === 0) continue;
      const resolved = project.checker.getSymbolAtPosition(absolute, scan.offsets);
      const destructured: number[] = [];
      resolved.forEach((symbol, index) => {
        const offset = scan.offsets[index];
        if (symbol === undefined || offset === undefined) return;
        if (symbol.declarations.some((handle) => handle.kind === SyntaxKind.BindingElement)) {
          destructured.push(offset);
        }
        creditChain(symbol, { file, offset }, project);
      });
      if (destructured.length > 0) {
        // One batched round trip for the destructured locals only.
        const types = project.checker.getTypeAtPosition(absolute, destructured);
        types.forEach((type, index) => {
          const offset = destructured[index];
          const origin = type?.getSymbol();
          if (origin !== undefined && offset !== undefined) {
            creditChain(origin, { file, offset }, project);
          }
        });
      }
    }

    const uses = new Map<string, readonly ReferenceSite[]>();
    /** declaration-site key → that declaration's own text range. */
    const ownRanges = new Map<string, Array<{ path: string; from: number; to: number }>>();

    for (const { binding, keys, symbol } of declared) {
      const project = ownerOf.get(resolve(root, binding.file));
      if (project === undefined) continue; // already reported as uncovered
      const cacheKey = keys.join(',');
      let ranges = ownRanges.get(cacheKey);
      if (ranges === undefined) {
        ranges = [];
        for (const handle of symbol.declarations) {
          const node = handle.resolve(project);
          if (node !== undefined) ranges.push({ path: handle.path, from: node.pos, to: node.end });
        }
        ownRanges.set(cacheKey, ranges);
      }
      const mentioned = new Map<string, ReferenceSite>();
      for (const key of keys) {
        for (const site of sites.get(key) ?? []) mentioned.set(`${site.file}:${site.offset}`, site);
      }
      const external = [...mentioned.values()].filter((site) => {
        const siteAbsolute = resolve(root, site.file);
        return !ranges.some(
          (range) =>
            range.path === siteAbsolute && site.offset >= range.from && site.offset < range.to,
        );
      });
      uses.set(declarationKey(binding.file, binding.offset), external);
    }

    return { exports, uses, uncovered, unreadable };
  });
}
