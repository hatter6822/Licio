// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for the binding-accurate reference resolver, against a REAL TypeScript
// program built in a temporary directory.
//
// A stubbed oracle would prove nothing here: the whole point of this module is
// that it agrees with the compiler about what a name refers to, and every bug it
// was written to fix (a same-named local counting as a consumer, a destructured
// dynamic import binding a new local, a barrel binding skipped by full alias
// resolution, one declaration getting different symbol ids in two projects) is
// only observable against a real one.  So the fixtures are written to disk and
// compiled.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identifierOffsets, importedNames } from './check-dead-exports.js';
import { declarationKey, resolveExportReferences } from './resolve-export-references.js';

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
  // A declaration whose name collides with unrelated locals elsewhere — the
  // case that motivated the whole module.
  'src/collide.ts': ['export const status = 1;', 'export const alsoDead = 2;'].join('\n'),
  'src/uses-collide.ts': [
    'const status = 99;',
    'export function f(status: number): number {',
    '  return status;',
    '}',
    'export const g = status;',
  ].join('\n'),
  // Plain live/dead.
  'src/plain.ts': ['export const LIVE = 1;', 'export const DEAD = 2;'].join('\n'),
  'src/consumer.ts': ["import { LIVE } from './plain.js';", 'export const total = LIVE + 1;'].join(
    '\n',
  ),
  // A barrel nobody imports, plus an aliased re-export.
  'src/module.ts': ['export const orphan = 1;', 'export const viaAlias = 2;'].join('\n'),
  'src/barrel.ts': [
    "export { orphan } from './module.js';",
    "export { viaAlias as renamed } from './module.js';",
  ].join('\n'),
  // Destructured dynamic import — binds a NEW LOCAL, so the identifier never
  // resolves to the export.
  'src/lazy.ts': ['export function lazilyUsed(): number {', '  return 1;', '}'].join('\n'),
  'src/lazy-consumer.ts': [
    'export async function go(): Promise<number> {',
    "  const { lazilyUsed } = await import('./lazy.js');",
    '  return lazilyUsed();',
    '}',
  ].join('\n'),
  // An ALIASED re-export consumed through a destructured dynamic import: the
  // module's export table hands back the barrel's alias, and crediting only that
  // left the original — the declaration actually being consumed — looking dead.
  'src/aliased.ts': ['export const VALUE = 7;'].join('\n'),
  'src/alias-barrel.ts': ["export { VALUE as ALIAS } from './aliased.js';"].join('\n'),
  'src/alias-consumer.ts': [
    'export async function readIt(): Promise<number> {',
    "  const { ALIAS } = await import('./alias-barrel.js');",
    '  return ALIAS;',
    '}',
  ].join('\n'),
  // Used only inside its own file.
  'src/internal.ts': [
    'export const KEPT_INSIDE = 1;',
    'export function reader(): number {',
    '  return KEPT_INSIDE;',
    '}',
    "import { total } from './consumer.js';",
    'export const anchor = total;',
  ].join('\n'),
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'licio-dead-exports-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG);
  for (const [path, content] of Object.entries(FILES)) {
    writeFileSync(join(root, path), `${content}\n`);
  }
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** Resolve the fixture and report, per `file:name`, how many uses were found. */
function resolveFixture(): Map<string, number> {
  const files = Object.keys(FILES);
  const declarations: Array<{ file: string; offset: number; name: string }> = [];
  for (const [file, content] of Object.entries(FILES)) {
    // Locate each `export const/function NAME` by hand: this test is about the
    // RESOLVER, so it must not depend on the declaration parser's own rules.
    for (const match of `${content}\n`.matchAll(/export (?:const|function) ([A-Za-z_$][\w$]*)/g)) {
      const name = match[1] ?? '';
      declarations.push({ file, offset: (match.index ?? 0) + match[0].length - name.length, name });
    }
    for (const match of `${content}\n`.matchAll(/export \{ \w+ as ([A-Za-z_$][\w$]*) \}/g)) {
      const name = match[1] ?? '';
      declarations.push({ file, offset: (match.index ?? 0) + match[0].indexOf(name), name });
    }
  }
  const resolved = resolveExportReferences({
    root,
    configs: [resolve(root, 'tsconfig.json')],
    files,
    identifierOffsets: (_file, source) => identifierOffsets(source),
    importedNames: (_file, source) => importedNames(source),
    declarations: declarations.map(({ file, offset }) => ({ file, offset })),
  });
  expect(resolved.uncovered).toEqual([]);
  const counts = new Map<string, number>();
  for (const declaration of declarations) {
    const uses = resolved.uses.get(declarationKey(declaration.file, declaration.offset)) ?? [];
    counts.set(`${declaration.file}:${declaration.name}`, uses.length);
  }
  return counts;
}

describe('binding-accurate resolution', () => {
  let uses: Map<string, number>;
  beforeAll(() => {
    uses = resolveFixture();
  });

  it('does NOT count a same-named local, parameter or shadowed binding', () => {
    // The defect this module exists for.  `uses-collide.ts` mentions `status`
    // four times — a local, a parameter, a read of the parameter, a read of the
    // local — and none of them is this export.
    expect(uses.get('src/collide.ts:status')).toBe(0);
    expect(uses.get('src/collide.ts:alsoDead')).toBe(0);
  });

  it('counts a real import', () => {
    expect(uses.get('src/plain.ts:LIVE')).toBeGreaterThan(0);
    expect(uses.get('src/plain.ts:DEAD')).toBe(0);
  });

  it('counts a DESTRUCTURED dynamic import, which binds a new local', () => {
    // `const { lazilyUsed } = await import('./lazy.js')` resolves the identifier
    // to that new local, never to the export, so this needs the specifier route.
    expect(uses.get('src/lazy.ts:lazilyUsed')).toBeGreaterThan(0);
  });

  it('does not let an unused BARREL vouch for what it republishes', () => {
    // `export { orphan } from './module.js'` is plumbing: publishing a name is
    // not consuming it, so `orphan` has no consumer at all.
    expect(uses.get('src/module.ts:orphan')).toBe(0);
  });

  it('reports an ALIASED re-export separately from what it aliases', () => {
    // `renamed` is a public name that exists nowhere else, and nothing imports
    // it — so it is dead in its own right.
    expect(uses.get('src/barrel.ts:renamed')).toBe(0);
  });

  it('follows the ALIAS CHAIN when crediting a name taken from a module', () => {
    // `export { VALUE as ALIAS } from './aliased.js'` consumed as
    // `const { ALIAS } = await import('./alias-barrel.js')`.  The export table
    // returns the barrel's alias; without walking behind it, the alias looks
    // live and `VALUE` — the declaration genuinely being read — looks dead,
    // which is a FALSE POSITIVE that fails a correct branch.
    expect(uses.get('src/aliased.ts:VALUE')).toBeGreaterThan(0);
    expect(uses.get('src/alias-barrel.ts:ALIAS')).toBeGreaterThan(0);
  });

  it('counts a use from the declaring file itself', () => {
    // Internal-only, not dead: the gate reports these separately, and a helper
    // exported so its own module's test can reach it is legitimate.
    expect(uses.get('src/internal.ts:KEPT_INSIDE')).toBeGreaterThan(0);
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
      identifierOffsets: () => [],
      importedNames: () => [],
      declarations: [],
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
