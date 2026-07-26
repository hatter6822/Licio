// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The class strings a TypeScript source can render — read from its AST.
//
// A class name reaches the DOM through `cn(...)`, a ternary, a class map or a
// module constant at least as often as through a literal `className=`, so the
// gate that judges those names has to recover what each expression RENDERS.
// That is a question about JavaScript, and it was answered here by hand: a
// lexer, a run of `+`-joined operands, a rule for when `(` opens a call rather
// than a group, an escape decoder, a template folder, and a backwards
// `lastIndexOf('<')` to guess the enclosing JSX element.
//
// Each piece was correct and each had a next case.  `return ('text-') + 'error'`
// read the `(` after `return` as a call and scanned the two literals
// separately; `// <Icon` in a comment counted as an enclosing icon and
// suppressed a real finding.  Both are the same defect — JavaScript parsed by
// something that is not a JavaScript parser — and the compiler this repository
// already uses for `check:dead-exports` settles them by construction: a comment
// produces no JSX node, and a parenthesis is a `ParenthesizedExpression` or a
// `CallExpression` with nothing to infer between them.
//
// Only the PARSE is needed, not the checker: `StringLiteral.text` is the cooked
// value, so `'text-error'` arrives as `text-error` with no escape rules
// here, and template chunks arrive the same way.  Sources are handed to the
// compiler through a VIRTUAL filesystem, so this stays a pure function of the
// text it is given and its tests keep passing strings rather than writing
// fixtures to disk.
//
// The one thing the compiler will NOT fold is `+` between two literals — TS
// types `'a' + 'b'` as `string`, not `"ab"` — so concatenation is folded here,
// structurally, over the AST rather than over a token stream.

import { resolve } from 'node:path';
import { type NodeHandle, SyntaxKind } from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';

/** A source to read, named so findings can point back at it. */
export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

/** One class string an expression renders. */
export interface ClassString {
  /** The rendered text.  A part whose value is unknown becomes a single space. */
  readonly text: string;
  /** For each character, the source offset of the PIECE it came from. */
  readonly offsets: readonly number[];
  /** Offset of the whole expression, for a finding with no better anchor. */
  readonly start: number;
  /**
   * The JSX element this sits inside, or `null`.
   *
   * From the parse tree, so `<Icon` inside a comment or a string is what it is —
   * text — rather than an enclosing element that silently grants an exemption.
   */
  readonly element: string | null;
}

/** A literal run and where it starts; the unit offsets are reported at. */
interface Piece {
  readonly text: string;
  /** Offset of the piece, the anchor when its characters cannot be placed. */
  readonly at: number;
  /**
   * Offset of the piece's first CHARACTER when the source spells it verbatim,
   * so each one can be placed exactly; `null` when an escape makes the cooked
   * text shorter than the source and only the piece itself can be pointed at.
   *
   * This is what puts a finding on its own line inside a template that spans
   * several — the common case, since a class string rarely contains an escape.
   */
  readonly verbatimAt: number | null;
}

/** A fold: what an expression renders, and the parts it could not read. */
interface Fold {
  readonly pieces: readonly Piece[];
  /** Sub-expressions folded as UNKNOWN, which may hold class strings of their
   *  own — `f('text-error') + x` renders nothing knowable, and still contains
   *  one.  They are walked separately rather than lost or double-counted. */
  readonly unknown: readonly NodeHandle[];
}

/** Expressions that render exactly what they wrap. */
const TRANSPARENT = new Set<number>([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
]);

/** A part whose value is unknown: one SPACE, never nothing.
 *
 *  Dropping it would join the text around it and invent a class that never
 *  renders — `text-${x}error` would read as `text-error` and fail a correct
 *  build. */
function unknownPiece(node: NodeHandle): Piece {
  return { text: ' ', at: node.getStart(), verbatimAt: null };
}

/**
 * A literal piece, placed against the source.
 *
 * The content of every literal form starts one character in — after the quote,
 * the backtick, or the `}` that closed the hole before it.
 */
function literalPiece(node: NodeHandle, source: string): Piece {
  const text = node.text ?? '';
  const at = node.getStart();
  const contentAt = at + 1;
  const verbatim = source.slice(contentAt, contentAt + text.length) === text;
  return { text, at, verbatimAt: verbatim ? contentAt : null };
}

