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
  dynamicallyImportedStems,
  exportedValues,
  findDeadExports,
  isTestPath,
  type SourceFile,
  stemOf,
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

  it('reports the declaration line for the error message', () => {
    const source = ['// SPDX', '', 'export const A = 1;'].join('\n');
    expect(exportedValues(source)[0]).toMatchObject({ name: 'A', kind: 'const', line: 3 });
  });
});

describe('dynamicallyImportedStems', () => {
  it('captures a lazy dynamic import', () => {
    const stems = dynamicallyImportedStems([
      "const L = lazy(() => import('./DevFastForward.js'));",
    ]);
    expect(stems.has('DevFastForward')).toBe(true);
  });

  it('captures an absolute /src path (the Playwright in-page harness form)', () => {
    const stems = dynamicallyImportedStems([
      "const HARNESS = '/src/private-p2p/e2e-room-harness.ts';",
    ]);
    expect(stems.has('e2e-room-harness')).toBe(true);
  });

  it('does NOT capture a static import — those name the symbols they use', () => {
    const stems = dynamicallyImportedStems(["import { a } from './helpers.js';"]);
    expect(stems.has('helpers')).toBe(false);
  });
});

describe('stemOf', () => {
  it('strips the directory and extension', () => {
    expect(stemOf('apps/web/src/components/X.tsx')).toBe('X');
    expect(stemOf('packages/lcap/src/cid/index.ts')).toBe('index');
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
  });
});
