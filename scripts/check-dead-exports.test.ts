// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the POLICY side of the unreferenced-export gate: which files
// are judged, which declarations may opt out and on what terms, and how a
// verdict is drawn from the reference oracle.
//
// What a file exports, and which sites use each export, are questions about the
// TypeScript language.  They are answered by the compiler in
// `resolve-export-references.ts` and tested there against a real program —
// including every export shape this suite used to exercise against a
// hand-rolled parser.  Restating them here with a stub would only assert that
// the stub returns what it was given.
//
// What IS this project's own to decide is below, and it is all pure.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findDeadExports,
  findInternalOnlyExports,
  isReferenceOnlyPath,
  isTestPath,
  type ReferenceOracle,
  type SourceFile,
} from './check-dead-exports.js';
import { type ExportedBinding, findUncoveredFiles } from './resolve-export-references.js';

const ROOT = resolve(import.meta.dirname, '..');

const file = (path: string, content = ''): SourceFile => ({
  path,
  content,
  isTest: isReferenceOnlyPath(path),
});

/** An export as the compiler would have reported it. */
const binding = (
  path: string,
  name: string,
  extra: Partial<ExportedBinding> = {},
): ExportedBinding => ({
  file: path,
  name,
  kind: 'const',
  line: 1,
  offset: 0,
  ...extra,
});

/** An oracle that finds a use for the listed `path offset` pairs and no other. */
const oracle = (used: readonly string[]): ReferenceOracle => ({
  usesOf: (path, offset) =>
    used.includes(`${path} ${offset}`) ? [{ file: 'src/elsewhere.ts', offset: 0 }] : [],
});

describe('findDeadExports', () => {
  it('reports an exported value the oracle finds no use for', () => {
    const dead = findDeadExports([binding('src/a.ts', 'UNUSED')], [file('src/a.ts')], oracle([]));
    expect(dead.map((d) => `${d.kind} ${d.name}`)).toEqual(['const UNUSED']);
  });

  it('does not report one the oracle has a use for', () => {
    expect(
      findDeadExports([binding('src/a.ts', 'USED')], [file('src/a.ts')], oracle(['src/a.ts 0'])),
    ).toEqual([]);
  });

  it('does not judge declarations inside TEST or GENERATED files', () => {
    // Both are scanned for REFERENCES and never judged: a test may export
    // fixtures freely, and the router tree is rewritten by a plugin.
    expect(
      findDeadExports(
        [binding('src/__tests__/a.test.ts', 'FIXTURE')],
        [file('src/__tests__/a.test.ts')],
        oracle([]),
      ),
    ).toEqual([]);
    expect(
      findDeadExports(
        [binding('src/routeTree.gen.ts', 'Route')],
        [file('src/routeTree.gen.ts')],
        oracle([]),
      ),
    ).toEqual([]);
  });

  it('ignores an export whose file is not in the judged corpus at all', () => {
    expect(findDeadExports([binding('src/gone.ts', 'X')], [], oracle([]))).toEqual([]);
  });

  it('skips a declaration carrying a reasoned ENTRY marker', () => {
    // The one shape binding resolution cannot see: a module fetched by URL at
    // runtime, so no import edge to it exists.
    const source = [
      '/** dead-exports-entry: fetched by URL from a Playwright page.evaluate. */',
      'export function loadIt() {}',
    ].join('\n');
    expect(
      findDeadExports(
        [binding('src/h.ts', 'loadIt', { line: 2, kind: 'function' })],
        [file('src/h.ts', source)],
        oracle([]),
      ),
    ).toEqual([]);
  });

  it('REJECTS an entry marker with no reason', () => {
    // A bare marker is indistinguishable from a mistake, so the reason is what
    // makes the opt-out reviewable.
    const source = ['// dead-exports-entry:', 'export function loadIt() {}'].join('\n');
    expect(
      findDeadExports(
        [binding('src/h.ts', 'loadIt', { line: 2, kind: 'function' })],
        [file('src/h.ts', source)],
        oracle([]),
      ).map((d) => d.name),
    ).toEqual(['loadIt']);
  });

  it('does not let a marker on an UNRELATED line exempt a declaration', () => {
    // The walk stops at the first non-comment line above the declaration, so a
    // marker attached to something else higher up does not leak downward.
    const source = [
      '// dead-exports-entry: this one is genuinely loaded by URL.',
      'export function marked() {}',
      '',
      'export function unmarked() {}',
    ].join('\n');
    expect(
      findDeadExports(
        [
          binding('src/h.ts', 'marked', { line: 2, kind: 'function' }),
          binding('src/h.ts', 'unmarked', { line: 4, kind: 'function', offset: 1 }),
        ],
        [file('src/h.ts', source)],
        oracle([]),
      ).map((d) => d.name),
    ).toEqual(['unmarked']);
  });
});

