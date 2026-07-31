// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The comment blanker the TREE-WALKING static gates share.
//
// A gate must scan CODE, not prose: this repository mandates an SPDX header plus
// a doctrine block on every source file, and those comments name the very
// constructs the gates forbid.  Each gate had grown its own two-regex answer to
// that — `content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')`
// — and a regex has no notion of a string literal, so a `/*` INSIDE one opened a
// fake block comment that swallowed every line up to the next real `*/` (any
// JSDoc later in the file supplies one).  A real `fetch(` or a public-gateway URL
// sitting in the swallowed span was invisible, and the gate reported clean.
// `'a // b'` lost its tail the same way.  The case is ambiguous without a parser;
// `blankComments` hands it to one.
//
// Two properties this module adds on top of `blankComments`:
//
//   • BATCHED.  `withParsedSources` spawns one compiler host per call, so
//     blanking a tree one file at a time costs seconds per hundred files.  A
//     whole-tree gate hands its entire file list in and pays for ONE parse
//     (the same discipline `findDynamicCodeSinksIn` documents for sink scans).
//
//   • JSX-COMMENT AWARE.  `{/* … */}` is a `JsxExpression` with NO expression,
//     so the comment inside it is the leading trivia of no node at all and
//     `blankComments` leaves it standing.  The component-tree gates scan `.tsx`,
//     where that is the ordinary way to write a comment, so the whole empty
//     `JsxExpression` is blanked here — structurally, from the parse, rather
//     than with the `{\/\*[\s\S]*?\*\/\}` regex that has the same
//     string-literal blindness as the pair it replaces.
//
// Blanking is length- and newline-preserving in both halves, so a match index
// still maps to its true source line: a gate that reports `i + 1` from
// `code.split('\n')` names the line the violation is actually on.
import { SyntaxKind } from 'typescript/unstable/ast';
import { blankComments, type Source, type Syntax, walk, withParsedSources } from './ts-source.js';

/** Replace `[from, to)` with spaces, leaving line breaks where they are. */
function blankRange(out: string[], from: number, to: number): void {
  for (let at = from; at < to && at < out.length; at += 1) {
    if (out[at] !== '\n' && out[at] !== '\r') out[at] = ' ';
  }
}

/**
 * Blank every `{/* … *␓/}` JSX child.
 *
 * The parser puts a comment in a node's LEADING TRIVIA, and a JSX comment
 * expression has no child node for it to lead — so this is the one comment form
 * `blankComments` cannot reach, and the applause/egress gates that scan the
 * component tree would otherwise read a doctrine note ("never a thumbs-up here")
 * as the affordance itself.
 */
function blankJsxComments(code: string, root: Syntax): string {
  const out = code.split('');
  let found = false;
  for (const node of walk(root)) {
    if (node.kind !== SyntaxKind.JsxExpression || node.expression !== undefined) continue;
    found = true;
    blankRange(out, node.getStart(), node.getEnd());
  }
  return found ? out.join('') : code;
}

/**
 * One ALREADY-PARSED source, comments blanked.
 *
 * For a gate that opens its own `withParsedSources` because it also asks the
 * tree a structural question: it blanks inside that parse instead of paying for
 * a second one.
 */
export function blankParsedComments(content: string, root: Syntax): string {
  return blankJsxComments(blankComments(content, root), root);
}

/**
 * Every source with its comments blanked, sharing ONE parse.
 *
 * A gate that walks a directory tree must use this rather than calling the
 * single-source form per file — see the batching note in the module header.
 */
export function blankCommentsIn(sources: readonly Source[]): Map<string, string> {
  return withParsedSources(sources, (parsed) => {
    const byPath = new Map<string, string>();
    for (const { path, content, root } of parsed) {
      byPath.set(path, blankParsedComments(content, root));
    }
    return byPath;
  });
}

/**
 * One source, comments blanked.
 *
 * The PATH is required, not cosmetic: the extension selects the grammar
 * (`<string>x` is a type assertion in `.ts` and malformed JSX in `.tsx`), and a
 * source that parses as the wrong dialect yields a tree the gate reads as empty.
 */
export function blankSourceComments(path: string, content: string): string {
  return blankCommentsIn([{ path, content }]).get(path) ?? content;
}
