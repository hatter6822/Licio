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
import { describe, expect, it } from 'vitest';
import { blankComments, withParsedSources } from './ts-source.js';

const ROOT = resolve(import.meta.dirname, '..');

/** One tracked tsconfig, reduced to the two fields that name another file. */
interface TrackedConfig {
  readonly path: string;
  readonly extends: readonly string[];
  readonly references: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** `extends` is a string or an array of them; both name config files. */
const extendsOf = (parsed: unknown): string[] => {
  if (!isRecord(parsed)) return [];
  const value = parsed['extends'];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((each): each is string => typeof each === 'string');
};

const referencesOf = (parsed: unknown): string[] => {
  if (!isRecord(parsed)) return [];
  const value = parsed['references'];
  if (!Array.isArray(value)) return [];
  return value.flatMap((each) =>
    isRecord(each) && typeof each['path'] === 'string' ? [each['path']] : [],
  );
};

/**
 * Every tracked tsconfig, parsed.
 *
 * A tsconfig is JSONC and `JSON.parse` cannot read one, so the text is wrapped
 * in parentheses — making it a TypeScript object literal — and handed to the
 * parser the gates already share.  Blanking comments through the compiler's own
 * trivia ranges is exactly what `blankComments` exists for; writing a fourth
 * hand-rolled comment stripper to read a config file is the habit `ts-source.ts`
 * was built to end.
 */
function trackedConfigs(): TrackedConfig[] {
  const paths = execFileSync('git', ['ls-files', '*tsconfig*.json'], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter((each) => each.length > 0);

  const sources = paths.map((path) => ({
    // `.ts` so the parser reads TypeScript grammar rather than guessing.
    path: `${path}.ts`,
    content: `(${readFileSync(resolve(ROOT, path), 'utf-8')})`,
  }));

  return withParsedSources(sources, (parsed) =>
    parsed.map(({ path, content, root }) => {
      // Drop the parentheses this added back off before reading it as JSON.
      const json = blankComments(content, root).slice(1, -1);
      const config: unknown = JSON.parse(json);
      return {
        path: path.replace(/\.ts$/, ''),
        extends: extendsOf(config),
        references: referencesOf(config),
      };
    }),
  );
}

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
    const offenders = configs.flatMap(({ path, extends: bases, references }) =>
      [...bases, ...references]
        // A bare specifier resolves through node_modules, which is not this
        // assertion's business; only relative paths are checked here.
        .filter((each) => each.startsWith('.'))
        .filter((each) => !existsSync(resolve(dirname(resolve(ROOT, path)), each)))
        .map((each) => `${path}: "${each}" resolves to no file`),
    );
    expect(offenders).toEqual([]);
  });
});
