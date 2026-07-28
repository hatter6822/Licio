// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A project reference names a CONFIG FILE, never the directory holding it.
//
// TypeScript accepts both spellings — it appends `/tsconfig.json` to a
// directory — but that leniency is TypeScript's alone, and `tsc` is not the
// only reader of these files.  Playwright loads the nearest tsconfig to pick
// up `paths` for the E2E specs, and from 1.62 it follows `references` too,
// resolving each by appending `.json` to whatever it is handed: the directory
// form `{ "path": "../../packages/shared" }` becomes `packages/shared.json`,
// which exists nowhere.  The whole E2E job then dies before its first spec,
// with an error that names neither Playwright's rule nor the reference form —
// so the failure is expensive to read and trivial to reintroduce.
//
// The explicit file form is what every reader agrees on and what TypeScript
// documents, so it is asserted here rather than left to whoever next adds a
// workspace.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import { describe, expect, it } from 'vitest';
import { type Syntax, walk, withParsedSources } from './ts-source.js';

const ROOT = resolve(import.meta.dirname, '..');

/** One tracked tsconfig, reduced to the two fields that name another file. */
interface TrackedConfig {
  readonly path: string;
  readonly extends: readonly string[];
  readonly references: readonly string[];
}

const childrenOf = (node: Syntax): Syntax[] => {
  const found: Syntax[] = [];
  node.forEachChild((child) => {
    found.push(child);
  });
  return found;
};

/** The value an object literal holds at `key`. */
const valueAt = (object: Syntax | undefined, key: string): Syntax | undefined => {
  if (object?.kind !== SyntaxKind.ObjectLiteralExpression) return undefined;
  for (const member of childrenOf(object)) {
    if (member.kind !== SyntaxKind.PropertyAssignment) continue;
    // `.text` decodes both `extends:` and `"extends":`, which a config may use
    // interchangeably.
    if (member.name?.text === key) return member.initializer;
  }
  return undefined;
};

/** `extends` is a string or an array of them; both name config files. */
const stringsIn = (node: Syntax | undefined): string[] => {
  if (node === undefined) return [];
  if (node.kind === SyntaxKind.StringLiteral) return [node.text ?? ''];
  if (node.kind !== SyntaxKind.ArrayLiteralExpression) return [];
  return childrenOf(node).flatMap((each) =>
    each.kind === SyntaxKind.StringLiteral ? [each.text ?? ''] : [],
  );
};

const referencePathsIn = (config: Syntax | undefined): string[] => {
  const value = valueAt(config, 'references');
  if (value?.kind !== SyntaxKind.ArrayLiteralExpression) return [];
  return childrenOf(value).flatMap((entry) => stringsIn(valueAt(entry, 'path')));
};

/**
 * Every tracked tsconfig, read from the PARSE.
 *
 * A tsconfig is JSONC, so `JSON.parse` cannot read one: comments and — the
 * shape that matters here — a TRAILING COMMA, which TypeScript accepts in both
 * object and array literals. Converting the text back through strict JSON would
 * throw on a perfectly valid config and fail `pnpm test` for it, so nothing is
 * converted: the text is wrapped in parentheses, making it a TypeScript object
 * literal, and the two fields are read off the syntax tree the parser already
 * built. Comments are trivia the parser drops on its own, and a trailing comma
 * is grammar it accepts, so both cost nothing here.
 *
 * The compiler's own `parseConfigFileTextToJson` would be the obvious tool, but
 * the TypeScript 7 package this repository pins does not expose it.
 */
function readConfigs(files: ReadonlyArray<{ path: string; text: string }>): TrackedConfig[] {
  const sources = files.map(({ path, text }) => ({
    // `.ts` so the parser reads TypeScript grammar rather than guessing.
    path: `${path}.ts`,
    content: `(${text})`,
  }));

  return withParsedSources(sources, (parsed) =>
    parsed.map(({ path, root }) => {
      // The parenthesised config is the first object literal in the file.
      let config: Syntax | undefined;
      for (const node of walk(root)) {
        if (node.kind === SyntaxKind.ObjectLiteralExpression) {
          config = node;
          break;
        }
      }
      return {
        path: path.replace(/\.ts$/, ''),
        extends: stringsIn(valueAt(config, 'extends')),
        references: referencePathsIn(config),
      };
    }),
  );
}

