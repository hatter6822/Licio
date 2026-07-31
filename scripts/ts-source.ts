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
import type { Node, SyntaxKind } from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API, type Project } from 'typescript/unstable/sync';

/**
 * The node shape the gates read.
 *
 * The API's `Node` is the common base of a large union, so every member below
 * belongs to SOME node kind and is absent on the others — which is exactly how
 * they are read here: narrow by `kind` first, then take the member that kind
 * has.  Declaring it once means a gate describes the tree the same way the next
 * one does, instead of casting at each use.
 */
export interface Syntax {
  readonly kind: SyntaxKind;
  readonly parent?: Syntax;
  readonly expression?: Syntax;
  readonly tag?: Syntax;
  readonly arguments?: readonly Syntax[];
  readonly name?: Syntax;
  readonly propertyName?: Syntax;
  readonly initializer?: Syntax;
  readonly body?: Syntax;
  readonly moduleSpecifier?: Syntax;
  /** `import x = require('…')` — the specifier hides one level down. */
  readonly moduleReference?: Syntax;
  readonly importClause?: Syntax;
  /** `export { … } from '…'` — the named-binding clause. */
  readonly exportClause?: Syntax;
  readonly namedBindings?: Syntax;
  readonly elements?: readonly Syntax[];
  readonly tagName?: Syntax;
  readonly dotDotDotToken?: unknown;
  readonly isTypeOnly?: boolean;
  readonly token?: SyntaxKind;
  readonly argumentExpression?: Syntax;
  readonly operatorToken?: { readonly kind: SyntaxKind };
  /** A prefix/postfix operator, which is a bare kind rather than a token node. */
  readonly operator?: SyntaxKind;
  readonly left?: Syntax;
  readonly right?: Syntax;
  readonly condition?: Syntax;
  readonly thenStatement?: Syntax;
  readonly elseStatement?: Syntax;
  readonly whenTrue?: Syntax;
  readonly whenFalse?: Syntax;
  readonly head?: Syntax;
  readonly literal?: Syntax;
  readonly text?: string;
  /** Present on the ROOT only; a nested node reaches its file via `getSourceFile`. */
  readonly path: unknown;
  getSourceFile?(): { readonly path?: unknown } | undefined;
  /** FULL start — the offset of this node's leading trivia. */
  readonly pos?: number;
  getStart(): number;
  getEnd(): number;
  getText(): string;
  forEachChild(visitor: (node: Syntax) => void): void;
}

/**
 * A parsed file, as the API hands it back.
 *
 * `getOrCreateNodeAtIndex` is how a tree is entered from a `SourceFile`; the
 * published `SourceFile` type does not carry it, so the one member the gates
 * need is declared here rather than asserted away at each entry point.
 */
export interface SourceRoot {
  getOrCreateNodeAtIndex(at: number): Syntax;
}

/**
 * The SAME object, seen as the compiler's node or as the reading view above.
 *
 * `Syntax` describes the members a gate reads; the checker's signatures want
 * its own `Node`.  Nothing converts — these are two static views of one
 * runtime object — so the crossing is declared once here rather than cast at
 * each of the two dozen call sites, where a stray `as never` would also
 * silence a genuine mismatch.
 */
export const asNode = (node: Syntax): Node => node as unknown as Node;
export const asSyntax = (node: unknown): Syntax => node as Syntax;

/** A source to parse, named so a finding can point back at it. */
export interface Source {
  readonly path: string;
  readonly content: string;
}

/** A parsed source: the path it came in as, and its syntax tree. */
export interface ParsedSource {
  readonly path: string;
  readonly content: string;
  readonly root: Syntax;
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
    // Resolution is ON so that an import BETWEEN two scanned sources binds.
    // With it off, `export const run = eval` in one file and `run(payload)` in
    // another were two unrelated programs: the importing file saw `run` as a
    // name with no declaration — indistinguishable from a global — so splitting
    // an alias across a module boundary walked past every sink gate.
    //
    // Nothing outside the batch resolves, which is the same meaningful answer
    // as before: a name from an unscanned module still has no declaration here.
    skipLibCheck: true,
    types: [],
  },
  include: ['src'],
});

