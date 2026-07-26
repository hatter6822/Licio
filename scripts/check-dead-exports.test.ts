// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the DECLARATION side of the unreferenced-export gate: what a
// source file exports, and which declarations are in scope to be judged.
//
// Whether an export is REFERENCED is a different question, answered by
// `resolve-export-references.ts` against a real TypeScript program and tested
// there.  A stub for it here would only restate "no uses ⇒ dead"; the semantics
// worth pinning — a same-named local is not a consumer, a barrel does not vouch
// for what it republishes, a destructured dynamic import IS a consumer — are
// only observable against a compiler.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exportedValues,
  findDeadExports,
  findInternalOnlyExports,
  isReferenceOnlyPath,
  isTestPath,
  type SourceFile,
} from './check-dead-exports.js';
import { resolveExportReferences } from './resolve-export-references.js';

const ROOT = resolve(import.meta.dirname, '..');

const file = (path: string, content: string): SourceFile => ({
  path,
  content,
  isTest: isReferenceOnlyPath(path),
});

describe('exportedValues', () => {
  it('finds every exported value kind', () => {
    const source = [
      'export const A = 1;',
      'export let B = 2;',
      'export var C = 3;',
      'export function D() {}',
      'export class E {}',
      'export enum F { x }',
      'export async function G() {}',
      'export default function H() {}',
    ].join('\n');
    expect(exportedValues(source).map((d) => d.name)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
    ]);
  });

  it('marks which declarations are DEFAULT exports', () => {
    const source = [
      'export const A = 1;',
      'export default function H() {}',
      'export default class K {}',
    ].join('\n');
    expect(exportedValues(source).map((d) => [d.name, d.isDefault])).toEqual([
      ['A', false],
      ['H', true],
      ['K', true],
    ]);
  });

  it('does NOT report types — they are erased and out of scope by policy', () => {
    const source = [
      'export type A = z.infer<typeof aSchema>;',
      'export interface B { x: number }',
      'export const c = 1;',
    ].join('\n');
    expect(exportedValues(source).map((d) => d.name)).toEqual(['c']);
  });

  it('ignores non-exported declarations and re-export lists', () => {
    const source = ['const a = 1;', 'function b() {}', "export { a, b } from './x.js';"].join('\n');
    expect(exportedValues(source)).toEqual([]);
  });

  it('reports a value published by an export CLAUSE', () => {
    const source = 'function main() {}\nexport { main as buildIt };';
    expect(exportedValues(source)).toContainEqual(
      expect.objectContaining({ name: 'buildIt', kind: 'export' }),
    );
  });

  it('reports a clause specifier that publishes a LOCAL declaration', () => {
    const source = 'function foo() {}\nexport { foo };';
    expect(exportedValues(source).map((v) => v.name)).toEqual(['foo']);
  });

  it('treats import-then-export as PLUMBING, like `export { X } from`', () => {
    // `import { X } from './a.js'; export { X };` republishes the same binding
    // under the same name — scanned at the declaration it came from.
    const source = "import { X } from './a.js';\nexport { X };";
    expect(exportedValues(source)).toEqual([]);
    // …but an ALIASED republish introduces a name that exists nowhere else.
    const aliased = "import { X } from './a.js';\nexport { X as Y };";
    expect(exportedValues(aliased).map((v) => v.name)).toEqual(['Y']);
  });

  it('records the declaration OFFSET, the handle the resolver needs', () => {
    const source = 'export const A = 1;';
    expect(exportedValues(source)[0]?.offset).toBe(source.indexOf('A'));
  });

  it('ignores a RE-export clause (barrel plumbing, scanned where it is declared)', () => {
    expect(exportedValues("export { x } from './y.js';")).toEqual([]);
  });

  it('ignores type-only export clauses and type specifiers', () => {
    expect(exportedValues("export type { A } from './a.js';")).toEqual([]);
    expect(exportedValues('export type { A };')).toEqual([]);
    expect(exportedValues('export { type A, b };').map((d) => d.name)).toEqual(['b']);
  });

  it('finds EVERY binding a declarator list introduces', () => {
    // One declaration can publish many names; taking only the first left the
    // rest outside both the gate and the internal-only survey.
    expect(exportedValues('export const live = 1, UNUSED = 2;').map((v) => v.name)).toEqual([
      'live',
      'UNUSED',
    ]);
    expect(exportedValues('export let a = 1, b = 2, c = 3;').map((v) => v.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('finds the bindings of a destructuring export', () => {
    expect(exportedValues('export const { a, b } = obj;').map((v) => v.name)).toEqual(['a', 'b']);
    expect(exportedValues('export const [x, , y] = arr;').map((v) => v.name)).toEqual(['x', 'y']);
  });

  it('takes the RENAMED target of a pattern, not the property key', () => {
    expect(exportedValues('export const { a: renamed } = obj;').map((v) => v.name)).toEqual([
      'renamed',
    ]);
    expect(exportedValues('export const { a: { b } } = obj;').map((v) => v.name)).toEqual(['b']);
  });

  it('ignores a DEFAULT value inside a pattern', () => {
    expect(exportedValues('export const { a = 1, b } = obj;').map((v) => v.name)).toEqual([
      'a',
      'b',
    ]);
  });

  it('does not mistake a TYPE ANNOTATION for a binding', () => {
    // The comma inside `Map<string, number>` is not a declarator separator, and
    // `Map`/`string`/`number` are not names this declaration binds.
    expect(
      exportedValues('export const parsed: Map<string, number> = new Map();').map((v) => v.name),
    ).toEqual(['parsed']);
    expect(exportedValues('export let a: number, b: string;').map((v) => v.name)).toEqual([
      'a',
      'b',
    ]);
  });

  it('reads `<` in an INITIALIZER as a comparison, not a type argument', () => {
    // `export const live = left < right, other = 2` counted the `<` as an
    // unclosed type-argument list, swallowed the declarator comma, and never
    // recorded `other` — an unreferenced export passing the gate.  Angles are
    // type syntax only inside a `:` annotation.
    expect(
      exportedValues('export const live = left < right, orphan = 2;').map((v) => v.name),
    ).toEqual(['live', 'orphan']);
    expect(exportedValues('export const a = x > y, b = 2;').map((v) => v.name)).toEqual(['a', 'b']);
    expect(exportedValues('export const f = (p, q) => p < q, g = 3;').map((v) => v.name)).toEqual([
      'f',
      'g',
    ]);
    // …while an ANNOTATION's angles still hide their commas.
    expect(
      exportedValues('export const m: Map<string, Set<number>> = new Map(), n = 1;').map(
        (v) => v.name,
      ),
    ).toEqual(['m', 'n']);
  });

  it('treats `as` / `satisfies` as opening TYPE context in an initializer', () => {
    // `as const satisfies Record<keyof K, string>` puts type syntax INSIDE an
    // initializer, so the comma in `Record<…>` is not a declarator separator.
    // Missing this recorded `string` as an exported binding — caught by the
    // gate refusing to run when the parser and the compiler disagree.
    expect(
      exportedValues('export const L = { a: 1 } as const satisfies Record<keyof K, string>;').map(
        (v) => v.name,
      ),
    ).toEqual(['L']);
    expect(
      exportedValues('export const x = y as Map<string, number>, z = 1;').map((v) => v.name),
    ).toEqual(['x', 'z']);
  });

  it('does not read a comma NESTED in a default as a declarator separator', () => {
    // `{ a = f(first, phantom), b }` — that comma separates the CALL's
    // arguments.  Reading it as the pattern's separator recorded `phantom` as
    // an export: a nonexistent dead export, which fails a correct branch.
    for (const source of [
      'export const { a = f(first, phantom), b } = obj;',
      'export const { a = [1, 2], b } = obj;',
      'export const { a = { x: 1, y: 2 }, b } = obj;',
    ]) {
      expect(exportedValues(source).map((v) => v.name)).toEqual(['a', 'b']);
    }
  });

  it('does not mistake an INITIALIZER for a binding', () => {
    expect(exportedValues('export const f = (p, q) => p + q;').map((v) => v.name)).toEqual(['f']);
    expect(exportedValues('export const RE = /a,b/;').map((v) => v.name)).toEqual(['RE']);
    expect(exportedValues('export const v = f(1, 2), w = 3;').map((v) => v.name)).toEqual([
      'v',
      'w',
    ]);
  });

  it('gives every binding of a list its own offset', () => {
    // The resolver keys on the offset, so two bindings sharing one declaration
    // must still be distinguishable.
    const source = 'export const live = 1, UNUSED = 2;';
    const offsets = exportedValues(source).map((v) => [v.name, v.offset]);
    expect(offsets).toEqual([
      ['live', source.indexOf('live')],
      ['UNUSED', source.indexOf('UNUSED')],
    ]);
  });

  // A block comment is legal between `export` and the keyword, and beside a
  // clause specifier.  A whitespace-and-identifier pattern cannot see past one,
  // so an unreferenced export hiding behind a comment used to pass the gate.
  // Built through `block()` so the fixture's `*/` never closes this file's own.
  const block = (text: string): string => `/${'*'} ${text} ${'*'}/`;

  it('parses past a COMMENT between `export` and the keyword', () => {
    expect(
      exportedValues(`export ${block('retained API')} const orphan = 1;`).map((v) => v.name),
    ).toEqual(['orphan']);
    expect(exportedValues(`export ${block('x')} function orphan() {}`).map((v) => v.name)).toEqual([
      'orphan',
    ]);
    expect(
      exportedValues(`export ${block('x')} default ${block('y')} function orphan() {}`).map(
        (v) => v.name,
      ),
    ).toEqual(['orphan']);
  });

  it('parses past a comment INSIDE an export clause', () => {
    expect(
      exportedValues(`function orphan(){}\nexport { orphan ${block('retained')} };`).map(
        (v) => v.name,
      ),
    ).toEqual(['orphan']);
    expect(
      exportedValues(`function a(){}\nexport { a ${block('x')} as b };`).map((v) => v.name),
    ).toEqual(['b']);
  });

  it('parses past a MULTI-LINE or line comment, which no blanking pass could', () => {
    expect(exportedValues('export /*\n  long\n*/ const orphan = 1;').map((v) => v.name)).toEqual([
      'orphan',
    ]);
    expect(exportedValues('export // why\nconst orphan = 1;').map((v) => v.name)).toEqual([
      'orphan',
    ]);
  });

  it('does not read a property or object key named `export` as a declaration', () => {
    expect(exportedValues('const v = obj.export;')).toEqual([]);
    expect(exportedValues('const o = { export: 1 };')).toEqual([]);
    expect(exportedValues("const s = 'export const fake = 1;';")).toEqual([]);
  });

  it('reads `export const enum` as an ENUM, not a variable binding', () => {
    // `const` there belongs to the enum declaration.  Without this the enum was
    // invisible AND the binding walk recorded the literal word `enum` as a name.
    expect(exportedValues('export const enum Orphan { A }').map((v) => [v.kind, v.name])).toEqual([
      ['enum', 'Orphan'],
    ]);
    expect(exportedValues('export declare const enum D { A }').map((v) => v.name)).toEqual(['D']);
    // …while an ordinary binding whose name merely starts with `enum` is not.
    expect(exportedValues('export const enumLike = 1;').map((v) => [v.kind, v.name])).toEqual([
      ['const', 'enumLike'],
    ]);
  });

  it('finds a GENERATOR export in every spacing the grammar allows', () => {
    // `function*` puts a `*` where the scan required whitespace, so none of
    // these were seen at all — `identifierCandidates` and `writePackChunks`
    // were live exports sitting outside the gate.
    const source = [
      'export function* a() {}',
      'export function *b() {}',
      'export function * c() {}',
      'export async function* d() {}',
      'export default function* e() {}',
    ].join('\n');
    expect(exportedValues(source).map((v) => [v.name, v.kind, v.isDefault])).toEqual([
      ['a', 'function', false],
      ['b', 'function', false],
      ['c', 'function', false],
      ['d', 'function', false],
      ['e', 'function', true],
    ]);
  });

  it('reports a NAMESPACE re-export, which no declaration keyword introduces', () => {
    // `export * as queue from './queue.js'` publishes one named runtime binding.
    // Neither the keyword pattern nor the clause parser sees it, so a dead one
    // used to slip through the gate entirely.
    expect(exportedValues("export * as queue from './queue.js';")).toEqual([
      expect.objectContaining({ name: 'queue', kind: 'namespace', line: 1, isDefault: false }),
    ]);
  });

  it('ignores a bare `export * from` — those names keep their own spelling', () => {
    // Republished under the names their declarations already carry, each scanned
    // where it lives — the same reasoning that excludes `export { x } from`.
    expect(exportedValues("export * from './other.js';")).toEqual([]);
  });

  it('ignores `export * as default from`, whose name is module-local', () => {
    expect(exportedValues("export * as default from './d.js';")).toEqual([]);
  });

  it('reports the declaration line for the error message', () => {
    const source = ['// SPDX', '', 'export const A = 1;'].join('\n');
    expect(exportedValues(source)[0]).toMatchObject({ name: 'A', kind: 'const', line: 3 });
  });
});

// The dead/alive SEMANTICS now live in the resolver, which is tested against a
// real compiler in `resolve-export-references.test.ts` — a stub here would only
// restate the trivial "no uses ⇒ dead". What these cover is the part that stayed
// in this module: which declarations are IN SCOPE to be judged at all.
const oracle = (used: Iterable<string>) => {
  const live = new Set(used);
  return {
    usesOf: (file: string, offset: number) =>
      live.has(`${file} ${offset}`) ? [{ file: 'src/other.ts', offset: 0 }] : [],
  };
};

describe('findDeadExports', () => {
  it('reports an exported value the oracle finds no use for', () => {
    const dead = findDeadExports([file('src/a.ts', 'export const UNUSED = 1;')], oracle([]));
    expect(dead.map((d) => `${d.kind} ${d.name}`)).toEqual(['const UNUSED']);
  });

  it('does not report one the oracle has a use for', () => {
    const source = 'export const USED = 1;';
    const at = `src/a.ts ${source.indexOf('USED')}`;
    expect(findDeadExports([file('src/a.ts', source)], oracle([at]))).toEqual([]);
  });

  it('does not judge declarations inside TEST or GENERATED files', () => {
    // Both are scanned for REFERENCES and never judged: a test may export
    // fixtures freely, and the router tree is rewritten by a plugin.
    expect(
      findDeadExports([file('src/__tests__/a.test.ts', 'export const FIXTURE = 1;')], oracle([])),
    ).toEqual([]);
    expect(
      findDeadExports([file('src/routeTree.gen.ts', 'export const Route = 1;')], oracle([])),
    ).toEqual([]);
  });

  it('never judges a DEFAULT export — the importer picks the name', () => {
    expect(
      findDeadExports([file('src/a.tsx', 'export default function Lazy() {}')], oracle([])),
    ).toEqual([]);
  });

  it('skips a declaration carrying a reasoned ENTRY marker', () => {
    // The one shape binding resolution cannot see: a module fetched by URL at
    // runtime, so no import edge to it exists.
    const source = [
      '/** dead-exports-entry: fetched by URL from a Playwright page.evaluate. */',
      'export function loadIt() {}',
    ].join('\n');
    expect(findDeadExports([file('src/h.ts', source)], oracle([]))).toEqual([]);
  });

  it('REJECTS an entry marker with no reason', () => {
    const source = ['// dead-exports-entry:', 'export function loadIt() {}'].join('\n');
    expect(findDeadExports([file('src/h.ts', source)], oracle([])).map((d) => d.name)).toEqual([
      'loadIt',
    ]);
  });
});

describe('findInternalOnlyExports', () => {
  const usedFrom = (file: string, offset: number, from: string) => ({
    usesOf: (f: string, o: number) =>
      f === file && o === offset ? [{ file: from, offset: 0 }] : [],
  });

  it('reports a value used only from the file declaring it', () => {
    const source = 'export const KEPT = 1;\nuse(KEPT);';
    const at = source.indexOf('KEPT');
    const internal = findInternalOnlyExports(
      [file('src/a.ts', source)],
      usedFrom('src/a.ts', at, 'src/a.ts'),
    );
    expect(internal.map((d) => d.name)).toEqual(['KEPT']);
  });

  it('does NOT report one another file uses', () => {
    const source = 'export const SHARED = 1;';
    const at = source.indexOf('SHARED');
    expect(
      findInternalOnlyExports([file('src/a.ts', source)], usedFrom('src/a.ts', at, 'src/b.ts')),
    ).toEqual([]);
  });

  it('is DISJOINT from findDeadExports — used nowhere is dead, not internal', () => {
    const files = [file('src/a.ts', 'export const NEVER = 1;')];
    expect(findDeadExports(files, oracle([])).map((d) => d.name)).toEqual(['NEVER']);
    expect(findInternalOnlyExports(files, oracle([]))).toEqual([]);
  });
});

describe('isTestPath', () => {
  it.each([
    'apps/api/src/__tests__/x.test.ts',
    'apps/web/src/lib/x.test.ts',
    'apps/web/e2e/x.spec.ts',
    'apps/web/src/test/setup.ts',
    'packages/lcap/src/test-vectors/x.ts',
  ])('treats %s as test-ish', (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  it.each(['apps/api/src/routes/auth.ts', 'packages/shared/src/schemas/common.ts'])(
    'treats %s as source',
    (path) => {
      expect(isTestPath(path)).toBe(false);
    },
  );
});

describe('the REAL repository', () => {
  // The dead/alive answer itself needs a full compiler snapshot (~45s), which
  // belongs to the gate — `pnpm check:dead-exports`, run in CI's lint job — not
  // to a unit suite running eleven projects in parallel.
  //
  // What IS worth asserting here is the gate's PRECONDITION: every tracked
  // source file must belong to some tsconfig, because a file outside every
  // program is invisible to the resolver and an export only it consumes would be
  // reported dead.  The gate refuses to run in that state, so a workspace added
  // without a tsconfig `include` would turn the whole check off — with a message
  // that only appears in a job nobody reads on a green build.
  it('has every tracked source file inside a TypeScript project', () => {
    const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
      cwd: ROOT,
      encoding: 'utf-8',
      maxBuffer: 1 << 28,
    })
      .split('\n')
      .filter((path) => path.length > 0)
      .filter((path) => !path.includes('/dist/') && !path.endsWith('.d.ts'));
    expect(tracked.length).toBeGreaterThan(1000);

    // No identifier offsets: this asks only which files the programs contain,
    // so it is a program load rather than a resolution pass.
    const resolved = resolveExportReferences({
      files: tracked,
      identifierOffsets: () => [],
      importedNames: () => [],
      declarations: [],
    });
    expect(resolved.uncovered).toEqual([]);
  }, 120_000);
});