/**
 * The `extends`/`references` CLOSURE, not the files whose name says `tsconfig`.
 *
 * A reference may target a config with any name — `packages/foo/build.json` is
 * as valid as `tsconfig.json` — and a name-matched enumeration never opens one,
 * so directory-form references INSIDE it go unchecked and can reproduce exactly
 * the Playwright load failure this file exists to prevent.  The closure is
 * walked instead: every tracked `*tsconfig*.json` seeds it, and whatever those
 * name is added and read in turn until nothing new appears.
 */
function configClosure(
  seeds: readonly string[],
  read: (path: string) => string | undefined,
): TrackedConfig[] {
  // A tracked SEED that cannot be read is a config this never judged, and
  // dropping it silently kept the suite green over it — a broken symlink or a
  // bad checkout would pass while the aggregate counts stayed plausible.  Only
  // a CANDIDATE discovered while resolving a reference may be absent; that is
  // how a MISSING target is detected rather than hidden.
  for (const seed of seeds) {
    if (read(seed) === undefined) throw new Error(`tracked tsconfig ${seed} could not be read`);
  }
  const seen = new Set<string>(seeds);
  let frontier: readonly string[] = seeds;
  const configs: TrackedConfig[] = [];
  // No round bound: `seen` already guarantees termination, since a round only
  // enqueues paths nothing has read yet and files are finite.  A bound would
  // exit with a NON-EMPTY frontier and silently accept an incomplete closure —
  // configs never checked, reported as checked.
  while (frontier.length > 0) {
    const sources = frontier.flatMap((path) => {
      const text = read(path);
      return text === undefined ? [] : [{ path, text }];
    });
    const parsed = readConfigs(sources);
    configs.push(...parsed);
    const next: string[] = [];
    for (const config of parsed) {
      const from = dirname(config.path);
      // A REFERENCE path is relative whether or not it starts with `.` — the
      // root config here uses `packages/shared/tsconfig.json` — so the dot test
      // belongs only to `extends`, where a bare specifier resolves through
      // node_modules and is not this assertion's business.
      const named = [
        ...config.extends.filter((each) => each.startsWith('.')),
        ...config.references,
      ];
      for (const each of named) {
        // Whatever the compiler would open: the path itself, or — for an
        // extensionless `extends` — the `.json` beside it.
        const direct = posix.normalize(posix.join(from, each));
        for (const candidate of [direct, `${direct}.json`]) {
          if (seen.has(candidate) || read(candidate) === undefined) continue;
          seen.add(candidate);
          next.push(candidate);
        }
      }
    }
    frontier = next;
  }
  return configs;
}

/**
 * Every `extends` or `references` path in `configs` that names no file.
 *
 * `extends` follows the COMPILER's rule, which appends `.json` to an
 * extensionless relative path — so `"extends": "./base"` beside a `base.json`
 * is valid, and an exact check would reject a config `tsc` accepts.  A bare
 * `extends` resolves through node_modules and is not this assertion's business.
 *
 * A REFERENCE path is always relative, dot-prefixed or not, so every one is
 * checked exactly: a missing DOTLESS target was dropped from the closure (there
 * is nothing to read) and then skipped here too, so a broken reference passed
 * the guard entirely.
 */
function unresolvableOffenders(
  configs: readonly TrackedConfig[],
  exists: (path: string) => boolean,
): string[] {
  const resolvesFrom = (from: string, specifier: string, appendJson: boolean): boolean => {
    const target = posix.normalize(posix.join(dirname(from), specifier));
    if (exists(target)) return true;
    return appendJson && !specifier.endsWith('.json') && exists(`${target}.json`);
  };
  return configs.flatMap(({ path, extends: bases, references }) =>
    [
      ...bases.filter((each) => each.startsWith('.')).map((each) => ({ each, appendJson: true })),
      ...references.map((each) => ({ each, appendJson: false })),
    ]
      .filter(({ each, appendJson }) => !resolvesFrom(path, each, appendJson))
      .map(({ each }) => `${path}: "${each}" resolves to no file`),
  );
}

