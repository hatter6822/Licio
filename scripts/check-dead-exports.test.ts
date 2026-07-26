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
  dynamicallyImportedModules,
  exportedValues,
  findDeadExports,
  identifierCounts,
  isTestPath,
  moduleKeyOf,
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

describe('dynamicallyImportedModules', () => {
  const f = (path: string, content: string): { path: string; content: string } => ({
    path,
    content,
  });

  it('resolves a relative dynamic import against the importing file', () => {
    const mods = dynamicallyImportedModules([
      f('apps/web/src/components/Host.tsx', "lazy(() => import('./DevFastForward.js'))"),
    ]);
    expect(mods.has('apps/web/src/components/DevFastForward')).toBe(true);
  });

  it('resolves `..` segments', () => {
    const mods = dynamicallyImportedModules([
      f('packages/invariants/src/gwei/x.ts', "await import('../meri/index.js')"),
    ]);
    expect(mods.has('packages/invariants/src/meri/index')).toBe(true);
  });

  it('exempts ONLY the resolved module — not every file sharing its basename', () => {
    // The defect this replaced: keying on the BASENAME meant a single
    // `import('../meri/index.js')` exempted every `index.ts` in the repository,
    // and `index` / `service` / `routes` are exactly the names a monorepo
    // repeats — silently disabling the gate across most of the tree.
    const mods = dynamicallyImportedModules([
      f('packages/invariants/src/gwei/x.ts', "await import('../meri/index.js')"),
    ]);
    expect(mods.has('packages/invariants/src/meri/index')).toBe(true);
    expect(mods.has('packages/shared/src/index')).toBe(false);
    expect(moduleKeyOf('packages/shared/src/index.ts')).toBe('packages/shared/src/index');
  });

  it('captures an absolute /src path as apps/web-rooted (the Playwright harness form)', () => {
    const mods = dynamicallyImportedModules([
      f('apps/web/e2e/x.spec.ts', "const H = '/src/private-p2p/e2e-room-harness.ts';"),
    ]);
    expect(mods.has('apps/web/src/private-p2p/e2e-room-harness')).toBe(true);
  });

  it('ignores a STATIC import and a BARE package specifier', () => {
    const mods = dynamicallyImportedModules([
      f('a/b.ts', "import { x } from './helpers.js';\nawait import('@licio/private-p2p');"),
    ]);
    expect(mods.has('a/helpers')).toBe(false);
    expect(mods.size).toBe(0);
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

  it('exempts a module reached by a DYNAMIC import (the symbol is never named)', () => {
    const dead = findDeadExports([
      file('src/Lazy.tsx', 'export default function Lazy() {}'),
      file('src/Host.tsx', "const L = lazy(() => import('./Lazy.js'));"),
    ]);
    expect(dead).toEqual([]);
  });

  it('does NOT exempt an unrelated file sharing the imported basename', () => {
    const dead = findDeadExports([
      file('a/index.ts', "await import('../b/index.js');"),
      file('b/index.ts', 'export const REACHED = 1;'),
      file('c/index.ts', 'export const UNRELATED = 1;'),
    ]);
    expect(dead.map((d) => d.name)).toEqual(['UNRELATED']);
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
