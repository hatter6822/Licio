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

import { SyntaxKind } from 'typescript/unstable/ast';
import { type Source as SourceFile, type Syntax, withParsedSources } from './ts-source.js';

export type { Source as SourceFile } from './ts-source.js';

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

/**
 * The module whose export composes class lists.
 *
 * Named as a FILE rather than as an identifier so a local helper that happens
 * to be called `cn` is not mistaken for it, and so a renamed import still
 * resolves — the callee is followed to its declaration, not compared by
 * spelling.
 */
const CLASS_LIST_HELPER = 'lib/cn.ts';

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
  readonly unknown: readonly Syntax[];
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
function unknownPiece(node: Syntax): Piece {
  return { text: ' ', at: node.getStart(), verbatimAt: null };
}

/**
 * A literal piece, placed against the source.
 *
 * The content of every literal form starts one character in — after the quote,
 * the backtick, or the `}` that closed the hole before it.
 */
function literalPiece(node: Syntax, source: string): Piece {
  const text = node.text ?? '';
  const at = node.getStart();
  const contentAt = at + 1;
  const verbatim = source.slice(contentAt, contentAt + text.length) === text;
  return { text, at, verbatimAt: verbatim ? contentAt : null };
}

/** What `node` renders, or `null` when nothing about it is known. */
function fold(
  node: Syntax,
  source: string,
  joins?: (callee: Syntax) => boolean,
  held?: (name: Syntax) => readonly Syntax[],
): Fold | null {
  if (
    node.kind === SyntaxKind.StringLiteral ||
    node.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    // `.text` is the COOKED value: escapes, line continuations and surrogate
    // pairs are already resolved by the scanner that owns those rules.
    return { pieces: [literalPiece(node, source)], unknown: [] };
  }

  if (TRANSPARENT.has(node.kind)) {
    return node.expression === undefined ? null : fold(node.expression, source, joins, held);
  }

  if (node.kind === SyntaxKind.TemplateExpression) {
    const pieces: Piece[] = [];
    const unknown: Syntax[] = [];
    const head = node.head;
    if (head !== undefined) pieces.push(literalPiece(head, source));
    node.forEachChild((child) => {
      if (child.kind !== SyntaxKind.TemplateSpan) return;
      const expression = child.expression;
      const inner = expression === undefined ? null : fold(expression, source, joins, held);
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
    const left = node.left === undefined ? null : fold(node.left, source, joins, held);
    const right = node.right === undefined ? null : fold(node.right, source, joins, held);
    // Neither side says anything: this is not a class string, and descending
    // normally lets each operand be judged on its own.
    if (left === null && right === null) return null;
    const pieces: Piece[] = [];
    const unknown: Syntax[] = [];
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

  // A NAME folds to the class string it holds: `const hue = 'error'` with
  // `` `text-${hue}` `` renders `text-error`, and treating the interpolation as
  // unknown left the token never reconstructed — so the gate saw nothing where
  // a bare semantic hue was about to carry normal text.
  if (node.kind === SyntaxKind.Identifier && held !== undefined) {
    // A USE, not the name being DECLARED.  Folding `c` in `const c = cn(…)`
    // rendered the call a second time — through the union path rather than the
    // alternatives — and then walked its unknown parts, emitting each ternary
    // branch on its own as well.  A declaration's own name sits in its
    // parent's `name`.
    if (node.parent?.name?.getStart() === node.getStart()) return null;
    for (const value of held(node)) {
      if (value.getStart() === node.getStart()) continue;
      const folded = fold(value, source, joins, held);
      if (folded !== null) return folded;
    }
    return null;
  }

  // A CLASS-LIST HELPER composes its arguments onto one element, so the classes
  // it is given all render together.  Folding each argument on its own judged a
  // foreground without the background beside it — `cn('bg-error',
  // 'text-error-fg')` reported a bare hue on the canvas although the two always
  // paint the same element.
  //
  // Which calls compose is decided by the CALLER, which resolves the callee to
  // this repository's own helper rather than matching a name: a local function
  // that happens to be called `cn` composes nothing.
  if (node.kind === SyntaxKind.CallExpression && node.expression !== undefined) {
    if (joins?.(node.expression) !== true) return null;
    const pieces: Piece[] = [];
    const unknown: Syntax[] = [];
    let first = true;
    for (const argument of node.arguments ?? []) {
      // The runtime joins with a SPACE, which is what separates class tokens.
      // A synthetic separator: it exists in the rendered text but nowhere in
      // the source, so it anchors on the argument and places no character.
      if (!first) pieces.push({ text: ' ', at: argument.getStart(), verbatimAt: null });
      first = false;
      // A CONDITIONAL argument still renders ON THIS ELEMENT when it renders at
      // all, so its classes belong in the composed set: `cn('bg-error', enabled
      // && 'text-error-fg')` always paints the foreground over that background.
      // Folding the argument as unknown and scanning its literal separately
      // judged the foreground with no background beside it.
      const inner =
        fold(argument, source, joins, held) ?? contributed(argument, source, joins, held);
      if (inner === null) {
        pieces.push(unknownPiece(argument));
        unknown.push(argument);
        continue;
      }
      pieces.push(...inner.pieces);
      unknown.push(...inner.unknown);
    }
    return pieces.length === 0 ? null : { pieces, unknown };
  }

  return null;
}

/**
 * What a CONDITIONAL class-list argument can contribute.
 *
 * `enabled && 'x'` contributes `x` or nothing; `cond ? 'x' : 'y'` contributes
 * one of the two.  Either way every class named here renders on the same
 * element as its siblings, which is the only thing the pairing question asks —
 * so both sides are folded in, and a side that says nothing is dropped rather
 * than making the whole argument unknown.
 */
function contributed(
  node: Syntax,
  source: string,
  joins?: (callee: Syntax) => boolean,
  held?: (name: Syntax) => readonly Syntax[],
): Fold | null {
  // ONLY the logical operators, whose operand either contributes or does not
  // — so unioning them is exact.  A TERNARY'S branches are mutually EXCLUSIVE
  // and are handled as alternatives instead: unioning `cond ? 'bg-error' :
  // 'text-error-fg'` made the white foreground look paired with a solid fill
  // that is never present in the same state.
  const sides =
    node.kind === SyntaxKind.BinaryExpression &&
    CONDITIONAL_OPERATORS.has(node.operatorToken?.kind ?? -1)
      ? [node.left, node.right]
      : [];
  if (sides.length === 0) return null;
  const pieces: Piece[] = [];
  const unknown: Syntax[] = [];
  let any = false;
  for (const side of sides) {
    if (side === undefined) continue;
    const folded = fold(side, source, joins, held) ?? contributed(side, source, joins, held);
    if (folded === null) continue;
    if (any) pieces.push({ text: ' ', at: side.getStart(), verbatimAt: null });
    any = true;
    pieces.push(...folded.pieces);
    unknown.push(...folded.unknown);
  }
  return any ? { pieces, unknown } : null;
}

/** Operators whose operands may or may not contribute their classes. */
const CONDITIONAL_OPERATORS: ReadonlySet<number> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** An expression with its transparent wrappers removed. */
function bare(node: Syntax | undefined): Syntax | undefined {
  let current = node;
  for (let hop = 0; current !== undefined && hop < 8; hop += 1) {
    if (!TRANSPARENT.has(current.kind)) return current;
    current = current.expression;
  }
  return current;
}

/** How many alternative class sets one expression may produce. */
const MAX_ALTERNATIVES = 16;

/**
 * Every class set an expression can render, as ALTERNATIVES.
 *
 * A class-list call whose arguments include a ternary renders one set per
 * branch, not the union of both — the branches never render together, so
 * merging them invented a pairing that the element never has.  Everything else
 * has exactly one set, which is what `fold` already answers.
 *
 * Bounded, because the combinations multiply: past the cap the sets are merged,
 * which is the conservative direction for a gate that reports unpaired
 * foregrounds.
 */
function foldEach(
  node: Syntax,
  source: string,
  joins?: (callee: Syntax) => boolean,
  held?: (name: Syntax) => readonly Syntax[],
): Fold[] {
  if (node.kind !== SyntaxKind.CallExpression || node.expression === undefined) {
    const one = fold(node, source, joins, held);
    return one === null ? [] : [one];
  }
  if (joins?.(node.expression) !== true) {
    const one = fold(node, source, joins, held);
    return one === null ? [] : [one];
  }
  // Each argument's own alternatives; a ternary has two, everything else one.
  const perArgument: Fold[][] = [];
  for (const argument of node.arguments ?? []) {
    const inner = bare(argument);
    const alternatives =
      inner?.kind === SyntaxKind.ConditionalExpression
        ? [inner.whenTrue, inner.whenFalse]
            .filter((side): side is Syntax => side !== undefined)
            .flatMap((side) => foldEach(side, source, joins, held))
        : [
            fold(argument, source, joins, held) ?? contributed(argument, source, joins, held),
          ].filter((each): each is Fold => each !== null);
    perArgument.push(
      alternatives.length > 0
        ? alternatives
        : [{ pieces: [unknownPiece(argument)], unknown: [argument] }],
    );
  }
  if (perArgument.length === 0) return [];
  const total = perArgument.reduce((count, each) => count * each.length, 1);
  if (total > MAX_ALTERNATIVES) {
    const one = fold(node, source, joins, held);
    return one === null ? [] : [one];
  }
  let combinations: Fold[] = [{ pieces: [], unknown: [] }];
  for (const alternatives of perArgument) {
    const next: Fold[] = [];
    for (const so_far of combinations) {
      for (const one of alternatives) {
        const separator: Piece[] =
          so_far.pieces.length === 0
            ? []
            : [{ text: ' ', at: one.pieces[0]?.at ?? node.getStart(), verbatimAt: null }];
        next.push({
          pieces: [...so_far.pieces, ...separator, ...one.pieces],
          unknown: [...so_far.unknown, ...one.unknown],
        });
      }
    }
    combinations = next;
  }
  return combinations;
}

/** The JSX element an expression sits inside, from the tree. */
function enclosingElement(node: Syntax): string | null {
  for (let up = node.parent; up !== undefined; up = up.parent) {
    if (up.kind === SyntaxKind.JsxSelfClosingElement || up.kind === SyntaxKind.JsxOpeningElement) {
      return up.tagName?.getText() ?? null;
    }
  }
  return null;
}

/** Join a fold's pieces into the rendered text, with a source offset per unit. */
function render(pieces: readonly Piece[], node: Syntax): ClassString {
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

/**
 * Every class string each source can render.
 *
 * The parse comes from `ts-source`, which is also what settles which GRAMMAR
 * each file is read with: `<string>x` is a type assertion in a `.ts` file and
 * malformed JSX in a `.tsx` one, so a shared mount that forced one extension on
 * every source made a legal `.ts` helper parse as nothing at all.
 */
export function readClassStrings(files: readonly SourceFile[]): Map<string, ClassString[]> {
  return withParsedSources(files, (parsed, project) => {
    const found = new Map<string, ClassString[]>();
    for (const { path, content, root } of parsed) {
      const here = String(root.path);
      // Which callees are the class-list helper, resolved in ONE round trip.
      //
      // Asked per call site, this cost a checker request for every call in the
      // file and pushed the whole-tree scan past its budget — the same cost
      // model that once made a repository-wide sink scan take three minutes.
      // `getSymbolAtPosition` takes an ARRAY, so the question is asked once.
      const calleeAt: number[] = [];
      const collect = (node: Syntax): void => {
        if (node.kind === SyntaxKind.CallExpression && node.expression !== undefined) {
          calleeAt.push(node.expression.getStart());
        }
        node.forEachChild(collect);
      };
      collect(root);
      const helperCalls = new Set<number>();
      if (calleeAt.length > 0) {
        project.checker.getSymbolAtPosition(here, calleeAt).forEach((symbol, index) => {
          const at = calleeAt[index];
          if (symbol === undefined || at === undefined) return;
          let resolved = symbol;
          try {
            resolved = project.checker.getAliasedSymbol(symbol) ?? symbol;
          } catch {
            // Not an alias; the local symbol is already the declaration.
          }
          if (resolved.declarations.some((each) => String(each.path).endsWith(CLASS_LIST_HELPER))) {
            helperCalls.add(at);
          }
        });
      }
      /** Whether a callee is the repository's class-list helper. */
      const joins = (callee: Syntax): boolean => helperCalls.has(callee.getStart());

      /**
       * What a NAME holds, for folding an interpolated class string.
       *
       * One hop through the binding, memoised — the narrow question, not the
       * general value relation, which would run a whole-program search for
       * every identifier in every template in the repository.
       */
      const bound = new Map<number, readonly Syntax[]>();
      const held = (name: Syntax): readonly Syntax[] => {
        const at = name.getStart();
        const cached = bound.get(at);
        if (cached !== undefined) return cached;
        bound.set(at, []); // cycle guard while this one resolves
        const declaration = project.checker
          .getSymbolAtPosition(here, at)
          ?.declarations.find((each) => String(each.path) === here)
          ?.resolve(project) as unknown as Syntax | undefined;
        const initializer =
          declaration?.kind === SyntaxKind.VariableDeclaration
            ? declaration.initializer
            : undefined;
        const found = initializer === undefined ? [] : [initializer];
        bound.set(at, found);
        return found;
      };
      const strings: ClassString[] = [];
      const visit = (node: Syntax): void => {
        const alternatives = foldEach(node, content, joins, held);
        const folded = alternatives[0];
        if (folded === undefined) {
          node.forEachChild(visit);
          return;
        }
        for (const each of alternatives) strings.push(render(each.pieces, node));
        // Only the parts this fold could NOT read are walked again, so a class
        // buried in a call argument is still found and a folded one is not
        // counted twice.
        for (const part of folded.unknown) part.forEachChild(visit);
      };
      visit(root);
      found.set(path, strings);
    }
    return found;
  });
}
