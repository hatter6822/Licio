// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the unreferenced-export gate's pure core, plus one test that
// runs it against the REAL repository — so the suite, not only CI, fails the
// moment an unreferenced exported value lands.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exportedValues,
  findDeadExports,
  findInternalOnlyExports,
  identifierCounts,
  isTestPath,
  type SourceFile,
} from './check-dead-exports.js';

const ROOT = resolve(import.meta.dirname, '..');

const file = (path: string, content: string): SourceFile => ({
  path,
  content,
  isTest: isTestPath(path),
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
      expect.objectContaining({ name: 'buildIt', kind: 'export', selfOccurrences: 1 }),
    );
  });

  it('counts an UNALIASED clause specifier as two self-occurrences', () => {
    // `export { foo }` writes `foo` in the clause AND at its local declaration,
    // so two occurrences still mean nothing uses it.
    const source = 'function foo() {}\nexport { foo };';
    expect(exportedValues(source)).toContainEqual(
      expect.objectContaining({ name: 'foo', selfOccurrences: 2 }),
    );
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

  it('does not mistake an INITIALIZER for a binding', () => {
    expect(exportedValues('export const f = (p, q) => p + q;').map((v) => v.name)).toEqual(['f']);
    expect(exportedValues('export const RE = /a,b/;').map((v) => v.name)).toEqual(['RE']);
    expect(exportedValues('export const v = f(1, 2), w = 3;').map((v) => v.name)).toEqual([
      'v',
      'w',
    ]);
  });

  it('reports a later binding nothing consumes', () => {
    const dead = findDeadExports([
      file('src/a.ts', 'export const live = 1, UNUSED = 2;'),
      file('src/b.ts', "import { live } from './a.js';\nuse(live);"),
    ]);
    expect(dead.map((d) => `${d.kind} ${d.name}`)).toEqual(['const UNUSED']);
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
      { name: 'queue', kind: 'namespace', line: 1, selfOccurrences: 1, isDefault: false },
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

describe('identifierCounts', () => {
  it('counts identifiers in CODE', () => {
    expect(identifierCounts('const a = 1; a + a;').get('a')).toBe(3);
  });

  it('does NOT count a name mentioned only in a comment', () => {
    // A declaration's own JSDoc almost always names it, so counting prose would
    // let every documented export pass the gate with no consumer at all.
    const counts = identifierCounts('/** Foo does a thing. {@link Foo} */\nexport const Foo = 1;');
    expect(counts.get('Foo')).toBe(1);
  });

  it('does NOT count a name inside a string literal', () => {
    expect(identifierCounts('const x = 1;\nthrow new Error("x is bad");').get('x')).toBe(1);
  });

  it('DOES count a name inside a template interpolation — that is code', () => {
    // Fixtures are SOURCE TEXT, so the backticks and `${` belong to the code
    // under test; written as a template with escapes so the literal reads as one
    // string rather than a concatenation.
    const source = `const x = 1;\nconst m = \`v=\${x}\`;`;
    expect(identifierCounts(source).get('x')).toBe(2);
  });

  it('does NOT count the template TEXT around an interpolation', () => {
    const source = `const m = \`prose about Foo here \${y}\`;`;
    expect(identifierCounts(source).get('Foo')).toBeUndefined();
  });

  it('survives a regex literal containing quote characters', () => {
    // The dangerous case, and why this delegates to the repo's tokeniser: a
    // hand-rolled stripper reads the quote inside this regex as an unterminated
    // string and swallows the code after it, reporting LIVE symbols as dead.
    const source = `const re = /['"\`]/g;\nconst live = 1;\nuse(live);`;
    expect(identifierCounts(source).get('live')).toBe(2);
  });
});

describe('findDeadExports', () => {
  it('reports an exported value nothing references', () => {
    const dead = findDeadExports([
      file('src/a.ts', 'export const UNUSED = 1;'),
      file('src/b.ts', 'export const USED = 2;'),
      file('src/c.ts', "import { USED } from './b.js';\nconsole.log(USED);"),
    ]);
    expect(dead.map((d) => d.name)).toEqual(['UNUSED']);
  });

  it('reports an export whose only other mention is its own JSDoc', () => {
    const dead = findDeadExports([
      file('src/a.ts', '/** UNUSED is the thing. */\nexport const UNUSED = 1;'),
    ]);
    expect(dead.map((d) => d.name)).toEqual(['UNUSED']);
  });

  it('reports an ALIASED clause export that nothing consumes', () => {
    // The reviewer's case: `export { main as buildUpdateManifest }` publishes a
    // name that appears exactly once repo-wide.
    const dead = findDeadExports([
      file('scripts/x.ts', 'function main() {}\nmain();\nexport { main as buildIt };'),
    ]);
    expect(dead.map((d) => d.name)).toEqual(['buildIt']);
  });

  it('does NOT report a clause export that IS consumed', () => {
    const dead = findDeadExports([
      file('scripts/x.ts', 'function main() {}\nexport { main as buildIt };'),
      file('scripts/y.ts', "import { buildIt } from './x.js';\nbuildIt();"),
    ]);
    expect(dead).toEqual([]);
  });

  it('accepts a value referenced ONLY by a test (exporting for testability is legitimate)', () => {
    const dead = findDeadExports([
      file('src/a.ts', 'export function helper() {}'),
      file('src/__tests__/a.test.ts', "import { helper } from '../a.js';\nhelper();"),
    ]);
    expect(dead).toEqual([]);
  });

  it('does not scan declarations INSIDE test files', () => {
    const dead = findDeadExports([file('src/__tests__/a.test.ts', 'export const FIXTURE = 1;')]);
    expect(dead).toEqual([]);
  });

  it('never reports a DEFAULT export — the importer picks the name, not the file', () => {
    // `import Anything from './Lazy.js'` binds whatever name it likes, so the
    // declaration name carries no information about who uses the module.
    const dead = findDeadExports([
      file('src/Lazy.tsx', 'export default function Lazy() {}'),
      file('src/Host.tsx', "const L = lazy(() => import('./Lazy.js'));"),
    ]);
    expect(dead).toEqual([]);
  });

  it('never reports a default export even with NO importer at all', () => {
    // Whether the MODULE is reachable is a different question from the one this
    // gate answers, and the identifier count cannot distinguish the two cases.
    expect(findDeadExports([file('src/Lazy.tsx', 'export default function Lazy() {}')])).toEqual(
      [],
    );
  });

  it('DOES report the named exports of a dynamically imported module', () => {
    // The blind spot this closed: a whole-module exemption blanked 112 non-test
    // files.  A dynamic import spells its symbols at the call site exactly as a
    // static one does, so the scan can see them — and must.
    const dead = findDeadExports([
      file(
        'src/Lazy.tsx',
        'export default function Lazy() {}\nexport const USED = 1;\nexport const DEAD = 2;',
      ),
      file(
        'src/Host.tsx',
        "const L = lazy(() => import('./Lazy.js'));\nconst { USED } = await import('./Lazy.js');\nuse(USED);",
      ),
    ]);
    expect(dead.map((d) => d.name)).toEqual(['DEAD']);
  });

  it('reports a namespace re-export nothing consumes', () => {
    const dead = findDeadExports([
      file('src/queue.ts', 'export const enqueue = 1;\nuse(enqueue);'),
      file('src/index.ts', "export * as queue from './queue.js';"),
      // Consumers reach the module directly, so the barrel binding is dead.
      file('src/host.ts', "import { enqueue } from './queue.js';\nenqueue();"),
    ]);
    expect(dead.map((d) => `${d.kind} ${d.name}`)).toEqual(['namespace queue']);
  });

  it('does NOT report a namespace re-export the barrel consumers use', () => {
    // The live case in this repo: `offline/index.ts` publishes `queue`, and
    // `CommentParts.tsx` imports it from the barrel and calls `queue.enqueue()`.
    const dead = findDeadExports([
      file('src/queue.ts', 'export const enqueue = 1;'),
      file('src/index.ts', "export * as queue from './queue.js';"),
      file('src/host.ts', "import { queue } from './index.js';\nqueue.enqueue();"),
    ]);
    expect(dead).toEqual([]);
  });

  it('reports an OVERLOAD SET nothing consumes', () => {
    // Every signature plus the implementation writes the name once, so compared
    // one at a time the set looks referenced BY ITSELF: three declarations give
    // a corpus total of three against a baseline of one apiece.  The footprint
    // is summed per file+name, and the set is reported once.
    const overloads = [
      'export function orphan(a: string): void;',
      'export function orphan(a: number): void;',
      'export function orphan(a: unknown): void {}',
    ].join('\n');
    expect(findDeadExports([file('src/a.ts', overloads)]).map((d) => d.name)).toEqual(['orphan']);
  });

  it('does NOT report an overload set that IS consumed', () => {
    const overloads = [
      'export function used(a: string): void;',
      'export function used(a: unknown): void {}',
    ].join('\n');
    expect(
      findDeadExports([
        file('src/a.ts', overloads),
        file('src/b.ts', "import { used } from './a.js';\nused('x');"),
      ]),
    ).toEqual([]);
  });

  it('reports a dead `const enum`', () => {
    expect(
      findDeadExports([file('src/a.ts', 'export const enum Orphan { A }')]).map(
        (d) => `${d.kind} ${d.name}`,
      ),
    ).toEqual(['enum Orphan']);
  });

  it('sees a symbol reached through the NAMESPACE object of a dynamic import', () => {
    const dead = findDeadExports([
      file('src/mod.ts', 'export const createRoom = 1;'),
      file('src/host.ts', "const m = await import('./mod.js');\nm.createRoom();"),
    ]);
    expect(dead).toEqual([]);
  });

  it('still reports a module reached only by a STATIC import', () => {
    const dead = findDeadExports([
      file('src/a.ts', 'export const UNUSED = 1;\nexport const USED = 2;'),
      file('src/b.ts', "import { USED } from './a.js';\nconsole.log(USED);"),
    ]);
    expect(dead.map((d) => d.name)).toEqual(['UNUSED']);
  });

  it('does not confuse a SUBSTRING of another identifier for a reference', () => {
    const dead = findDeadExports([
      file('src/a.ts', 'export const RATE = 1;'),
      file('src/b.ts', 'const RATE_LIMIT = 5;\nconsole.log(RATE_LIMIT);'),
    ]);
    expect(dead.map((d) => d.name)).toEqual(['RATE']);
  });

  it('reports a dead CLUSTER one layer at a time (documented convergence)', () => {
    // `f` is dead; `A` is kept alive only BY `f`, so this run reports just `f`.
    const dead = findDeadExports([
      file('src/a.ts', 'export const A = 1;\nexport function f() {\n  return A;\n}'),
    ]);
    expect(dead.map((d) => d.name)).toEqual(['f']);
  });
});

describe('findInternalOnlyExports', () => {
  it('reports an export used only inside the file that declares it', () => {
    const dead = findInternalOnlyExports([
      file('src/a.ts', 'export const LIMIT = 1;\nfunction f() {\n  return LIMIT;\n}\nf();'),
    ]);
    expect(dead.map((d) => d.name)).toEqual(['LIMIT']);
  });

  it('does NOT report one a test reaches — exporting for testability is legitimate', () => {
    const dead = findInternalOnlyExports([
      file('src/a.ts', 'export const LIMIT = 1;\nexport function f() {\n  return LIMIT;\n}'),
      file('src/__tests__/a.test.ts', "import { LIMIT } from '../a.js';\nexpect(LIMIT);"),
    ]);
    expect(dead.map((d) => d.name)).toEqual([]);
  });

  it('does NOT report one another module imports', () => {
    const dead = findInternalOnlyExports([
      file('src/a.ts', 'export const LIMIT = 1;\nuse(LIMIT);'),
      file('src/b.ts', "import { LIMIT } from './a.js';\nuse(LIMIT);"),
    ]);
    expect(dead).toEqual([]);
  });

  it('is DISJOINT from findDeadExports — a symbol used nowhere is dead, not internal', () => {
    // Otherwise the same declaration would be reported twice, under two names
    // for two different problems, and fixing one would not clear the other.
    const files = [file('src/a.ts', 'export const NEVER_USED = 1;')];
    expect(findDeadExports(files).map((d) => d.name)).toEqual(['NEVER_USED']);
    expect(findInternalOnlyExports(files)).toEqual([]);
  });

  it('skips default exports, whose name is module-local either way', () => {
    const dead = findInternalOnlyExports([
      file('src/a.tsx', 'export default function Lazy() {}\nconst x = Lazy;\nuse(x);'),
    ]);
    expect(dead).toEqual([]);
  });

  it('handles a clause export confined to its file', () => {
    const dead = findInternalOnlyExports([
      file('src/a.ts', 'function main() {}\nmain();\nmain();\nexport { main as runIt };'),
    ]);
    // `runIt` occurs once, in the clause — which IS its self-occurrence, so it is
    // DEAD rather than internal-only.
    expect(dead).toEqual([]);
    expect(
      findDeadExports([file('src/a.ts', 'function main() {}\nexport { main as runIt };')]).map(
        (d) => d.name,
      ),
    ).toEqual(['runIt']);
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
  // This one test lexes the WHOLE tracked corpus (~13 MB, twice — the tokeniser's
  // `preferRegex` dual pass).  Standalone that is ~2s, but it runs alongside
  // eleven other vitest projects competing for the same cores, where the 5s
  // default is not a meaningful budget.  The CLI is the thing with a real
  // performance contract, and `pnpm check:dead-exports` is ~2s.
  it('has no exported value that nothing references', () => {
    const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
      cwd: ROOT,
      encoding: 'utf-8',
      maxBuffer: 1 << 28,
    })
      .split('\n')
      .filter((path) => path.length > 0)
      .filter((path) => !path.includes('/dist/') && !path.endsWith('.d.ts'))
      .filter((path) => !path.endsWith('routeTree.gen.ts'));

    const files: SourceFile[] = [];
    for (const path of tracked) {
      try {
        files.push({
          path,
          content: readFileSync(resolve(ROOT, path), 'utf-8'),
          isTest: isTestPath(path),
        });
      } catch {
        // Tracked but removed from the working tree (mid-refactor): skip.
      }
    }
    expect(findDeadExports(files).map((d) => `${d.file}: ${d.kind} ${d.name}`)).toEqual([]);
  }, 60_000);
});
