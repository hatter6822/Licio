// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for compiler-backed export enumeration and reference resolution,
// against a REAL TypeScript program built in a temporary directory.
//
// A stubbed oracle would prove nothing here.  The whole point of this module is
// that it agrees with the compiler about what a file exports and what a name
// refers to, and every bug it exists to end is only observable against a real
// one: a same-named local counting as a consumer, a destructured dynamic import
// binding a new local, a barrel binding skipped by full alias resolution, one
// declaration getting different symbol ids in two projects — and, on the
// enumeration side, an entire class of TypeScript syntax a hand parser did not
// model.  So the fixtures are written to disk and compiled.
//
// The ENUMERATION cases below were once unit tests of a token-stream parser.
// They are kept, and answered by the compiler instead: the question "what does
// this file export?" has exactly one correct answer per source text, and the
// compiler is the artefact that knows it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  declarationKey,
  type ExportedBinding,
  type ReferenceSite,
  resolveExportReferences,
} from './resolve-export-references.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'preserve',
    moduleResolution: 'bundler',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['src'],
});

let root: string;

/** Every file the fixture project contains, repo-relative to `root`. */
const FILES: Record<string, string> = {
  // ── Enumeration: every shape that publishes a named value ────────────────
  'src/kinds.ts': [
    'export const A = 1;',
    'export let B = 2;',
    'export var C = 3;',
    'export function D(): void {}',
    'export class E {}',
    'export enum F {',
    '  x = 1,',
    '}',
    'export async function G(): Promise<void> {}',
    'export function* H(): Generator<number> {',
    '  yield 1;',
    '}',
    'export const enum I {',
    '  y = 1,',
    '}',
    // A default export publishes the binding `default`; the declaration's own
    // name is module-local, so it is out of scope and must NOT appear.
    'export default function unnamedByImporters(): void {}',
    // Types are erased and deliberately out of scope.
    'export type Ty = string;',
    'export interface Iface {',
    '  a: number;',
    '}',
  ].join('\n'),

  // ── Enumeration: declarator lists and destructuring ──────────────────────
  'src/lists.ts': [
    'export const listOne = 1,',
    '  listTwo = 2;',
    'export const { patternOne, patternTwo } = { patternOne: 1, patternTwo: 2 };',
    // The RENAMED target is the binding; the property key is not.
    'export const { key: renamedTarget } = { key: 1 };',
    // A default INSIDE a pattern is not a binding, and the comma in its call
    // arguments does not separate declarators.
    'const seed = (_a: number, _b: number): number => 1;',
    'export const { withDefault = seed(1, 2) } = { withDefault: 3 };',
    // A type ANNOTATION is not a binding, and the comma inside its type
    // arguments does not separate declarators.
    'export const annotated: Map<string, number> = new Map();',
    // A `<` in an INITIALIZER is a comparison, not a type-argument list — the
    // declarator after it is still a real export.
    'export const compared = 1 < 2,',
    '  afterComparison = 3;',
    // `as` / `satisfies` DO open type context in an initializer.
    "export const asserted = { a: 'x' } as const satisfies Record<'a', string>,",
    '  afterAssertion = 4;',
  ].join('\n'),

  // ── Enumeration: a GENERIC ARROW ─────────────────────────────────────────
  // `<T,>(…)` is type-parameter syntax, so the comma inside it separates type
  // parameters, not declarators — and the arrow's parameter is not an export.
  'src/generic.ts': ['export const generic = <T,>(value: T): T => value;'].join('\n'),

  // ── Enumeration: REGEX vs DIVISION ───────────────────────────────────────
  // Telling these apart needs full grammatical context.  A lexer that guessed
  // read `/ 1000)…` as the start of a regex literal, swallowed the rest of the
  // file, and silently dropped every export after this line.
  'src/division.ts': [
    'export function ratio(now: number, then: number): number {',
    '  return Math.round((now - then) / 1000); // > 0 ⇒ in the past',
    '}',
    'export const AFTER_DIVISION = 1;',
  ].join('\n'),

  // ── Enumeration: comments in declaration positions ───────────────────────
  'src/comments.ts': [
    'export /* between */ const COMMENTED = 1;',
    'const localForClause = 2;',
    'export {',
    '  // a comment inside the clause',
    '  localForClause,',
    '};',
  ].join('\n'),

  // ── Enumeration + reference: an EXPORT ALIAS is its own module binding ───
  // `export { shared as obsoleteAlias }` publishes a public name that exists
  // nowhere else.  Uses of the LOCAL `shared` inside this file are not uses of
  // that public name, so an alias nobody imports is dead in its own right.
  'src/alias-of-local.ts': [
    'const shared = 1;',
    'export function readsShared(): number {',
    '  return shared;',
    '}',
    'export { shared as obsoleteAlias };',
  ].join('\n'),

  // ── Enumeration: clause plumbing vs a new public name ────────────────────
  'src/source.ts': ['export const republished = 1;', 'export const toRename = 2;'].join('\n'),
  'src/plumbing.ts': [
    // One-statement republish: the same name, judged where it is declared.
    "export { republished } from './source.js';",
    // Two-statement spelling of the same thing.
    "import { toRename } from './source.js';",
    'export { toRename };',
    // An ALIASED re-export IS a new public name.
    "export { toRename as aliasedOut } from './source.js';",
    // A namespace re-export publishes one runtime binding.
    "export * as namespaceOut from './source.js';",
    // A bare star keeps every name's own spelling, judged at its declaration.
    "export * from './source.js';",
    // A type-only clause publishes no value.
    "export type { OnlyAType } from './types.js';",
  ].join('\n'),
  'src/types.ts': ['export type OnlyAType = string;'].join('\n'),

  // ── Reference: a same-named local is NOT a consumer ──────────────────────
  'src/collide.ts': ['export const status = 1;', 'export const alsoDead = 2;'].join('\n'),
  'src/uses-collide.ts': [
    'const status = 99;',
    'export function f(status: number): number {',
    '  return status;',
    '}',
    'export const g = status;',
  ].join('\n'),

  // ── Reference: plain import ──────────────────────────────────────────────
  'src/plain.ts': ['export const LIVE = 1;', 'export const DEAD = 2;'].join('\n'),
  'src/consumer.ts': ["import { LIVE } from './plain.js';", 'export const total = LIVE + 1;'].join(
    '\n',
  ),

  // ── Reference: WHOLESALE consumption of a namespace ──────────────────────
  // Enumerating a namespace observably reads every export and spells none, and
  // so does indexing it with a key whose type does not say which member it is.
  // The gate used to name the wholesale forms it knew (a spread, a `...rest`),
  // which reported live exports dead in every form it did not name.
  'src/enumerated.ts': [
    'export const FIRST = 1;',
    'export const SECOND = 2;',
    'export const THIRD = 3;',
  ].join('\n'),
  'src/enumerates.ts': [
    "import * as enumerated from './enumerated.js';",
    'export const names = Object.keys(enumerated);',
  ].join('\n'),
  'src/union-key.ts': ['export const ALPHA = 1;', 'export const BETA = 2;'].join('\n'),
  'src/union-reader.ts': [
    "import * as unionKey from './union-key.js';",
    'declare const flag: boolean;',
    "const key: keyof typeof unionKey = flag ? 'ALPHA' : 'BETA';",
    'export const picked = unionKey[key];',
  ].join('\n'),
  // The counterpart: indexing with a SINGLE known key must still leave the
  // others dead, or "credit everything" would quietly retire the whole gate.
  'src/single-key.ts': ['export const READ = 1;', 'export const UNREAD = 2;'].join('\n'),
  'src/single-reader.ts': [
    "import * as singleKey from './single-key.js';",
    "export const one = singleKey['READ'];",
  ].join('\n'),

  // ── Reference: a namespace reached through a LOCAL ───────────────────────
  'src/held-ns.ts': ['export const HELD_A = 1;', 'export const HELD_B = 2;'].join('\n'),
  'src/holds-ns.ts': [
    "import * as heldNs from './held-ns.js';",
    'const held = heldNs;',
    'export const shipped = consume(held);',
    'declare function consume(value: unknown): number;',
  ].join('\n'),
  // The counterpart: a namespace ASSIGNED to a local, then INDEXED, reads only
  // what it indexes — or "credit the module whenever a local touches it" would
  // retire the gate for that module.
  'src/assigned-ns.ts': ['export const ASSIGNED_READ = 1;', 'export const ASSIGNED_DEAD = 2;'].join(
    '\n',
  ),
  'src/assigns-ns.ts': [
    "import * as assignedNs from './assigned-ns.js';",
    'let held: typeof assignedNs;',
    'held = assignedNs;',
    'export const one = held.ASSIGNED_READ;',
  ].join('\n'),
  // A name in a TYPE position is not a use of the value.  `typeof mod` resolves
  // to the module symbol, so admitting it credited every export at once.
  'src/typed-ns.ts': ['export const TYPED_DEAD = 1;'].join('\n'),
  'src/types-ns.ts': [
    "import type * as typedNs from './typed-ns.js';",
    'export type Held = typeof typedNs;',
    'export const size: [Held] extends [never] ? 0 : 1 = 1;',
  ].join('\n'),

  // ── Reference: a namespace held in a PARAMETER ───────────────────────────
  'src/param-ns.ts': ['export const PARAM_A = 1;', 'export const PARAM_B = 2;'].join('\n'),
  'src/param-reader.ts': [
    "import * as paramNs from './param-ns.js';",
    'function consume(ns: typeof paramNs): string[] { return Object.keys(ns); }',
    'export const out = consume(paramNs);',
  ].join('\n'),

  // ── Reference: a namespace merely EVALUATED consumes nothing ─────────────
  'src/probed-ns.ts': ['export const PROBED_DEAD = 1;'].join('\n'),
  'src/probes-ns.ts': [
    "import * as probedNs from './probed-ns.js';",
    'export const present = typeof probedNs;',
    'export function check(): void { void probedNs; if (!probedNs) return; }',
    'export function ready(): boolean { return probedNs && present ? true : false; }',
  ].join('\n'),

  // ── Reference: a NESTED template interpolation is still code ─────────────
  // The only use of `NESTED` is two interpolations deep, in this same file.  A
  // collector that walked only the outer hole reported a live export as dead.
  'src/nested-template.ts': [
    'export const NESTED = 1;',
    // This string IS the fixture's source text, so the nested interpolation —
    // the thing under test — must reach disk literally, not be interpolated here.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text, written to disk verbatim
    'export const wrapper = `${`${NESTED}`}`;',
  ].join('\n'),

  // ── Reference: an unused barrel does not vouch for what it republishes ───
  'src/module.ts': ['export const orphan = 1;', 'export const viaAlias = 2;'].join('\n'),
  'src/barrel.ts': [
    "export { orphan } from './module.js';",
    "export { viaAlias as renamed } from './module.js';",
  ].join('\n'),

  // ── Reference: a DESTRUCTURED dynamic import binds a NEW LOCAL ───────────
  'src/lazy.ts': ['export function lazilyUsed(): number {', '  return 1;', '}'].join('\n'),
  'src/lazy-consumer.ts': [
    'export async function go(): Promise<number> {',
    "  const { lazilyUsed } = await import('./lazy.js');",
    '  return lazilyUsed();',
    '}',
  ].join('\n'),

  // ── Reference: a receiver behind TRANSPARENT WRAPPERS ───────────────────
  // Parentheses, `as`, `satisfies` and `!` yield the value they wrap, so the
  // binding pattern can sit behind any of them.  Primitives throughout: a
  // function export would survive this gap anyway, via the type route.
  'src/wrapped.ts': [
    'export const PAREN_LIVE = 1;',
    'export const AS_LIVE = 2;',
    'export const AWAIT_INSIDE = 3;',
  ].join('\n'),
  'src/wrapped-consumer.ts': [
    'export async function a(): Promise<number> {',
    "  const { PAREN_LIVE } = (await import('./wrapped.js'));",
    '  return PAREN_LIVE;',
    '}',
    'export async function b(): Promise<number> {',
    "  const { AS_LIVE } = (await import('./wrapped.js')) as typeof import('./wrapped.js');",
    '  return AS_LIVE;',
    '}',
    'export async function c(): Promise<number> {',
    "  const { AWAIT_INSIDE } = await (import('./wrapped.js'));",
    '  return AWAIT_INSIDE;',
    '}',
  ].join('\n'),

  // ── Reference: a `.then` callback behind transparent wrappers ───────────
  'src/wrapped-callback.ts': ['export const CALLBACK_LIVE = 12;'].join('\n'),
  'src/wrapped-callback-consumer.ts': [
    "export const pending = import('./wrapped-callback.js').then(",
    '  (({ CALLBACK_LIVE }) => CALLBACK_LIVE),',
    ');',
  ].join('\n'),

  // ── Reference: a destructuring assignment DIRECTLY from a dynamic import ─
  'src/direct-assign.ts': ['export const DIRECT_ASSIGN = 17;'].join('\n'),
  'src/direct-assign-consumer.ts': [
    'export async function read(): Promise<number> {',
    '  let DIRECT_ASSIGN: number;',
    "  ({ DIRECT_ASSIGN } = await import('./direct-assign.js'));",
    '  return DIRECT_ASSIGN;',
    '}',
  ].join('\n'),

  // ── Reference: an ASSIGNMENT-expression alias (not a declaration) ───────
  // Written for a finding that arrived AFTER the resolver stopped tracing
  // dataflow by hand, and passed with no code written for it: the pattern's
  // type is the namespace however the value reached the binding.
  'src/assign-alias.ts': ['export const VIA_ASSIGNMENT = 20;'].join('\n'),
  'src/assign-alias-consumer.ts': [
    "import * as original from './assign-alias.js';",
    'export function read(): number {',
    '  let alias: typeof original;',
    '  alias = original;',
    '  const { VIA_ASSIGNMENT } = alias;',
    '  return VIA_ASSIGNMENT;',
    '}',
  ].join('\n'),

  // ── Reference: namespace provenance across an identifier ALIAS ──────────
  'src/aliased-ns.ts': ['export const VIA_ALIAS = 18;', 'export const VIA_CHAIN = 19;'].join('\n'),
  'src/aliased-ns-consumer.ts': [
    "import * as original from './aliased-ns.js';",
    'export function one(): number {',
    '  const alias = original;',
    '  const { VIA_ALIAS } = alias;',
    '  return VIA_ALIAS;',
    '}',
    'export function two(): number {',
    '  const first = original;',
    '  const second = first;',
    '  const { VIA_CHAIN } = second;',
    '  return VIA_CHAIN;',
    '}',
  ].join('\n'),

  // ── Reference: a STATIC namespace import, destructured later ────────────
  'src/static-ns.ts': [
    'export const STATIC_NS_LIVE = 13;',
    'export const STATIC_NS_DEAD = 14;',
  ].join('\n'),
  'src/static-ns-consumer.ts': [
    "import * as ns from './static-ns.js';",
    'export function read(): number {',
    '  const { STATIC_NS_LIVE } = ns;',
    '  return STATIC_NS_LIVE;',
    '}',
  ].join('\n'),

  // ── Reference: a destructuring ASSIGNMENT, not a declaration ────────────
  'src/assigned.ts': ['export const ASSIGN_LIVE = 15;', 'export const ASSIGN_RENAMED = 16;'].join(
    '\n',
  ),
  'src/assigned-consumer.ts': [
    "import * as ns from './assigned.js';",
    'export function read(): number {',
    '  let ASSIGN_LIVE: number;',
    '  let local: number;',
    '  ({ ASSIGN_LIVE } = ns);',
    '  ({ ASSIGN_RENAMED: local } = ns);',
    '  return ASSIGN_LIVE + local;',
    '}',
  ].join('\n'),

  // ── Reference: the namespace STORED, then destructured a statement later ─
  'src/stored.ts': ['export const STORED_LIVE = 11;'].join('\n'),
  'src/stored-consumer.ts': [
    'export async function readLater(): Promise<number> {',
    "  const mod = await import('./stored.js');",
    '  const { STORED_LIVE } = mod;',
    '  return STORED_LIVE;',
    '}',
  ].join('\n'),

  // ── Reference: an ARBITRARY MODULE NAMESPACE NAME (ES2022) ──────────────
  // `export { value as "foo-bar" }` publishes a name no identifier can spell,
  // and the importer names it with a string literal.  Reading the source
  // spelling yields `"foo-bar"` WITH quotes, which matches nothing in the
  // export table and makes a consumed export look dead.
  'src/arbitrary.ts': ['const value = 9;', 'export { value as "foo-bar" };'].join('\n'),
  'src/arbitrary-consumer.ts': [
    'import { "foo-bar" as renamedLocal } from \'./arbitrary.js\';',
    'export const readsArbitrary = renamedLocal;',
  ].join('\n'),

  // ── Reference: a namespace ELEMENT ACCESS names the export with a string ─
  // `mod['ACCESSED']` is the same reference as `mod.ACCESSED`; only the node
  // kind differs, and an identifier-only walk never asks about it.
  'src/accessed.ts': ['export const ACCESSED = 3;', 'export const BY_TEMPLATE = 4;'].join('\n'),
  'src/accessor.ts': [
    "import * as mod from './accessed.js';",
    "export const readString = mod['ACCESSED'];",
    'export const readTemplate = mod[`BY_TEMPLATE`];',
  ].join('\n'),

  // ── Reference: a dynamic import destructured in a `.then` CALLBACK ───────
  // The namespace arrives as a parameter, not an initializer.  `THEN_LIVE` is a
  // PRIMITIVE deliberately: a function export survives this gap anyway, because
  // its type carries the origin symbol the fallback route recovers.
  'src/then.ts': ['export const THEN_LIVE = 5;'].join('\n'),
  'src/then-consumer.ts': [
    "export const pending = import('./then.js').then(({ THEN_LIVE }) => THEN_LIVE);",
  ].join('\n'),

  // ── Reference: an ALIASED re-export consumed through a dynamic import ────
  // The module's export table hands back the barrel's alias; crediting only
  // that left the original — the declaration actually consumed — looking dead.
  'src/aliased.ts': ['export const VALUE = 7;'].join('\n'),
  'src/alias-barrel.ts': ["export { VALUE as ALIAS } from './aliased.js';"].join('\n'),
  'src/alias-consumer.ts': [
    'export async function readIt(): Promise<number> {',
    "  const { ALIAS } = await import('./alias-barrel.js');",
    '  return ALIAS;',
    '}',
  ].join('\n'),

  // ── Reference: an object REST element, which reads what it never spells ──
  // `...rest` copies every remaining enumerable own property, so it consumes
  // exports no name in the pattern mentions — while the local it binds is not a
  // property of the module at all.  Both are PRIMITIVES, so nothing but the
  // property list can recover them.
  'src/rest-source.ts': ['export const REST_SWEPT = 1;', 'export const REST_NAMED = 2;'].join('\n'),
  'src/rest-consumer.ts': [
    'export async function sweep(): Promise<unknown> {',
    "  const { REST_NAMED, ...others } = await import('./rest-source.js');",
    '  return [REST_NAMED, others];',
    '}',
  ].join('\n'),

  // ── Reference: the same sweep spelled as an ASSIGNMENT ───────────────────
  // An object-literal target spells its rest element as a SpreadAssignment,
  // not as a dotted BindingElement.
  'src/rest-assigned-source.ts': ['export const REST_ASSIGNED = 3;'].join('\n'),
  'src/rest-assigned.ts': [
    'export async function sweepInto(): Promise<unknown> {',
    '  let held: Record<string, unknown> = {};',
    "  ({ ...held } = await import('./rest-assigned-source.js'));",
    '  return held;',
    '}',
  ].join('\n'),

  // ── Reference: an element-access key held in a CONSTANT ──────────────────
  // `mod[key]` after `const key = 'KEYED_LIVE' as const` reads exactly what
  // `mod['KEYED_LIVE']` reads; the two differ only in where the string is
  // written.  PRIMITIVE exports, so nothing but the key's type can recover them.
  'src/keyed.ts': ['export const KEYED_LIVE = 1;', 'export const KEYED_DEAD = 2;'].join('\n'),
  'src/keyed-consumer.ts': [
    "const key = 'KEYED_LIVE' as const;",
    'export async function readKeyed(): Promise<unknown> {',
    "  const mod = await import('./keyed.js');",
    '  return mod[key];',
    '}',
  ].join('\n'),

  // ── Enumeration: the IMPORT did the renaming ─────────────────────────────
  // `import { live as renamedIn }; export { renamedIn }` publishes a name the
  // source module never had — a new public runtime name, with no `as` on the
  // export specifier to show it.
  'src/rename-source.ts': ['export const originalName = 1;'].join('\n'),
  'src/rename-barrel.ts': [
    "import { originalName as renamedIn } from './rename-source.js';",
    'export { renamedIn };',
  ].join('\n'),

  // ── Reference: a COMPUTED destructuring key ──────────────────────────────
  // `const { [key]: value } = mod` reads the same export as `const { LIVE }`;
  // the key is a ComputedPropertyName, so only its TYPE names the property.
  'src/computed-key.ts': ['export const COMPUTED_LIVE = 1;'].join('\n'),
  'src/computed-key-consumer.ts': [
    "const which = 'COMPUTED_LIVE' as const;",
    'export async function readComputed(): Promise<unknown> {',
    "  const { [which]: value } = await import('./computed-key.js');",
    '  return value;',
    '}',
  ].join('\n'),

  // ── Reference: a whole namespace SPREAD ──────────────────────────────────
  // `{ ...mod }` reads every enumerable export, the mirror of `const { ...rest }
  // = mod` on the other side of the assignment.  PRIMITIVES, so only the
  // property list can recover them.
  'src/spread-source.ts': ['export const SPREAD_A = 1;', 'export const SPREAD_B = 2;'].join('\n'),
  'src/spread-consumer.ts': [
    "import * as everything from './spread-source.js';",
    'export const copy = { ...everything };',
  ].join('\n'),

  // ── Reference: from TYPE space only ──────────────────────────────────────
  // Neither of these survives compilation, and both are still references: the
  // declaration has to exist for the type to exist, so losing it is a compile
  // error rather than a cleanup.  See the test that pins this.
  'src/erased-source.ts': [
    'export class TypeOnlyClass {',
    '  readonly tag = 1;',
    '}',
    "export const KEPT_BY_TYPEOF = ['a', 'b'] as const;",
  ].join('\n'),
  'src/erased-consumer.ts': [
    "import type { TypeOnlyClass } from './erased-source.js';",
    "import { KEPT_BY_TYPEOF } from './erased-source.js';",
    'export type Held = TypeOnlyClass;',
    'export type Letter = (typeof KEPT_BY_TYPEOF)[number];',
  ].join('\n'),

  // ── Reference: used only inside its own file ─────────────────────────────
  'src/internal.ts': [
    'export const KEPT_INSIDE = 1;',
    'export function reader(): number {',
    '  return KEPT_INSIDE;',
    '}',
    "import { total } from './consumer.js';",
    'export const anchor = total;',
  ].join('\n'),
};

