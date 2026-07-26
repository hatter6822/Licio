// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One place the static gates get a PARSE of the source they judge.
//
// Several gates ask structural questions about TypeScript — which calls are
// route registrations, which expression reaches a dynamic-code sink, which
// classes a `className` renders, which fields a schema declares — and each had
// grown its own way of reading it.  At the last count that was a 1546-line
// token-level analyzer plus THREE separate hand-written `stripComments`
// implementations, one of which scanned the file twice under both readings of
// `/` because, in its own words, the case is "ambiguous without a parser".
//
// It is ambiguous without a parser.  So this hands the file to one.
//
// Sources are mounted in a VIRTUAL filesystem, which is what makes this usable
// by a gate: the input may be a repository file, a built bundle that no
// tsconfig covers, or a string a unit test made up, and none of them needs to
// exist on disk or belong to a workspace project.  A caller that only needs
// syntax pays for syntax; a caller that needs to know what a name BINDS to gets
// the checker with it, and binding resolution — scopes, shadowing, hoisting,
// imports — is the part no scan can do.

import { resolve } from 'node:path';
import type { NodeHandle } from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API, type Project } from 'typescript/unstable/sync';

/** A source to parse, named so a finding can point back at it. */
export interface Source {
  readonly path: string;
  readonly content: string;
}

/** A parsed source: the path it came in as, and its syntax tree. */
export interface ParsedSource {
  readonly path: string;
  readonly content: string;
  readonly root: NodeHandle;
}

const VIRTUAL_ROOT = '/licio-gate-sources';
const VIRTUAL_CONFIG = `${VIRTUAL_ROOT}/tsconfig.json`;

/**
 * A project wide enough to PARSE anything a gate scans.
 *
 * `allowJs` because built artifacts are `.js`.  No `lib` and no `@types` are
 * loaded: a gate asks what a name binds to WITHIN the sources it was given, and
 * an unresolved global is a meaningful answer rather than a missing one.
 */
const CONFIG_CONTENT = JSON.stringify({
  compilerOptions: {
    target: 'ESNext',
    module: 'preserve',
    moduleResolution: 'bundler',
    jsx: 'react-jsx',
    allowJs: true,
    noEmit: true,
    noResolve: true,
    skipLibCheck: true,
    types: [],
  },
  include: ['src'],
});

/**
 * Where a source is mounted.
 *
 * The EXTENSION is preserved, because it selects the grammar: `<string>x` is a
 * type assertion in a `.ts` file and malformed JSX in a `.tsx` one, so mounting
 * every source as `.tsx` made a legal `.ts` helper fail to parse — and a gate
 * that sees nothing in a file reports it clean.
 *
 * The name is flattened so no path can escape the mount point, and PREFIXED
 * with the caller's index so the flattening stays injective: `foo/bar.ts` and
 * `foo_bar.ts` flatten alike, and without the prefix the second would silently
 * replace the first.
 */
function virtualPath(path: string, index: number): string {
  const extension = /\.(tsx|ts|jsx|mjs|cjs|js)$/.exec(path)?.[1] ?? 'ts';
  return `${VIRTUAL_ROOT}/src/${index}-${path.replace(/[^\w.-]/g, '_')}.${extension}`;
}

/**
 * Parse `sources` in one project and hand them to `body`.
 *
 * The project is torn down when `body` returns, so every handle it yields —
 * nodes, symbols, types — must be consumed inside it.  One project for the
 * whole batch: opening one per file is the cost that matters, not the files.
 */
export function withParsedSources<T>(
  sources: readonly Source[],
  body: (parsed: readonly ParsedSource[], project: Project) => T,
): T {
  if (sources.length === 0) return body([], undefined as unknown as Project);

  const contents: Record<string, string> = { [VIRTUAL_CONFIG]: CONFIG_CONTENT };
  const mounted = sources.map((source, index) => {
    const at = virtualPath(source.path, index);
    contents[at] = source.content;
    return { at, source };
  });

  const api = new API({ cwd: VIRTUAL_ROOT, fs: createVirtualFileSystem(contents) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [VIRTUAL_CONFIG] });
    const project = snapshot.getProjects()[0];
    if (project === undefined)
      throw new Error('ts-source: the virtual project could not be opened');
    const parsed: ParsedSource[] = [];
    for (const { at, source } of mounted) {
      const root = project.program.getSourceFile(resolve(at));
      // A source that did not parse cannot be judged, and a gate that skipped
      // it would report clean over code it never read.
      if (root === undefined) {
        throw new Error(`ts-source: ${source.path} was not parsed; it cannot be judged`);
      }
      parsed.push({ path: source.path, content: source.content, root });
    }
    return body(parsed, project);
  } finally {
    api.close();
  }
}

/** Every node in a tree, parents before children. */
export function* walk(node: NodeHandle): Generator<NodeHandle> {
  yield node;
  const children: NodeHandle[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  for (const child of children) yield* walk(child);
}

/** Offsets of every `\n`, ascending — the index `lineAt` binary-searches. */
export function newlineIndex(source: string): number[] {
  const offsets: number[] = [];
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) {
    offsets.push(at);
  }
  return offsets;
}

/** The 1-based line an offset falls on. */
export function lineAt(newlineOffsets: readonly number[], offset: number): number {
  let low = 0;
  let high = newlineOffsets.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((newlineOffsets[mid] ?? 0) < offset) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}
