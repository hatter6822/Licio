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
import { dirname, resolve } from 'node:path';
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

function trackedConfigs(): TrackedConfig[] {
  const paths = execFileSync('git', ['ls-files', '*tsconfig*.json'], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter((each) => each.length > 0);

  return readConfigs(
    paths.map((path) => ({ path, text: readFileSync(resolve(ROOT, path), 'utf-8') })),
  );
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

describe('tsconfig project references', () => {
  const configs = trackedConfigs();

  it('reads every tracked tsconfig, so nothing below passes vacuously', () => {
    // A reader that quietly returned nothing would make every assertion here
    // succeed over a repository it never opened.
    expect(configs.length).toBeGreaterThan(10);
    expect(configs.flatMap((each) => each.references).length).toBeGreaterThan(20);
  });

  it('names a config FILE, never the directory holding it', () => {
    const offenders = configs.flatMap(({ path, references }) =>
      references
        .filter((reference) => !reference.endsWith('.json'))
        .map(
          (reference) =>
            `${path}: reference "${reference}" names a directory — write ` +
            `"${reference.replace(/\/$/, '')}/tsconfig.json", which every reader resolves`,
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('resolves every reference and every `extends` to a file that exists', () => {
    // `extends` follows the COMPILER's rule, which appends `.json` to an
    // extensionless relative path — so `"extends": "./base"` with `base.json`
    // beside it is valid, and an exact filesystem check would reject a config
    // `tsc` accepts.  A `references` path is held to the stricter rule this
    // file exists to enforce, and is checked exactly.
    const resolvesFrom = (path: string, specifier: string, appendJson: boolean): boolean => {
      const from = dirname(resolve(ROOT, path));
      const target = resolve(from, specifier);
      if (existsSync(target)) return true;
      return appendJson && !specifier.endsWith('.json') && existsSync(`${target}.json`);
    };
    const offenders = configs.flatMap(({ path, extends: bases, references }) =>
      [
        ...bases.map((each) => ({ each, appendJson: true })),
        ...references.map((each) => ({ each, appendJson: false })),
      ]
        // A bare specifier resolves through node_modules, which is not this
        // assertion's business; only relative paths are checked here.
        .filter(({ each }) => each.startsWith('.'))
        .filter(({ each, appendJson }) => !resolvesFrom(path, each, appendJson))
        .map(({ each }) => `${path}: "${each}" resolves to no file`),
    );
    expect(offenders).toEqual([]);
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