/** What `node` renders, or `null` when nothing about it is known. */
function fold(node: NodeHandle, source: string): Fold | null {
  if (
    node.kind === SyntaxKind.StringLiteral ||
    node.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    // `.text` is the COOKED value: escapes, line continuations and surrogate
    // pairs are already resolved by the scanner that owns those rules.
    return { pieces: [literalPiece(node, source)], unknown: [] };
  }

  if (TRANSPARENT.has(node.kind)) {
    return node.expression === undefined ? null : fold(node.expression, source);
  }

  if (node.kind === SyntaxKind.TemplateExpression) {
    const pieces: Piece[] = [];
    const unknown: NodeHandle[] = [];
    const head = node.head;
    if (head !== undefined) pieces.push(literalPiece(head, source));
    node.forEachChild((child) => {
      if (child.kind !== SyntaxKind.TemplateSpan) return;
      const expression = child.expression;
      const inner = expression === undefined ? null : fold(expression, source);
      if (inner === null) {
        if (expression !== undefined) {
          pieces.push(unknownPiece(expression));
          unknown.push(expression);
        }
      } else {
        pieces.push(...inner.pieces);
        unknown.push(...inner.unknown);
      }
      const literal = child.literal;
      if (literal !== undefined) pieces.push(literalPiece(literal, source));
    });
    return { pieces, unknown };
  }

  if (
    node.kind === SyntaxKind.BinaryExpression &&
    node.operatorToken?.kind === SyntaxKind.PlusToken
  ) {
    const left = node.left === undefined ? null : fold(node.left, source);
    const right = node.right === undefined ? null : fold(node.right, source);
    // Neither side says anything: this is not a class string, and descending
    // normally lets each operand be judged on its own.
    if (left === null && right === null) return null;
    const pieces: Piece[] = [];
    const unknown: NodeHandle[] = [];
    for (const [side, folded] of [
      [node.left, left],
      [node.right, right],
    ] as const) {
      if (folded === null) {
        if (side !== undefined) {
          pieces.push(unknownPiece(side));
          unknown.push(side);
        }
        continue;
      }
      pieces.push(...folded.pieces);
      unknown.push(...folded.unknown);
    }
    return { pieces, unknown };
  }

  return null;
}

/** The JSX element an expression sits inside, from the tree. */
function enclosingElement(node: NodeHandle): string | null {
  for (let up = node.parent; up !== undefined; up = up.parent) {
    if (up.kind === SyntaxKind.JsxSelfClosingElement || up.kind === SyntaxKind.JsxOpeningElement) {
      return up.tagName?.getText() ?? null;
    }
  }
  return null;
}

/** Join a fold's pieces into the rendered text, with a source offset per unit. */
function render(pieces: readonly Piece[], node: NodeHandle): ClassString {
  const units: string[] = [];
  const offsets: number[] = [];
  for (const piece of pieces) {
    // Place each character exactly where the source spells it verbatim — which
    // is what puts a finding on its own line inside a multi-line template — and
    // fall back to the piece when an escape means the two no longer line up.
    let index = 0;
    for (const unit of piece.text) {
      units.push(unit);
      offsets.push(piece.verbatimAt === null ? piece.at : piece.verbatimAt + index);
      index += unit.length;
    }
  }
  return { text: units.join(''), offsets, start: node.getStart(), element: enclosingElement(node) };
}

/** A tsconfig wide enough to PARSE the sources, and nothing more. */
const VIRTUAL_ROOT = '/licio-class-strings';
const VIRTUAL_CONFIG = `${VIRTUAL_ROOT}/tsconfig.json`;
const CONFIG_CONTENT = JSON.stringify({
  compilerOptions: {
    target: 'ESNext',
    module: 'preserve',
    moduleResolution: 'bundler',
    jsx: 'react-jsx',
    noEmit: true,
    // Nothing here needs a type, so no lib or `@types` package is loaded and
    // an unresolved import is not an error worth having.
    types: [],
    noResolve: true,
    skipLibCheck: true,
  },
  include: ['src'],
});

/** Where a source is mounted inside the virtual project. */
function virtualPath(path: string): string {
  return `${VIRTUAL_ROOT}/src/${path.replace(/[^\w.-]/g, '_')}`;
}

/**
 * Every class string each source can render.
 *
 * One program for the whole batch.  Files are mounted read-only in a virtual
 * filesystem under a generated tsconfig, so this reads nothing from disk and
 * needs no relationship to the workspace's own projects.
 */
export function readClassStrings(files: readonly SourceFile[]): Map<string, ClassString[]> {
  const found = new Map<string, ClassString[]>();
  if (files.length === 0) return found;

  const mounted = new Map<string, string>();
  const mountedContent = new Map<string, string>();
  const contents: Record<string, string> = { [VIRTUAL_CONFIG]: CONFIG_CONTENT };
  for (const file of files) {
    // `.tsx` for every source: JSX syntax has to parse, and a `.ts` that holds
    // none is unaffected by allowing it.
    const at = `${virtualPath(file.path)}.tsx`;
    contents[at] = file.content;
    mounted.set(at, file.path);
    mountedContent.set(file.path, file.content);
  }

  const api = new API({ cwd: VIRTUAL_ROOT, fs: createVirtualFileSystem(contents) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [VIRTUAL_CONFIG] });
    const project = snapshot.getProjects()[0];
    if (project === undefined) {
      throw new Error('check:a11y-hue-usage: the virtual project could not be opened');
    }
    for (const [at, path] of mounted) {
      const source = project.program.getSourceFile(resolve(at));
      if (source === undefined) {
        throw new Error(`check:a11y-hue-usage: ${path} was not parsed; it cannot be judged`);
      }
      const strings: ClassString[] = [];
      const content = mountedContent.get(path) ?? '';
      const visit = (node: NodeHandle): void => {
        const folded = fold(node, content);
        if (folded === null) {
          node.forEachChild(visit);
          return;
        }
        strings.push(render(folded.pieces, node));
        // Only the parts this fold could NOT read are walked again, so a class
        // buried in a call argument is still found and a folded one is not
        // counted twice.
        for (const part of folded.unknown) part.forEachChild(visit);
      };
      visit(source);
      found.set(path, strings);
    }
  } finally {
    api.close();
  }
  return found;
}
