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
// LOCAL, so the compiler answers with that local and the export it came from
// looks unreferenced.  Two routes cover it: the module-specifier route credits
// the export the pattern names (an import clause and a destructuring pattern
// both bind BY EXPORT NAME, so no aliasing is possible), and the TYPE route
// asks what type the local has and credits that type's symbol, which works
// through arbitrary indirection.  The specifier route in turn covers exports
// whose type carries no symbol, such as a plain string constant.
//
// COVERAGE IS ASSERTED, not assumed.  A tracked file that belongs to no
// project's program is invisible, and an export used only from such a file would
// look dead — a FALSE POSITIVE, the one failure mode a gate in CI must never
// have.  So is a file the compiler treats as a module but whose module symbol
// cannot be read: its exports would silently not be judged at all.  Both are
// reported, and the caller refuses to run rather than guess.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { type NodeHandle, SyntaxKind } from 'typescript/unstable/ast';
import { API, type Project, SymbolFlags, type Symbol as TsSymbol } from 'typescript/unstable/sync';

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
function labelOf(node: NodeHandle, text: string): string {
  const known = KIND_LABEL.get(node.kind);
  if (known !== undefined) return known;
  if (node.kind === SyntaxKind.VariableDeclaration || node.kind === SyntaxKind.BindingElement) {
    // Walk out to the declaration LIST, whose first word is the keyword.
    let owner: NodeHandle | undefined = node;
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
function nameOf(node: NodeHandle | undefined): string | undefined {
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
function isUnchangedRepublish(node: NodeHandle, project: Project): boolean {
  const name = node.name;
  if (name === undefined) return false;
  const exported = nameOf(name);
  const source = nameOf(node.propertyName) ?? exported;
  if (exported === undefined || exported !== source) return false; // `as` renamed it
  // `export { live } from './x.js'` — the specifier's own module specifier.
  if (node.parent?.parent?.moduleSpecifier !== undefined) return true;
  // `import { live } from './x.js'; export { live }` — the local it publishes
  // is itself an import binding, so this is the same republish in two statements.
  const local = project.checker.getExportSpecifierLocalTargetSymbol(node);
  return local !== undefined && (local.flags & SymbolFlags.Alias) !== 0;
}

/** What one AST walk of a file collects. */
interface FileScan {
  /** Offsets of identifiers that could be a USE (plumbing already removed). */
  readonly offsets: number[];
  /** Sites naming exports of another module, for the specifier route. */
  readonly imports: Array<{ specifierOffset: number; names: string[]; offset: number }>;
}

/** Identifier parents that PUBLISH a name rather than consume one. */
const PLUMBING_PARENTS = new Set<number>([SyntaxKind.ExportSpecifier, SyntaxKind.NamespaceExport]);

/** Wrappers that yield the value they wrap, so a receiver may sit behind them. */
const TRANSPARENT_WRAPPERS = new Set<number>([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.TypeAssertionExpression,
]);

/** Function shapes that can receive the namespace as a `.then` callback. */
const CALLBACK_KINDS = new Set<number>([SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression]);

/** Literal kinds that can STATICALLY name a property: `mod['A']`, ``mod[`A`]``. */
const STATIC_KEY_KINDS = new Set<number>([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
]);

/**
 * Whether this literal is the KEY of an element access, not its object.
 *
 * `mod['LIVE']` names an export; `'abc'[0]` is a string being indexed, and
 * asking the compiler about it answers with `String.prototype`, not a module
 * binding.  The two are the same node kind in different positions, so the
 * position is what has to be checked.
 */
function isElementAccessKey(node: NodeHandle): boolean {
  const parent = node.parent;
  if (parent?.kind !== SyntaxKind.ElementAccessExpression) return false;
  return parent.argumentExpression?.getStart() === node.getStart();
}

/** Past every wrapper that yields the value it wraps: `(x)`, `x as T`, `x!`. */
function unwrap(node: NodeHandle | undefined): NodeHandle | undefined {
  let current = node;
  for (let hop = 0; current !== undefined && hop < MAX_ALIAS_HOPS; hop += 1) {
    if (!TRANSPARENT_WRAPPERS.has(current.kind)) return current;
    current = current.expression;
  }
  return current;
}

/**
 * The object binding pattern that destructures an `import('M')` namespace.
 *
 * A dynamic import's namespace reaches a pattern in exactly two ways, and both
 * must be read here — the identifiers a pattern binds are new LOCALS, so
 * resolving them answers with the local and M's export goes uncredited:
 *
 *   • by ASSIGNMENT — `const { A } = await import('M')`;
 *   • by CALLBACK — `import('M').then(({ A }) => …)`, where the namespace is the
 *     first parameter rather than an initializer.
 *
 * Reading only the first is a live false positive, not a hypothetical: this
 * repository already writes the second (`apps/web/src/routes/__root.tsx`), and
 * it survives today only because the export it names happens to be a FUNCTION,
 * whose type carries the origin symbol the fallback route recovers.  A primitive
 * export — a string or number constant, whose type carries no symbol — in that
 * same position would be reported dead and would fail a correct branch.
 */
function namespaceReceiver(importCall: NodeHandle): NodeHandle | undefined {
  const asPattern = (node: NodeHandle | undefined): NodeHandle | undefined =>
    node?.kind === SyntaxKind.ObjectBindingPattern ? node : undefined;

  // Climb through wrappers that do not change the VALUE — parentheses, `as`,
  // `satisfies`, a non-null `!`, an angle-bracket assertion — and through the
  // one `await`.  `const { A } = (await import('M'))` is the same consumer as
  // `const { A } = await import('M')`, and stopping at the parenthesis credited
  // neither; for a PRIMITIVE export the type route cannot recover it either, so
  // a correct branch failed.  Order is not fixed (`await (import(M))` is equally
  // valid), which is why this is a loop rather than two `if`s.
  let node = importCall;
  let awaited = false;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
    const parent = node.parent;
    if (parent === undefined) return undefined;
    if (TRANSPARENT_WRAPPERS.has(parent.kind)) {
      node = parent;
      continue;
    }
    if (parent.kind === SyntaxKind.AwaitExpression && !awaited) {
      awaited = true;
      node = parent;
      continue;
    }
    break;
  }

  const parent = node.parent;
  // `({ A } = await import('M'))` — a destructuring ASSIGNMENT straight from the
  // import, whose target parses as an object LITERAL.  Same consumer as the
  // declaration form one line down, a different node kind.
  if (
    awaited &&
    parent?.kind === SyntaxKind.BinaryExpression &&
    parent.operatorToken?.kind === SyntaxKind.EqualsToken &&
    parent.left?.kind === SyntaxKind.ObjectLiteralExpression
  ) {
    return parent.left;
  }
  // `const { A } = await import('M')` destructures the namespace directly;
  // `const mod = await import('M')` STORES it, and the caller records the local
  // so a later `const { A } = mod` can be credited to the same specifier.
  // A bare `import('M')` without `await` yields a PROMISE either way, whose
  // destructuring names promise members rather than exports.
  if (parent?.kind === SyntaxKind.VariableDeclaration) {
    if (!awaited) return undefined;
    const name = parent.name;
    if (name?.kind === SyntaxKind.ObjectBindingPattern) return name;
    return name?.kind === SyntaxKind.Identifier ? name : undefined;
  }
  // `import('M').then(({ A }) => …)`
  if (parent?.kind !== SyntaxKind.PropertyAccessExpression) return undefined;
  if (nameOf(parent.name) !== 'then') return undefined;
  const call = parent.parent;
  if (call?.kind !== SyntaxKind.CallExpression) return undefined;
  // The callback may itself sit behind transparent wrappers — `.then((({ A }) =>
  // …))` is the same consumer as `.then(({ A }) => …)` — so the unwrapping that
  // finds the import's receiver has to apply to the ARGUMENT too.
  const callback = unwrap(call.arguments?.[0]);
  if (callback === undefined || !CALLBACK_KINDS.has(callback.kind)) return undefined;
  return asPattern(callback.parameters?.[0]?.name);
}

/**
 * Collect, in one walk, every identifier offset and every module-specifier site.
 *
 * Walking the AST rather than a token stream is what makes nesting a non-issue:
 * a template interpolation inside another template interpolation is simply a
 * node inside a node, so there is no depth for the collector to get wrong.
 */
function scanFile(root: NodeHandle): FileScan {
  const scan: FileScan = { offsets: [], imports: [] };
  /**
   * Locals holding a dynamic import's namespace: `const mod = await import(M)`.
   *
   * A LIST per name, not one entry: if a file binds the same name to two
   * different modules in two scopes, crediting BOTH specifiers is the safe
   * direction — over-crediting makes a dead export look live (a false negative
   * the next run catches), while picking the wrong one would report a live
   * export as dead and fail a correct branch.
   */
  const namespaceLocals = new Map<string, number[]>();
  /** `const { A } = mod` sites, resolved after the whole file is walked, since
   *  the binding they read may be declared anywhere in it. */
  const deferredDestructures: Array<{ pattern: NodeHandle; from: NodeHandle }> = [];
  /**
   * `const alias = original` — an identifier copied from another identifier.
   *
   * A namespace keeps its provenance across such a hop, so
   * `import * as original from 'M'; const alias = original; const { A } = alias`
   * names M's export exactly as the un-aliased form does.  Collected during the
   * walk and followed afterwards, because the alias may be written before the
   * binding it copies.
   */
  const aliasEdges: Array<{ to: string; from: string }> = [];

  const namesOfPattern = (pattern: NodeHandle): string[] => {
    const names: string[] = [];
    pattern.forEachChild((element) => {
      // A DECLARATION's pattern holds `BindingElement`s; an ASSIGNMENT's target
      // is an object literal, whose members are shorthand or property
      // assignments.  Both name the export the same way, so both are read.
      if (
        element.kind !== SyntaxKind.BindingElement &&
        element.kind !== SyntaxKind.ShorthandPropertyAssignment &&
        element.kind !== SyntaxKind.PropertyAssignment
      ) {
        return;
      }
      // `{ a: renamed }` binds `renamed`; the EXPORT it names is the key `a`.
      const key = nameOf(element.propertyName ?? element.name);
      if (key !== undefined) names.push(key);
    });
    return names;
  };

  const visit = (node: NodeHandle): void => {
    if (node.kind === SyntaxKind.Identifier) {
      const parentKind = node.parent?.kind;
      if (parentKind === undefined || !PLUMBING_PARENTS.has(parentKind)) {
        scan.offsets.push(node.getStart());
      }
    } else if (STATIC_KEY_KINDS.has(node.kind) && isElementAccessKey(node)) {
      // `mod['LIVE']` names the export with a STRING, not an identifier.  It is
      // the same reference an identifier walk sees in `mod.LIVE`, and the
      // compiler resolves the literal's position to the very same symbol — so
      // the only thing that made it invisible was which node kinds get asked.
      scan.offsets.push(node.getStart());
    } else if (node.kind === SyntaxKind.ImportDeclaration) {
      // STATIC: `import { A, B as c } from 'M'` — the export side precedes `as`.
      const specifier = node.moduleSpecifier;
      const named = node.importClause?.namedBindings;
      // `import * as mod from 'M'` — the namespace is bound to a local, and a
      // later `const { A } = mod` destructures it exactly as a stored dynamic
      // import does.  Recorded in the SAME map, so the two spellings of "this
      // local holds a module" are answered by one lookup rather than two rules.
      if (specifier !== undefined && named?.kind === SyntaxKind.NamespaceImport) {
        const local = nameOf(named.name);
        if (local !== undefined) {
          const seen = namespaceLocals.get(local);
          if (seen === undefined) namespaceLocals.set(local, [specifier.getStart()]);
          else seen.push(specifier.getStart());
        }
      }
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
    } else if (
      node.kind === SyntaxKind.CallExpression &&
      node.expression?.kind === SyntaxKind.ImportKeyword
    ) {
      // DYNAMIC: the pattern that destructures the module binds new LOCALS, so
      // its identifiers resolve to those and never to M's exports.
      const specifier = node.arguments?.[0];
      if (specifier !== undefined && specifier.kind === SyntaxKind.StringLiteral) {
        const received = namespaceReceiver(node);
        // A DECLARATION's target is a binding pattern; an ASSIGNMENT's is an
        // object literal.  Both destructure the namespace.
        if (
          received?.kind === SyntaxKind.ObjectBindingPattern ||
          received?.kind === SyntaxKind.ObjectLiteralExpression
        ) {
          const names = namesOfPattern(received);
          if (names.length > 0) {
            scan.imports.push({
              specifierOffset: specifier.getStart(),
              names,
              offset: received.getStart(),
            });
          }
        } else if (received !== undefined) {
          // `const mod = await import('M')` — the namespace is STORED, and any
          // later `const { A } = mod` destructures it a statement away.  Record
          // the local so that destructuring can be credited to this specifier.
          const local = nameOf(received);
          if (local !== undefined) {
            const seen = namespaceLocals.get(local);
            if (seen === undefined) namespaceLocals.set(local, [specifier.getStart()]);
            else seen.push(specifier.getStart());
          }
        }
      }
    } else if (
      node.kind === SyntaxKind.VariableDeclaration &&
      node.name?.kind === SyntaxKind.Identifier &&
      unwrap(node.initializer)?.kind === SyntaxKind.Identifier
    ) {
      // `const alias = original` — carry any namespace provenance across it.
      const to = nameOf(node.name);
      const from = nameOf(unwrap(node.initializer));
      if (to !== undefined && from !== undefined && to !== from) aliasEdges.push({ to, from });
    } else if (
      node.kind === SyntaxKind.VariableDeclaration &&
      node.name?.kind === SyntaxKind.ObjectBindingPattern
    ) {
      // `const { A } = mod`, where `mod` holds a namespace — and `= (mod)` or
      // `= (mod as typeof …)`, which are the same read.
      const from = unwrap(node.initializer);
      if (from?.kind === SyntaxKind.Identifier) {
        deferredDestructures.push({ pattern: node.name, from });
      }
    } else if (
      node.kind === SyntaxKind.BinaryExpression &&
      node.operatorToken?.kind === SyntaxKind.EqualsToken &&
      node.left?.kind === SyntaxKind.ObjectLiteralExpression
    ) {
      // `({ A } = mod)` — a destructuring ASSIGNMENT into bindings that already
      // exist.  Its target parses as an object LITERAL rather than a binding
      // pattern, so a check keyed on `VariableDeclaration` never saw it, and the
      // assigned identifier resolves to the pre-existing local.
      const from = unwrap(node.right);
      if (from?.kind === SyntaxKind.Identifier) {
        deferredDestructures.push({ pattern: node.left, from });
      }
    }
    node.forEachChild(visit);
  };

  visit(root);
  // Follow alias edges to a fixed point, so a chain of copies still resolves.
  // Bounded by the edge count: each pass must add at least one binding or stop.
  for (let pass = 0; pass < aliasEdges.length; pass += 1) {
    let grew = false;
    for (const edge of aliasEdges) {
      const source = namespaceLocals.get(edge.from);
      if (source === undefined) continue;
      const existing = namespaceLocals.get(edge.to) ?? [];
      const merged = [...new Set([...existing, ...source])];
      if (merged.length !== existing.length) {
        namespaceLocals.set(edge.to, merged);
        grew = true;
      }
    }
    if (!grew) break;
  }
  for (const { pattern, from } of deferredDestructures) {
    const local = nameOf(from);
    if (local === undefined) continue;
    const names = namesOfPattern(pattern);
    if (names.length === 0) continue;
    for (const specifierOffset of namespaceLocals.get(local) ?? []) {
      scan.imports.push({ specifierOffset, names, offset: pattern.getStart() });
    }
  }
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
      const name = node?.name;
      if (node === undefined || name === undefined) continue;
      if (
        !judgeRepublished &&
        node.kind === SyntaxKind.ExportSpecifier &&
        isUnchangedRepublish(node, project)
      ) {
        continue;
      }
      const offset = name.getStart();
      found.push({
        binding: {
          file,
          name: symbol.name,
          kind: labelOf(node, text),
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

      const scan = scanFile(source.getOrCreateNodeAtIndex(0));

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