/** Every reference in `configs` written as a DIRECTORY rather than a file. */
function directoryFormOffenders(configs: readonly TrackedConfig[]): string[] {
  return configs.flatMap(({ path, references }) =>
    references
      .filter((reference) => !reference.endsWith('.json'))
      .map(
        (reference) =>
          `${path}: reference "${reference}" names a directory — write ` +
          `"${reference.replace(/\/$/, '')}/tsconfig.json", which every reader resolves`,
      ),
  );
}

function trackedConfigs(): TrackedConfig[] {
  const seeds = execFileSync('git', ['ls-files', '*tsconfig*.json'], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter((each) => each.length > 0);
  return configClosure(seeds, (path) => {
    try {
      return readFileSync(resolve(ROOT, path), 'utf-8');
    } catch {
      return undefined;
    }
  });
}

describe('reading a tsconfig', () => {
  // JSONC is not JSON.  Converting the text back through `JSON.parse` threw on
  // a TRAILING COMMA — grammar TypeScript accepts in both object and array
  // literals — which would have failed `pnpm test` over a perfectly valid
  // compiler config.  Read off the parse, neither costs anything.
  it.each([
    ['line comments', '// leading\n{ "extends": "../base.json" /* inline */ }'],
    ['a trailing comma in an object', '{ "extends": "../base.json", }'],
    ['a trailing comma in an array', '{ "extends": ["../base.json",] }'],
    ['both, together', '{\n  // why\n  "extends": ["../base.json",],\n}'],
  ])('reads `extends` through %s', (_label, text) => {
    expect(readConfigs([{ path: 'x/tsconfig.json', text }])[0]?.extends).toEqual(['../base.json']);
  });

  it('reads `references` through a trailing comma in every position', () => {
    const text = '{\n  "references": [\n    { "path": "../a/tsconfig.json", },\n  ],\n}';
    expect(readConfigs([{ path: 'x/tsconfig.json', text }])[0]?.references).toEqual([
      '../a/tsconfig.json',
    ]);
  });

  it('reads a config that declares neither field', () => {
    expect(readConfigs([{ path: 'x/tsconfig.json', text: '{ "compilerOptions": {} }' }])).toEqual([
      { path: 'x/tsconfig.json', extends: [], references: [] },
    ]);
  });
});

describe('the reference CLOSURE', () => {
  // A reference may target a config with ANY name — `build.json` is as valid as
  // `tsconfig.json` — so enumerating files whose NAME says tsconfig never opens
  // one, and a directory-form reference inside it goes unchecked.  That is the
  // very failure this file exists to prevent, hiding one file along.
  const graph: Readonly<Record<string, string>> = {
    'a/tsconfig.json': '{ "references": [{ "path": "../b/build.json" }] }',
    'b/build.json': '{ "references": [{ "path": "../c" }] }',
    'c/tsconfig.json': '{ "compilerOptions": {} }',
  };
  const read = (path: string): string | undefined => graph[path];

  it('opens a referenced config whose NAME does not say tsconfig', () => {
    expect(configClosure(['a/tsconfig.json'], read).map((each) => each.path)).toEqual([
      'a/tsconfig.json',
      'b/build.json',
    ]);
  });

  it('reports a directory-form reference hidden inside one', () => {
    expect(directoryFormOffenders(configClosure(['a/tsconfig.json'], read))).toEqual([
      expect.stringContaining('b/build.json: reference "../c" names a directory'),
    ]);
  });

  it('follows a reference path with NO dot prefix', () => {
    // A reference path is relative whether or not it starts with `.` — the
    // repository's own root config uses `packages/shared/tsconfig.json` — so
    // the dot test belonged only to `extends`.
    const dotless: Readonly<Record<string, string>> = {
      'tsconfig.json': '{ "references": [{ "path": "packages/foo/build.json" }] }',
      'packages/foo/build.json': '{ "references": [{ "path": "../bar" }] }',
    };
    const closure = configClosure(['tsconfig.json'], (path) => dotless[path]);
    expect(closure.map((each) => each.path)).toContain('packages/foo/build.json');
    expect(directoryFormOffenders(closure)).toEqual([
      expect.stringContaining('packages/foo/build.json: reference "../bar" names a directory'),
    ]);
  });

  it('walks a chain deeper than any round bound', () => {
    // A bound would exit with a NON-EMPTY frontier and accept an incomplete
    // closure — configs never checked, reported as checked.
    const deep: Record<string, string> = {};
    for (let at = 0; at < 60; at += 1) {
      deep[`d${at}/tsconfig.json`] =
        at === 59
          ? '{ "references": [{ "path": "../last" }] }'
          : `{ "references": [{ "path": "../d${at + 1}/tsconfig.json" }] }`;
    }
    const closure = configClosure(['d0/tsconfig.json'], (path) => deep[path]);
    expect(closure).toHaveLength(60);
    expect(directoryFormOffenders(closure)).toHaveLength(1);
  });

  it('keeps a MISSING dotless reference visible', () => {
    // The closure drops what it cannot read, so the offender has to survive as
    // a reference on the config that named it — otherwise a broken dotless
    // target vanishes and the guard reports success over it.
    const missing: Readonly<Record<string, string>> = {
      'tsconfig.json': '{ "references": [{ "path": "packages/missing/build.json" }] }',
    };
    const closure = configClosure(['tsconfig.json'], (path) => missing[path]);
    expect(closure).toHaveLength(1);
    expect(closure[0]?.references).toEqual(['packages/missing/build.json']);
  });

  it('reports a MISSING dotless reference', () => {
    const missing: Readonly<Record<string, string>> = {
      'tsconfig.json': '{ "references": [{ "path": "packages/missing/build.json" }] }',
    };
    const closure = configClosure(['tsconfig.json'], (path) => missing[path]);
    expect(unresolvableOffenders(closure, (path) => path in missing)).toEqual([
      expect.stringContaining('"packages/missing/build.json" resolves to no file'),
    ]);
  });

  it('FAILS when a tracked seed cannot be read', () => {
    // Aggregate counts stayed plausible while an unread seed was never judged.
    expect(() => configClosure(['tsconfig.json'], () => undefined)).toThrow(
      /tracked tsconfig tsconfig\.json could not be read/,
    );
  });

  it('terminates on a reference CYCLE', () => {
    const cyclic: Readonly<Record<string, string>> = {
      'a/tsconfig.json': '{ "references": [{ "path": "../b/tsconfig.json" }] }',
      'b/tsconfig.json': '{ "references": [{ "path": "../a/tsconfig.json" }] }',
    };
    expect(configClosure(['a/tsconfig.json'], (path) => cyclic[path])).toHaveLength(2);
  });
});

describe('tsconfig project references', () => {
  const configs = trackedConfigs();

  it('reads every tracked tsconfig, so nothing below passes vacuously', () => {
    // A reader that quietly returned nothing would make every assertion here
    // succeed over a repository it never opened.
    expect(configs.length).toBeGreaterThan(10);
    expect(configs.flatMap((each) => each.references).length).toBeGreaterThan(20);
  });

  it('names a config FILE, never the directory holding it', () => {
    expect(directoryFormOffenders(configs)).toEqual([]);
  });

  it('resolves every reference and every `extends` to a file that exists', () => {
    expect(unresolvableOffenders(configs, (path) => existsSync(resolve(ROOT, path)))).toEqual([]);
  });

  it('accepts an extensionless `extends`, as the compiler does', () => {
    // `tsconfig.base.json` exists at the repository root, so `./tsconfig.base`
    // is a valid extensionless base that an exact check would have rejected.
    expect(
      readConfigs([{ path: 'tsconfig.json', text: '{ "extends": "./tsconfig.base" }' }])[0]
        ?.extends,
    ).toEqual(['./tsconfig.base']);
    expect(existsSync(resolve(ROOT, 'tsconfig.base.json'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'tsconfig.base'))).toBe(false);
  });
});