describe('findInternalOnlyExports', () => {
  const usedFrom = (path: string, from: string): ReferenceOracle => ({
    usesOf: (f) => (f === path ? [{ file: from, offset: 0 }] : []),
  });

  it('reports a value used only from the file declaring it', () => {
    const internal = findInternalOnlyExports(
      [binding('src/a.ts', 'KEPT')],
      [file('src/a.ts')],
      usedFrom('src/a.ts', 'src/a.ts'),
    );
    expect(internal.map((d) => d.name)).toEqual(['KEPT']);
  });

  it('does NOT report one another file uses', () => {
    expect(
      findInternalOnlyExports(
        [binding('src/a.ts', 'SHARED')],
        [file('src/a.ts')],
        usedFrom('src/a.ts', 'src/b.ts'),
      ),
    ).toEqual([]);
  });

  it('is DISJOINT from findDeadExports — used nowhere is dead, not internal', () => {
    const exports = [binding('src/a.ts', 'NEVER')];
    const files = [file('src/a.ts')];
    expect(findDeadExports(exports, files, oracle([])).map((d) => d.name)).toEqual(['NEVER']);
    expect(findInternalOnlyExports(exports, files, oracle([]))).toEqual([]);
  });
});

describe('isTestPath', () => {
  it.each([
    'apps/api/src/__tests__/x.test.ts',
    'apps/web/src/lib/x.test.ts',
    'apps/web/e2e/x.spec.ts',
    'apps/web/src/test/setup.ts',
    'packages/lcap/src/test-vectors/x.ts',
    'packages/shared/src/update/test-helpers.ts',
  ])('treats %s as test-ish', (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  // Every pattern is ANCHORED.  An unanchored `-fixtures` matched anywhere in
  // the path, so production schemas exported from `@licio/governance` and
  // consumed by the treasury routes were classified test-only and never judged.
  // A gate that silently exempts production files by filename is worse than no
  // gate on them: the coverage it claims is not the coverage it has.
  it.each([
    'packages/governance/src/schemas/law-pack-fixtures.ts',
    'apps/api/src/simulator/link-fixtures.ts',
    'apps/api/src/routes/auth.ts',
    'packages/shared/src/schemas/common.ts',
  ])('treats %s as SOURCE, to be judged', (path) => {
    expect(isTestPath(path)).toBe(false);
  });

  it('still exempts a fixture that lives in a test directory', () => {
    expect(isTestPath('apps/api/src/__tests__/lcap-fixtures.ts')).toBe(true);
    expect(isTestPath('packages/shared/src/__tests__/event-fixtures.ts')).toBe(true);
  });

  it('treats a GENERATED file as reference-only without calling it a test', () => {
    expect(isTestPath('apps/web/src/routeTree.gen.ts')).toBe(false);
    expect(isReferenceOnlyPath('apps/web/src/routeTree.gen.ts')).toBe(true);
  });
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

    // A program LOAD, not a resolution pass: asking the full analysis would
    // cost the whole enumeration to check a property the open programs already
    // settle, and a minute-long unit test is one people stop running.
    expect(findUncoveredFiles({ files: tracked })).toEqual([]);
  }, 120_000);
});