/**
 * Where a source is mounted.
 *
 * The DIRECTORY STRUCTURE is preserved, because relative imports are resolved
 * against it: a file importing `./b.js` only finds `b` if the two sit beside
 * each other in the virtual tree.  Flattening every source into one directory
 * (with an index prefix to keep that injective) made every relative specifier
 * point at nothing, so a sink could be aliased in one module and invoked from
 * another with NEITHER file showing a finding — the importing side saw a name
 * with no declaration, which is indistinguishable from a global.
 *
 * Preserving the path is injective by construction: two sources with the same
 * repo-relative path are the same source, so no prefix is needed.  Segments
 * that would climb out of the mount point are dropped rather than trusted.
 *
 * The EXTENSION is preserved too, because it selects the grammar: `<string>x`
 * is a type assertion in a `.ts` file and malformed JSX in a `.tsx` one, so
 * mounting every source as `.tsx` made a legal `.ts` helper fail to parse — and
 * a gate that sees nothing in a file reports it clean.
 */
function virtualPath(path: string): string {
  const inside = path
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/');
  return `${VIRTUAL_ROOT}/src/${/\.(tsx|ts|jsx|mjs|cjs|js)$/.test(inside) ? inside : `${inside}.ts`}`;
}

/**
 * Parse `sources` in one project and hand them to `body`.
 *
 * The project is torn down when `body` returns, so every handle it yields —
 * nodes, symbols, types — must be consumed inside it.  One project for the
 * whole batch: opening one per file is the cost that matters, not the files.
 *
 * ---
 * WHERE THE `context canceled` LINES IN THE TEST OUTPUT COME FROM.
 *
 * `new API(...)` spawns the native (Go) compiler as a child process and
 * `close()` destroys its stdio pipes and kills it.  That child's stderr is
 * INHERITED — `typescript/dist/api/syncChannel.js` hard-codes
 * `stdio: ['pipe', 'pipe', 'inherit']` — so on its way out it writes
 * `context canceled` straight to ours.  One host per call means one spawn, one
 * kill and (racily, under load) one stray line per batch: a
 * `vitest --project policy` run prints a few hundred of them, interleaved with
 * the test output.  They are the child's exit noise and nothing else — the
 * gates and their tests are unaffected, which is why the count varies run to
 * run while the results do not.
 *
 * It is not silenceable from here: the `stdio` triple is not configurable
 * through the public API, and a child inherits fd 2 at spawn time, so no
 * JS-side redirection reaches it.
 *
 * REUSING one host across calls WAS tried, and it is wrong.  The server keeps
 * its own view of the (mutable) virtual tree, and neither removing the batch's
 * files nor `api.clearSourceFileCache()` makes the next `updateSnapshot` see
 * the new ones: 496 of the 1235 policy tests fail, i.e. gates silently judge
 * the WRONG source.  A quieter log is not worth a gate that reads stale text,
 * so the per-call host stays until the API offers a reusable one.  Tracked in
 * `docs/planning/audit-residuals-2026-07.md`.
 */
export function withParsedSources<T>(
  sources: readonly Source[],
  body: (parsed: readonly ParsedSource[], project: Project) => T,
): T {
  if (sources.length === 0) return body([], undefined as unknown as Project);

  const contents: Record<string, string> = { [VIRTUAL_CONFIG]: CONFIG_CONTENT };
  const mounted = sources.map((source) => {
    const at = virtualPath(source.path);
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
      const root = project.program.getSourceFile(resolve(at)) as unknown as Syntax | undefined;
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
export function* walk(node: Syntax): Generator<Syntax> {
  yield node;
  const children: Syntax[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  for (const child of children) yield* walk(child);
}

/**
 * `source` with every COMMENT replaced by spaces, length- and line-preserving.
 *
 * A gate that looks for a marker in the source needs prose not to satisfy it,
 * and three separate hand-written strippers grew up doing that — one of them
 * scanning the file twice under both readings of `/` because, in its own words,
 * the case is "ambiguous without a parser".
 *
 * The parser has already settled it.  A node's leading TRIVIA is exactly
 * `[pos, getStart())`, and trivia is whitespace and comments and nothing else —
 * so blanking that range to spaces erases every comment and leaves real
 * whitespace as it was, which is what keeps a marker spanning several tokens
 * (`action: 'lock-rooms'`) matchable.
 */
export function blankComments(source: string, root: Syntax): string {
  const out = source.split('');
  let last = 0;
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== '\n' && out[at] !== '\r') out[at] = ' ';
    }
  };
  for (const node of walk(root)) {
    const pos = node.pos;
    if (pos !== undefined && pos < node.getStart()) blank(pos, node.getStart());
    last = Math.max(last, node.getEnd());
  }
  // Trivia after the last node is leading trivia of the end-of-file token,
  // which is not a child of anything.
  blank(last, source.length);
  return out.join('');
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