let exportsByFile: Map<string, ExportedBinding[]>;
let usesOf: (file: string, name: string) => readonly ReferenceSite[];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'licio-dead-exports-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG);
  for (const [path, content] of Object.entries(FILES)) {
    writeFileSync(join(root, path), `${content}\n`);
  }

  const resolved = resolveExportReferences({
    root,
    configs: [resolve(root, 'tsconfig.json')],
    files: Object.keys(FILES),
  });
  expect(resolved.uncovered).toEqual([]);
  expect(resolved.unreadable).toEqual([]);

  exportsByFile = new Map();
  for (const binding of resolved.exports) {
    const list = exportsByFile.get(binding.file);
    if (list === undefined) exportsByFile.set(binding.file, [binding]);
    else list.push(binding);
  }
  usesOf = (file, name) => {
    const binding = (exportsByFile.get(file) ?? []).find((each) => each.name === name);
    if (binding === undefined) return [];
    return resolved.uses.get(declarationKey(file, binding.offset)) ?? [];
  };
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** The exported NAMES of one fixture file, in source order. */
const namesIn = (file: string): string[] =>
  (exportsByFile.get(file) ?? []).map((binding) => binding.name);

describe('enumeration: what a file exports', () => {
  it('finds every exported value kind, and no type or default', () => {
    // `unnamedByImporters` is a default export: the binding it publishes is
    // `default`, so every importer picks its own name and this one is under no
    // obligation to appear anywhere.  `Ty`/`Iface` are erased at build.
    expect(namesIn('src/kinds.ts')).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  });

  it('finds EVERY binding a declarator list or pattern introduces', () => {
    expect(namesIn('src/lists.ts')).toEqual([
      'listOne',
      'listTwo',
      'patternOne',
      'patternTwo',
      // the RENAMED target, never the property key `key`
      'renamedTarget',
      // the pattern binding, never `seed`'s arguments
      'withDefault',
      // the annotated binding, never `string`/`number` from its type arguments
      'annotated',
      // a `<` comparison does not swallow the declarator that follows it
      'compared',
      'afterComparison',
      'asserted',
      'afterAssertion',
    ]);
  });

  it('reads a GENERIC ARROW type parameter as type syntax, not a declarator', () => {
    // `export const generic = <T,>(value: T) => value` publishes exactly one
    // name.  Reading that comma as a declarator separator invented `value` as
    // an export — a nonexistent dead export, which fails a correct branch.
    expect(namesIn('src/generic.ts')).toEqual(['generic']);
  });

  it('keeps enumerating past a DIVISION that a lexer would read as a regex', () => {
    // Telling `/` apart needs grammatical context.  Guessing wrong swallowed
    // the rest of the file, so every export below this line went unjudged —
    // silent, and in the repository it hid 12 real exports across 4 files.
    expect(namesIn('src/division.ts')).toEqual(['ratio', 'AFTER_DIVISION']);
  });

  it('sees declarations behind comments in any position', () => {
    expect(namesIn('src/comments.ts')).toEqual(['COMMENTED', 'localForClause']);
  });

  it('distinguishes clause PLUMBING from a new public name', () => {
    // `export { republished } from` and its two-statement spelling both name a
    // binding that is judged where it is declared; re-judging them would demand
    // deleting a name that is genuinely in use.  An alias and a namespace
    // binding are new public names that exist nowhere else.
    expect(namesIn('src/plumbing.ts')).toEqual(['aliasedOut', 'namespaceOut']);
  });

  it('records the declaration LINE and NAME offset for the report', () => {
    const [first] = exportsByFile.get('src/generic.ts') ?? [];
    expect(first?.line).toBe(1);
    expect(first?.kind).toBe('const');
    // The offset points at the NAME, which is what the gate keys and reports.
    expect(FILES['src/generic.ts']?.slice(first?.offset ?? 0, (first?.offset ?? 0) + 7)).toBe(
      'generic',
    );
  });
});

describe('resolution: which sites use a binding', () => {
  it('does NOT count a same-named local, parameter or shadowed binding', () => {
    // The defect this module exists for.  `uses-collide.ts` mentions `status`
    // four times — a local, a parameter, a read of the parameter, a read of the
    // local — and none of them is this export.
    expect(usesOf('src/collide.ts', 'status')).toHaveLength(0);
    expect(usesOf('src/collide.ts', 'alsoDead')).toHaveLength(0);
  });

  it('counts a real import', () => {
    expect(usesOf('src/plain.ts', 'LIVE').length).toBeGreaterThan(0);
    expect(usesOf('src/plain.ts', 'DEAD')).toHaveLength(0);
  });

  it.each([
    ['Object.keys enumeration', 'src/enumerated.ts', ['FIRST', 'SECOND', 'THIRD']],
    ['a union-typed key', 'src/union-key.ts', ['ALPHA', 'BETA']],
  ])('credits EVERY export consumed by %s', (_label, file, names) => {
    for (const name of names) {
      expect(usesOf(file, name).length).toBeGreaterThan(0);
    }
  });

  it('credits every export of a namespace held in a LOCAL', () => {
    // `const held = ns; consume(held)` hands the object over exactly as
    // `consume(ns)` does; the identifier resolves to the local, so the symbol
    // route alone could not see it and the TYPE is what knows.
    for (const name of ['HELD_A', 'HELD_B']) {
      expect(usesOf('src/held-ns.ts', name).length).toBeGreaterThan(0);
    }
  });

  it('credits only what an ASSIGNED namespace is indexed for', () => {
    // Binding is not escaping, however it is spelled — so the sibling stays
    // dead and the gate stays falsifiable.
    expect(usesOf('src/assigned-ns.ts', 'ASSIGNED_READ').length).toBeGreaterThan(0);
    expect(usesOf('src/assigned-ns.ts', 'ASSIGNED_DEAD')).toHaveLength(0);
  });

  it('does not credit a namespace named in a TYPE position', () => {
    // `typeof mod` resolves to the MODULE symbol.  Reading it as a value use
    // credited the whole export set — silently, in the direction a gate must
    // never fail — and asked the checker for the type of a node that is not an
    // expression, which ends the process rather than answering.
    expect(usesOf('src/typed-ns.ts', 'TYPED_DEAD')).toHaveLength(0);
  });

  it('credits a namespace consumed through a typed PARAMETER', () => {
    // `consume(ns: typeof mod)` reads the namespace inside the helper, and
    // restricting the type question to variables meant a helper typed to
    // receive one consumed nothing.
    for (const name of ['PARAM_A', 'PARAM_B']) {
      expect(usesOf('src/param-ns.ts', name).length).toBeGreaterThan(0);
    }
  });

  it('does not credit exports for a namespace only PROBED', () => {
    // `void mod`, `typeof mod` and `!mod` observe that it is there without
    // reading anything out of it, so crediting the whole export set for one
    // would make the gate accept a genuinely dead value.
    expect(usesOf('src/probed-ns.ts', 'PROBED_DEAD')).toHaveLength(0);
  });

  it('still reports the members a SINGLE known key does not read', () => {
    // The other half of the rule.  Crediting everything whenever a namespace is
    // touched would make the gate unfalsifiable, so a key the compiler can pin
    // to one name credits that name only.
    expect(usesOf('src/single-key.ts', 'READ').length).toBeGreaterThan(0);
    expect(usesOf('src/single-key.ts', 'UNREAD')).toHaveLength(0);
  });

  it('counts a use nested inside two template interpolations', () => {
    // `${`${NESTED}`}` — the only use of `NESTED`, and the one a collector that
    // walked a token stream's outer hole alone never reached.
    expect(usesOf('src/nested-template.ts', 'NESTED').length).toBeGreaterThan(0);
  });

  it('does not let an EXPORT ALIAS live on uses of the local it renames', () => {
    // `export { shared as obsoleteAlias }` is a public name nothing imports.
    // The internal `readsShared()` uses the LOCAL `shared`, which is a different
    // binding — so the unused public alias must still be reported.
    expect(namesIn('src/alias-of-local.ts')).toContain('obsoleteAlias');
    expect(usesOf('src/alias-of-local.ts', 'obsoleteAlias')).toHaveLength(0);
  });

  it('counts a DESTRUCTURED dynamic import, which binds a new local', () => {
    // `const { lazilyUsed } = await import('./lazy.js')` resolves the identifier
    // to that new local, never to the export, so this needs the specifier route.
    expect(usesOf('src/lazy.ts', 'lazilyUsed').length).toBeGreaterThan(0);
  });

  it.each(['PAREN_LIVE', 'AS_LIVE', 'AWAIT_INSIDE'])(
    'counts a dynamic import received behind a transparent wrapper (%s)',
    (name) => {
      // `(await import(M))`, `(await import(M)) as …`, `await (import(M))` —
      // all the same consumer.  Stopping at the wrapper credited none of them,
      // and a PRIMITIVE export has no origin symbol for the type route to
      // recover, so a correct branch failed.
      expect(usesOf('src/wrapped.ts', name).length).toBeGreaterThan(0);
    },
  );

  it('counts a `.then` callback wrapped in parentheses', () => {
    // The unwrapping that finds the import's receiver has to apply to the
    // ARGUMENT too: `.then((({ A }) => …))` is the same consumer as
    // `.then(({ A }) => …)`.
    expect(usesOf('src/wrapped-callback.ts', 'CALLBACK_LIVE').length).toBeGreaterThan(0);
  });

  it.each(['ASSIGN_LIVE', 'ASSIGN_RENAMED'])(
    'counts a destructuring ASSIGNMENT into existing bindings (%s)',
    (name) => {
      // `({ A } = ns)` targets an object LITERAL rather than a binding pattern,
      // so a check keyed on `VariableDeclaration` never saw it.
      expect(usesOf('src/assigned.ts', name).length).toBeGreaterThan(0);
    },
  );

  it('counts a destructuring assignment DIRECTLY from a dynamic import', () => {
    // `({ A } = await import(M))` — the assignment target is an object literal
    // and the import is its right-hand side, so neither the declaration path
    // nor the stored-namespace path saw it.
    expect(usesOf('src/direct-assign.ts', 'DIRECT_ASSIGN').length).toBeGreaterThan(0);
  });

  it('counts an ASSIGNMENT-expression alias, with no rule written for it', () => {
    // `let alias: typeof original; alias = original; const { A } = alias`.
    expect(usesOf('src/assign-alias.ts', 'VIA_ASSIGNMENT').length).toBeGreaterThan(0);
  });

  it.each(['VIA_ALIAS', 'VIA_CHAIN'])(
    'carries namespace provenance across an identifier alias (%s)',
    (name) => {
      // `const alias = original` keeps the namespace, and so does a chain of
      // them — the destructure a statement later still names M's export.
      expect(usesOf('src/aliased-ns.ts', name).length).toBeGreaterThan(0);
    },
  );

  it('counts a STATIC namespace import destructured later', () => {
    // `import * as ns from 'M'; const { A } = ns` binds the namespace exactly
    // as a stored dynamic import does, and a PRIMITIVE export has no origin
    // symbol for the type route to recover.
    expect(usesOf('src/static-ns.ts', 'STATIC_NS_LIVE').length).toBeGreaterThan(0);
  });

  it('does not OVER-credit the rest of a destructured namespace', () => {
    // Only the names the pattern actually binds are consumed; a sibling export
    // of the same module stays dead.  A pattern with NO rest element takes
    // exactly what it spells — which is what makes the two tests below a real
    // distinction rather than a blanket credit.
    expect(usesOf('src/static-ns.ts', 'STATIC_NS_DEAD')).toHaveLength(0);
  });

  it.each(['REST_SWEPT', 'REST_NAMED'])(
    'counts an export taken by an object REST element (%s)',
    (name) => {
      // `const { REST_NAMED, ...others } = await import('M')` reads both: the
      // rest binding copies every property the names left behind, and asking for
      // its own local name found no property, so the sweep credited nothing.
      expect(usesOf('src/rest-source.ts', name).length).toBeGreaterThan(0);
    },
  );

  it.each(['TypeOnlyClass', 'KEPT_BY_TYPEOF'])(
    'counts a value that only TYPE space names (%s)',
    (name) => {
      // Deliberate, and measured.  Review asked for the opposite — that a value
      // reached only through `import type` or a type position be reported dead,
      // since neither survives compilation.
      //
      // The two are not separable: a type-only import whose name is never USED
      // is an unused import, so whatever it names is credited by the type
      // position that uses it, and skipping the import specifier alone changes
      // nothing.  Skipping type positions too was tried against this repository
      // and reported 49 exports dead — `INTERACTION_KINDS` behind
      // `(typeof INTERACTION_KINDS)[number]`, `eligibilityDecisionSchema` behind
      // `z.infer<typeof …>`, and 47 more of the same shape.
      //
      // None of the gate's three remediations fits those: deleting one is a
      // compile error, and there is nothing to wire up or to dedupe.  A
      // declaration that its dependents cannot survive losing is referenced,
      // whether or not the reference survives to runtime.
      expect(usesOf('src/erased-source.ts', name).length).toBeGreaterThan(0);
    },
  );

  it('counts an element access whose key is a literal-typed CONSTANT', () => {
    // `const key = 'KEYED_LIVE' as const; mod[key]` reads the same export as
    // `mod['KEYED_LIVE']`.  Matching literal node kinds saw only the second.
    expect(usesOf('src/keyed.ts', 'KEYED_LIVE').length).toBeGreaterThan(0);
  });

  it('does not credit a sibling the keyed access never names', () => {
    expect(usesOf('src/keyed.ts', 'KEYED_DEAD')).toHaveLength(0);
  });

  it('judges a name the IMPORT renamed, republished without an `as`', () => {
    // `import { originalName as renamedIn }; export { renamedIn }` publishes a
    // public name that exists nowhere else — the export specifier carries no
    // `propertyName`, so only the alias TARGET's name reveals the rename.
    expect(namesIn('src/rename-barrel.ts')).toEqual(['renamedIn']);
  });

  it.each(['SPREAD_A', 'SPREAD_B'])('counts an export read by a namespace SPREAD (%s)', (name) => {
    // The identifier scan credited the namespace itself and none of what the
    // spread copies out of it, so `check:dead-exports` rejected valid code.
    expect(usesOf('src/spread-source.ts', name).length).toBeGreaterThan(0);
  });

  it('counts a destructuring key written as a COMPUTED name', () => {
    // The key is in its TYPE, exactly as `mod[key]` is — so it is read the same
    // way rather than by a rule about which spellings a pattern may use.
    expect(usesOf('src/computed-key.ts', 'COMPUTED_LIVE').length).toBeGreaterThan(0);
  });

  it('counts a rest element in a destructuring ASSIGNMENT', () => {
    // `({ ...held } = await import('M'))` — the same sweep, spelled as a
    // SpreadAssignment because the target is an object literal.
    expect(usesOf('src/rest-assigned-source.ts', 'REST_ASSIGNED').length).toBeGreaterThan(0);
  });

  it('counts a namespace STORED in a local and destructured later', () => {
    // `const mod = await import(M); const { A } = mod` — the pattern is a
    // statement away from the import, so a walk from the import alone never
    // reaches it, and a PRIMITIVE export has no origin symbol for the type
    // route to recover.
    expect(usesOf('src/stored.ts', 'STORED_LIVE').length).toBeGreaterThan(0);
  });

  it('counts an ARBITRARY MODULE NAMESPACE NAME, imported by string literal', () => {
    // `export { value as "foo-bar" }` consumed as
    // `import { "foo-bar" as renamedLocal }`.  The export table keys it
    // `foo-bar`; the source spells it `"foo-bar"`, quotes included.
    expect(usesOf('src/arbitrary.ts', 'foo-bar').length).toBeGreaterThan(0);
  });

  it('counts a namespace ELEMENT ACCESS naming the export with a string', () => {
    // `mod['ACCESSED']` and ``mod[`BY_TEMPLATE`]`` are ordinary references —
    // the compiler resolves the literal's position to the export symbol itself.
    // Only which node kinds get asked made them invisible, and an unasked
    // reference reports live code as dead.
    expect(usesOf('src/accessed.ts', 'ACCESSED').length).toBeGreaterThan(0);
    expect(usesOf('src/accessed.ts', 'BY_TEMPLATE').length).toBeGreaterThan(0);
  });

  it('counts a dynamic import destructured in a `.then` CALLBACK', () => {
    // `import('./then.js').then(({ THEN_LIVE }) => …)` — the namespace is a
    // PARAMETER, so a route that looked only for `const { … } = await import()`
    // never credited it.  This repo already writes that shape, and a PRIMITIVE
    // export in it (no origin symbol on the type for the fallback to recover)
    // would be reported dead — failing a correct branch.
    expect(usesOf('src/then.ts', 'THEN_LIVE').length).toBeGreaterThan(0);
  });

  it('does not let an unused BARREL vouch for what it republishes', () => {
    // `export { orphan } from './module.js'` is plumbing: publishing a name is
    // not consuming it, so `orphan` has no consumer at all.
    expect(usesOf('src/module.ts', 'orphan')).toHaveLength(0);
  });

  it('reports an ALIASED re-export separately from what it aliases', () => {
    // `renamed` is a public name that exists nowhere else, and nothing imports
    // it — so it is dead in its own right.
    expect(usesOf('src/barrel.ts', 'renamed')).toHaveLength(0);
  });

  it('follows the ALIAS CHAIN when crediting a name taken from a module', () => {
    // `export { VALUE as ALIAS } from './aliased.js'` consumed as
    // `const { ALIAS } = await import('./alias-barrel.js')`.  The export table
    // returns the barrel's alias; without walking behind it, the alias looks
    // live and `VALUE` — the declaration genuinely being read — looks dead,
    // which is a FALSE POSITIVE that fails a correct branch.
    expect(usesOf('src/aliased.ts', 'VALUE').length).toBeGreaterThan(0);
    expect(usesOf('src/alias-barrel.ts', 'ALIAS').length).toBeGreaterThan(0);
  });

  it('counts a use from the declaring file itself', () => {
    // Internal-only, not dead: the gate reports these separately, and a helper
    // exported so its own module's test can reach it is legitimate.
    const uses = usesOf('src/internal.ts', 'KEPT_INSIDE');
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((use) => use.file === 'src/internal.ts')).toBe(true);
  });
});

describe('coverage is asserted, not assumed', () => {
  it('reports a file that belongs to no project rather than calling it clean', () => {
    // A file outside every program is invisible, and an export only it consumes
    // would look dead — the one failure mode a CI gate must never have.
    const resolved = resolveExportReferences({
      root,
      configs: [resolve(root, 'tsconfig.json')],
      files: ['src/plain.ts', 'outside/stray.ts'],
    });
    expect(resolved.uncovered).toEqual(['outside/stray.ts']);
  });
});

describe('the repository itself', () => {
  it('has a tsconfig for every tracked source file', () => {
    // The gate refuses to run when this is false, so it is worth failing here
    // too: a workspace added without a tsconfig `include` would otherwise turn
    // the whole gate off with a message nobody reads.
    const repoRoot = resolve(import.meta.dirname, '..');
    const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 1 << 28,
    })
      .split('\n')
      .filter((path) => path.length > 0)
      .filter((path) => !path.includes('/dist/') && !path.endsWith('.d.ts'));
    expect(tracked.length).toBeGreaterThan(1000);
  });
});
