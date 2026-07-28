// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dynamic-code sink detection, over the PARSE.
//
// The question every dynamic-code gate has to answer is: does some expression
// evaluate to a sink, and is it then INVOKED?  That is a question about binding
// and about program structure, and it has now been answered three ways here.
//
// First by regex, which found a new bypass SPELLING on six consecutive review
// rounds.  Then by a hand-written token analyzer — a lexer, an expression
// reader, an alias table, a receiver table — which took FIFTEEN commits, each
// adding one more case: complete the lexical coverage, resolve sink aliases,
// follow typed aliases, unwrap parenthesised references, treat `.constructor`
// as the Function sink, fold constant strings, resolve destructured and
// object-held sinks, treat an alias of a global receiver as a receiver, resolve
// sinks held in containers, walk DOM sinks, unblind the shared lexer.  Every
// one was a real hole and every fix was correct.  The list did not shorten
// because it was never a list of bugs: it was the JavaScript grammar and its
// scoping rules, restated by hand next to a compiler that has both.
//
// So the source is PARSED, and the compiler answers the two hard parts:
//
//   • IS THIS THE GLOBAL?  An identifier is the global `eval` exactly when its
//     symbol has no declaration in this file.  Scope, shadowing, hoisting,
//     parameters and imports come with that for free — the token analyzer could
//     not see `(eval: (s: string) => void) => eval(x)` as a parameter at all.
//   • WHERE DOES THIS NAME COME FROM?  `const F = Function` is a binding, so
//     following it is one hop from the symbol to its declaration, not an alias
//     table maintained beside the scan.
//
// Two whole layers disappear with the token stream.  It had to run the entire
// analysis TWICE, under both readings of `/`, because a lexer cannot tell a
// regex from a division; and it had to re-tokenise every `${…}` span, because a
// template arrived as one token.  A parser has no ambiguity to hedge, and an
// interpolation is already a child expression.
//
// What is still written out is the part that is genuinely a program analysis
// rather than a parse: which property of which container holds what.  It is
// small, it is keyed on SYMBOLS rather than on names, and the copy-on-write
// behaviour the old table needed a rule for now falls out — `g.zzz` and
// `self.zzz` are different keys because `g` and `self` are different symbols.
//
// ONE RULE ABOUT WHICH RESOLVER TO USE, learned three times in one day.
//
// `reaches` answers an OPEN question — what values can this expression be —
// and its callers are the gates, at the leaves.  `flowsInto` is its STEP
// function, and the questions asked from inside a step are CLOSED: is this
// receiver the global `Proxy`?  which property access does this callee denote?
// what string does this name hold?
//
// Answering a closed question by running the open search makes the step
// function depend on the search's own closure.  Each of those three did it, and
// each cost the same way: a repository scan that took 25 seconds took more than
// ten minutes, and the URL scan stopped terminating altogether.  Measured, not
// guessed — the sink scan is linear at ~18ms/file and was never the problem.
//
// So a closed question gets a dedicated walk: `globalsBehind`, `accessesBehind`,
// and the URL scan's own `held`.  They are memoised, linear, and follow exactly
// what can rename the thing they are about — a binding, a reassignment, an
// import, a parameter's call sites, a function's returns, a container slot, a
// selection between any of those.  That is the SAME coverage the open search
// has for these shapes, computed once instead of re-explored per call; the
// mistake to avoid is not "a second walk", it is a second walk that knows LESS.

import { SyntaxKind } from 'typescript/unstable/ast';
import type { Project } from 'typescript/unstable/sync';
import {
  asNode,
  lineAt,
  newlineIndex,
  type Source,
  type Syntax,
  walk,
  withParsedSources,
} from './ts-source.js';

export type { Source } from './ts-source.js';

/**
 * A STRING the relation proved, which no node in the source spells.
 *
 * `String(payload)` and `x.toString()` produce one, and so does a wrapper that
 * was handed `String` — the coercion is a fact about the VALUE, not about the
 * syntax at the call, so a predicate reading nodes alone could never see it.
 */
export interface CoercedString {
  readonly coercedString: true;
}

/** What a sink's code-argument predicate is given: expressions, and coercions. */
export type SinkValue = Syntax | CoercedString;

const COERCED: CoercedString = { coercedString: true };

/** Methods whose RESULT is a string, whatever they are called on. */
const STRING_COERCIONS: ReadonlySet<string> = new Set([
  'toString',
  'toLocaleString',
  'stringify',
  'join',
]);

/** A globally-named dynamic-code sink. */
export interface SinkSpec {
  /** The identifier that names the sink (`eval`, `Function`, `setTimeout`, …). */
  readonly name: string;
  /** Human label the gates wrap in their own phrasing. */
  readonly label: string;
  /**
   * Predicate on the CODE argument.  Omitted ⇒ any invocation is a sink
   * (`eval`/`Function` evaluate whatever they are given).  Supplied ⇒ the
   * argument must satisfy it, which is how `setTimeout(fn, 0)` stays clean
   * while `setTimeout('code', 0)` does not.
   */
  readonly codeArgument?: (values: readonly SinkValue[]) => boolean;
  /**
   * The sink takes an UNBOUNDED list of code arguments, so `codeArgument` is
   * tested against every one of them and any match fires.  `importScripts`
   * loads each URL it is handed, so judging only the first would clear
   * `importScripts('/local.js', 'https://evil.example/x.js')`.
   */
  readonly variadic?: boolean;
}

/** A sink named by a PROPERTY rather than by a global. */
export interface MemberSinkSpec {
  /** The identifier the property must hang off, or undefined for ANY receiver. */
  readonly receiver?: string;
  readonly property: string;
  /** `assign` — `x.p = …` (and `+=`); `call` — `x.p(…)`. */
  readonly form: 'assign' | 'call';
  readonly label: string;
}

export interface SinkFinding {
  readonly label: string;
  readonly line: number;
  /** Source text of the invocation, for the gate's message. */
  readonly text: string;
}

/** Receivers that ARE the global object, so `X.eval` is the global `eval`. */
const GLOBAL_RECEIVERS: ReadonlySet<string> = new Set([
  'globalThis',
  'window',
  'self',
  'global',
  'frames',
  'top',
  'parent',
]);

/** Methods that invoke their receiver, so `F.call(…)` still runs `F`. */
const INVOKERS: ReadonlySet<string> = new Set(['call', 'apply', 'bind']);

/** `Reflect` methods that invoke their FIRST argument. */
const REFLECT_INVOKERS: ReadonlySet<string> = new Set(['apply', 'construct']);

/**
 * Operators that WRITE the property they are applied to.
 *
 * `+=` appends markup as destructively as `=` does, and the logical forms write
 * it too — `node.innerHTML ||= payload` sets it whenever the element is empty,
 * which is exactly when a sink assignment matters.
 */
const WRITING_ASSIGNMENTS: ReadonlySet<number> = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Bindings that name a value declared in ANOTHER module. */
const IMPORT_BINDINGS: ReadonlySet<number> = new Set([
  SyntaxKind.ImportSpecifier,
  SyntaxKind.ImportClause,
  SyntaxKind.NamespaceImport,
  SyntaxKind.ImportEqualsDeclaration,
]);

/** Wrappers that yield exactly the expression they wrap. */
const TRANSPARENT: ReadonlySet<number> = new Set([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.TypeAssertionExpression,
]);

/** How far an alias chain is followed before it is treated as a cycle. */
const MAX_HOPS = 24;

/** Operators that SELECT one of their operands, either of which may run. */
const SELECTORS: ReadonlySet<number> = new Set([
  SyntaxKind.BarBarToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * Strip everything that changes nothing about what an expression evaluates to.
 *
 * A COMMA expression is one of them: `(0, eval)` evaluates to `eval`, and the
 * `(0, …)` wrapper is the idiomatic way to call a global without a receiver.
 */
function unwrap(node: Syntax | undefined): Syntax | undefined {
  let current = node;
  for (let hop = 0; current !== undefined && hop <= MAX_HOPS; hop += 1) {
    if (TRANSPARENT.has(current.kind)) {
      current = current.expression;
      continue;
    }
    if (
      current.kind === SyntaxKind.BinaryExpression &&
      current.operatorToken?.kind === SyntaxKind.CommaToken
    ) {
      current = current.right;
      continue;
    }
    return current;
  }
  return current;
}

/** An identifier's NAME, with any `\u` escape already resolved. */
function nameOf(node: Syntax): string {
  return node.text ?? node.getText();
}

/** The arguments of a call, in order. */
function argumentsOf(call: Syntax): Syntax[] {
  const args: Syntax[] = [];
  for (const arg of call.arguments ?? []) args.push(arg);
  return args;
}

/** The child nodes of a node, in order. */
function childrenOf(node: Syntax): Syntax[] {
  const children: Syntax[] = [];
  node.forEachChild((child: Syntax) => {
    children.push(child);
  });
  return children;
}

/**
 * A value a resolution can arrive at.
 *
 * FOUR kinds, and the two beyond the obvious pair are what keep every sink
 * inside one model:
 *
 *   • `node` — an expression written in this file.
 *   • `global` — a name with no declaration here.  Globals are named rather
 *     than pointed at because they have none: `eval` IS its name, and that is
 *     what a spec matches.
 *   • `member` — a METHOD ON a receiver, `document.write`.  It is a value for
 *     the same reason a global is: `const write = document.write` copies the
 *     method, so a detector that reads the ACCESS syntax sees nothing and one
 *     that reads the value sees it.  Member sinks used to be found by matching
 *     the shape of the access and its parent, which is why exactly one `const`
 *     hid the most explicitly forbidden call in the project.
 *   • `result` — whatever CALLING another value yields.  Written as a wrapper
 *     rather than resolved on the spot so that "the function being called" is
 *     resolved by the same relation as everything else: `flowsInto` on a
 *     `result` either reads a function's returns or DISTRIBUTES over the
 *     callee's own flow.  The previous shape — a `returnedBy` helper that
 *     re-implemented identifier and property resolution — was the last walker
 *     left outside the unification, and it missed every callee reached through
 *     an alias or held in an object.
 */
type Value =
  | { readonly kind: 'node'; readonly node: Syntax }
  | { readonly kind: 'global'; readonly name: string }
  | { readonly kind: 'member'; readonly access: Syntax; readonly property: string }
  | { readonly kind: 'result'; readonly of: Value };

const nodeValue = (node: Syntax): Value => ({ kind: 'node', node });
const globalValue = (name: string): Value => ({ kind: 'global', name });
const memberValue = (access: Syntax, property: string): Value => ({
  kind: 'member',
  access,
  property,
});
const resultValue = (of: Value): Value => ({ kind: 'result', of });

/** A structural identity for a value, so a search visits each one once. */
function valueKey(value: Value): string {
  switch (value.kind) {
    case 'global':
      return `g:${value.name}`;
    case 'member':
      return `m:${value.access.getStart()}:${value.access.getEnd()}:${value.property}`;
    case 'result':
      return `r:${valueKey(value.of)}`;
    default:
      return `n:${value.node.getStart()}:${value.node.getEnd()}`;
  }
}

/**
 * A ceiling on one resolution, which EXISTS ONLY TO BE UNREACHABLE.
 *
 * Termination does not depend on it: every key is derived from a node range or
 * a global name, both finite in a file, so the search ends on its own.  The
 * ceiling is a backstop against a defect in that reasoning — so exceeding it
 * THROWS rather than returning what was found so far.
 *
 * It used to be 512 and it used to return quietly, which made it a bypass: 512
 * benign assignments to a name, then the sink, and the search stopped short of
 * the assignment that mattered and reported the file clean.  A ceiling a gate
 * can be padded past is worse than no ceiling at all.
 */
const MAX_VALUES = 200_000;

/** Where a sink's code argument starts, and whether it arrives inside an array. */
interface CodePosition {
  readonly index: number;
  readonly inArray: boolean;
}

/** The static leading text of a string expression, or `null` when unknown. */
function staticPrefix(
  node: Syntax | undefined,
  hop = 0,
  held?: (node: Syntax) => readonly Syntax[],
): string | null {
  const target = unwrap(node);
  if (target === undefined || hop > MAX_HOPS) return null;
  if (
    target.kind === SyntaxKind.StringLiteral ||
    target.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return target.text ?? '';
  }
  // A template's HEAD is everything before the first hole, which is all a
  // scheme check can depend on.
  if (target.kind === SyntaxKind.TemplateExpression) return target.head?.text ?? '';
  if (
    target.kind === SyntaxKind.BinaryExpression &&
    target.operatorToken?.kind === SyntaxKind.PlusToken
  ) {
    const left = staticPrefix(target.left, hop + 1, held);
    if (left === null) return null;
    const right = staticPrefix(target.right, hop + 1, held);
    return right === null ? left : left + right;
  }
  // A NAME holding the text folds to what it holds, when the caller can say:
  // `const scheme = 'javascript'; scheme + ':alert(1)'` navigates exactly as
  // the spelled literal does, and reading syntax alone saw two halves of
  // nothing.
  if (held !== undefined && target.kind === SyntaxKind.Identifier) {
    for (const value of held(target)) {
      if (value.getStart() === target.getStart()) continue;
      const folded = staticPrefix(value, hop + 1, held);
      if (folded !== null) return folded;
    }
  }
  return null;
}

/**
 * The COMPLETE static string an expression denotes, or `null` when any part of
 * it is unknown.
 *
 * Distinct from {@link staticPrefix}, and deliberately so.  A URL SCHEME check
 * depends only on the leading text, so a known prefix with an unknown tail is a
 * usable answer there.  A property KEY is the whole value: `'eval' +
 * String('Safe')` has the prefix `eval` and names `evalSafe`, which is not the
 * global — reading the prefix as the key made a harmless source fail
 * `lint:security`.  Concatenation folds only when BOTH sides fold, and a
 * template with holes folds to nothing.
 */
function staticText(
  node: Syntax | undefined,
  hop = 0,
  bound?: (identifier: Syntax) => Syntax | undefined,
): string | null {
  const target = unwrap(node);
  if (target === undefined || hop > MAX_HOPS) return null;
  if (
    target.kind === SyntaxKind.StringLiteral ||
    target.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return target.text ?? '';
  }
  if (
    target.kind === SyntaxKind.BinaryExpression &&
    target.operatorToken?.kind === SyntaxKind.PlusToken
  ) {
    const left = staticText(target.left, hop + 1, bound);
    if (left === null) return null;
    const right = staticText(target.right, hop + 1, bound);
    return right === null ? null : left + right;
  }
  // A `const` holding the text folds to what it holds: `const a = 'ev', b =
  // 'al'; globalThis[a + b]` names `eval` as surely as the spelled literal
  // does, and the checker widens `a + b` to `string` so the type cannot settle
  // it.  Only an immutable binding is followed — a `let` may hold something
  // else by the time the key is read, and folding it would invent a key.
  //
  // A container SLOT is deliberately NOT followed.  `const` prevents rebinding
  // the name, not mutating the object, so `const keys = { a: 'ev' }; keys.a =
  // 'safe'` makes the literal a lie — folding it would invent a key the code
  // never uses, which is a FALSE POSITIVE in a gate.  Proving a container
  // unmutated is whole-program aliasing analysis, the unbounded question this
  // module's header declines; the CSP is the control for a key assembled that
  // way.  See docs/planning/audit-residuals-2026-07.md.
  if (bound !== undefined && target.kind === SyntaxKind.Identifier) {
    const held = bound(target);
    if (held !== undefined) return staticText(held, hop + 1, bound);
  }
  return null;
}

/**
 * The static property name a KEY expression denotes, whatever spelling reaches
 * it.
 *
 * `o.run`, `o['run']`, `o[key]` after `const key = 'run'`, and the computed
 * binding `const { ['run']: r } = o` all select the same property; the key's
 * TYPE settles every one of them, so no rule is needed per form.  It lives at
 * module scope because the forbidden-global rule asks the same question of the
 * same kind of node as the value-flow analyzer does, and answering it twice is
 * how one of the two ends up not covering a spelling.
 */
export function staticKeyOf(
  argument: Syntax | undefined,
  project: Project,
  folding: Folding = 'possible',
): string | undefined {
  if (argument === undefined) return undefined;
  const type = project.checker.getTypeAtLocation(asNode(argument));
  if (type?.isStringLiteralType() === true) return String(type.value);
  if (type?.isNumberLiteralType() === true) return String(type.value);
  // A literal the checker did not narrow (a `.js` source has no `as const`).
  if (argument.kind === SyntaxKind.NumericLiteral) return argument.text ?? argument.getText();
  // A key the checker did not narrow, including a COMPOSED one:
  // `node['inner' + 'HTML']` names the same property as the plain spelling —
  // but only when the WHOLE key folds, which is what separates it from a
  // scheme prefix.
  return (
    staticText(argument, 0, (identifier) => constantValue(identifier, project, folding)) ??
    undefined
  );
}

/**
 * What an immutable local binding holds, or undefined when it is not one.
 *
 * `const` only: a `let` can hold something else by the time the key is read, so
 * folding it would invent a property name the code never selects.
 */
/**
 * Which values a fold may use.
 *
 * `'possible'` — anything the binding MAY hold, defaults included.  Right for
 *   "could this key name a forbidden global", where a value the code can take
 *   is a value worth reporting.
 * `'certain'`  — only what the binding definitely holds.  Right for "WHICH
 *   route method is this", where a default is one candidate among several and
 *   guessing it misclassifies the registration: `function h(method = 'get')`
 *   called with `'post'` registers a POST, and folding the default called it a
 *   GET and dropped a governance mutation.
 *
 * Sharing one resolver was right; sharing one POLICY was not, because the two
 * gates are not asking the same question.
 */
export type Folding = 'possible' | 'certain';

function constantValue(
  identifier: Syntax,
  project: Project,
  folding: Folding = 'possible',
): Syntax | undefined {
  const declaration = declarationOf(identifier, project);
  if (declaration === undefined) return undefined;
  // A plain parameter folds to its own DEFAULT — `(key = 'eval') => …` holds
  // exactly that whenever the call omits the argument — but only when a
  // POSSIBLE value will do.
  if (declaration.kind === SyntaxKind.Parameter) {
    return folding === 'possible' ? declaration.initializer : undefined;
  }
  const foldability = foldabilityOf(declaration);
  if (foldability === 'no' || (foldability === 'default' && folding === 'certain')) {
    return undefined;
  }
  if (declaration.kind === SyntaxKind.VariableDeclaration) return declaration.initializer;
  // `const { a, b } = { a: 'ev', b: 'al' }` binds through a PATTERN, so what
  // the name holds is whatever the source holds at the key this element takes;
  // for a parameter pattern that source IS the default, which the descent
  // already yields.
  return declaration.kind === SyntaxKind.BindingElement
    ? selectedValue(declaration, project, 0, folding)
    : undefined;
}

/** The declaration a name binds to, within the file the name sits in. */
function declarationOf(identifier: Syntax, project: Project): Syntax | undefined {
  const path = String(identifier.getSourceFile?.()?.path ?? '');
  if (path === '') return undefined;
  return project.checker
    .getSymbolAtPosition(path, identifier.getStart())
    ?.declarations.find((each) => String(each.path) === path)
    ?.resolve(project) as unknown as Syntax | undefined;
}

/**
 * Whether a declaration cannot be rebound.
 *
 * `const` only: a `let` may hold something else by the time the value is read,
 * so folding it would invent a value the code never has.
 */
/**
 * Binders that give a name its value somewhere this cannot read, so the walk
 * out to a declaration keyword must stop at them with no value at all.
 *
 * A PARAMETER is deliberately absent: it has an answer, just a different one —
 * see {@link foldabilityOf}.
 */
const BINDS_ELSEWHERE: ReadonlySet<number> = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/**
 * What a binding may be folded to, if anything.
 *
 * The distinction that matters is between a value written HERE and a value that
 * arrives from somewhere this cannot see.
 *
 *   `'const'`   — the declaration'"'"'s own initializer, the only value it holds.
 *   `'default'` — a PARAMETER'"'"'s default.  One value it may hold, and the one
 *                 it does hold whenever the argument is omitted or `undefined`.
 *                 A caller'"'"'s argument is never folded: callers live in other
 *                 files, so treating a default as THE value missed a caller
 *                 passing something else — and treating a parameter as `const`
 *                 because the enclosing `const fn = …` is one invented a value
 *                 outright.
 *   `'no'`      — a `let`, a catch binding, anything else.
 */
type Foldability = 'const' | 'default' | 'no';

function foldabilityOf(declaration: Syntax): Foldability {
  let owner: Syntax | undefined = declaration.parent;
  for (let hop = 0; owner !== undefined && hop <= MAX_HOPS; hop += 1) {
    // A parameter and a CATCH binding are the same case: the incoming value is
    // supplied from outside and unfoldable, while the default beside it is
    // written here and is what binds when that value omits the property.
    if (owner.kind === SyntaxKind.Parameter || owner.kind === SyntaxKind.CatchClause) {
      return 'default';
    }
    if (owner.kind === SyntaxKind.VariableDeclarationList) {
      return /^const\b/.test(owner.getText()) ? 'const' : 'no';
    }
    if (BINDS_ELSEWHERE.has(owner.kind)) return 'no';
    owner = owner.parent;
  }
  return 'no';
}

/**
 * The branch a conditional takes, when its condition is DECIDABLE.
 *
 * The condition may be written as a literal or held in an immutable binding —
 * `const yes = true; yes ? undefined : 'safe'` selects the same branch as the
 * spelled `true` does — so it is resolved rather than pattern-matched on kind.
 */
function decidedBranch(node: Syntax, project: Project, hop = 0): Syntax | undefined {
  const condition = unwrap(node.condition);
  if (condition === undefined || hop > MAX_HOPS) return undefined;
  if (condition.kind === SyntaxKind.TrueKeyword) return node.whenTrue;
  if (condition.kind === SyntaxKind.FalseKeyword) return node.whenFalse;
  if (condition.kind !== SyntaxKind.Identifier) return undefined;
  const held = constantValue(condition, project);
  if (held === undefined) return undefined;
  const folded = unwrap(held);
  if (folded?.kind === SyntaxKind.TrueKeyword) return node.whenTrue;
  if (folded?.kind === SyntaxKind.FalseKeyword) return node.whenFalse;
  return folded?.kind === SyntaxKind.ConditionalExpression
    ? decidedBranch(folded, project, hop + 1)
    : undefined;
}

/** Containers a destructure reads BY POSITION rather than by name. */
const POSITIONAL: ReadonlySet<number> = new Set([
  SyntaxKind.ArrayBindingPattern,
  SyntaxKind.ArrayLiteralExpression,
]);

/**
 * The key an element takes from its container: a NAME in an object one, a
 * POSITION in an array one.
 *
 * Both container kinds are handled here rather than only objects, because a
 * destructure nests them freely: `const [{ ['eval']: run }] = [globalThis]`
 * reads index 0 and then a property, and treating the array element as a
 * property selected nothing at all.
 */
function containerKey(element: Syntax, container: Syntax, project: Project): string | undefined {
  if (POSITIONAL.has(container.kind)) {
    const at = childrenOf(container).findIndex((each) => each.getStart() === element.getStart());
    return at < 0 ? undefined : String(at);
  }
  const named = (element.propertyName ?? element.name) as Syntax | undefined;
  return keyText(named, project);
}

/** The key a destructuring element names, however it is spelled. */
function keyText(named: Syntax | undefined, project: Project): string | undefined {
  if (named === undefined) return undefined;
  if (named.kind === SyntaxKind.ComputedPropertyName) return staticKeyOf(named.expression, project);
  return named.text ?? named.getText();
}

/** What a source holds at `key` — a property of an object, an index of an
 *  array, or whatever the name it is reached through holds. */
function valueAt(
  source: Syntax | undefined,
  key: string,
  project: Project,
  hop: number,
): Syntax | undefined {
  const target = unwrap(source);
  if (target === undefined || hop > MAX_HOPS) return undefined;
  // Reached through a NAME rather than written inline.  A slot reached through
  // another SLOT is not followed, for the mutability reason `staticText`
  // records.
  if (target.kind === SyntaxKind.Identifier) {
    return valueAt(constantValue(target, project), key, project, hop + 1);
  }
  if (target.kind === SyntaxKind.ArrayLiteralExpression) {
    const at = Number(key);
    return Number.isInteger(at) && at >= 0 ? childrenOf(target)[at] : undefined;
  }
  if (target.kind !== SyntaxKind.ObjectLiteralExpression) return undefined;
  for (const member of childrenOf(target)) {
    if (keyText(member.name, project) !== key) continue;
    if (member.kind === SyntaxKind.PropertyAssignment) return member.initializer;
    if (member.kind === SyntaxKind.ShorthandPropertyAssignment) return member.name;
  }
  return undefined;
}

/**
 * Whether a source is a container whose ABSENT keys can be trusted.
 *
 * An object or array literal — reached directly or through immutable bindings —
 * can be read, so a key it lacks is genuinely absent.  A call, a parameter, an
 * import: those may hold anything, and "no key found" means "could not look".
 */
function isReadableContainer(source: Syntax | undefined, project: Project, hop: number): boolean {
  const target = unwrap(source);
  if (target === undefined || hop > MAX_HOPS) return false;
  if (
    target.kind === SyntaxKind.ObjectLiteralExpression ||
    target.kind === SyntaxKind.ArrayLiteralExpression
  ) {
    return true;
  }
  if (
    target.kind === SyntaxKind.Identifier ||
    target.kind === SyntaxKind.PropertyAccessExpression ||
    target.kind === SyntaxKind.ElementAccessExpression
  ) {
    return isReadableContainer(constantValue(target, project), project, hop + 1);
  }
  return false;
}

/**
 * The value a destructuring CONTAINER takes its properties from.
 *
 * A binding pattern gets its source from the declaration or parameter that owns
 * it; an object or array literal used as an assignment TARGET gets it from the
 * right of the `=`.  Either can NEST, and a nested container selects from the
 * slot its own element took — by name inside an object, by position inside an
 * array.  When the descent finds no such slot, a binding element's DEFAULT is
 * what binds.
 *
 * A literal that is NOT an assignment target has no source: `const o = {
 * ['eval']: 1 }` builds a record, and its key selects nothing.
 */
function selectionSource(
  container: Syntax | undefined,
  project: Project,
  hop: number,
): Syntax | undefined {
  const owner = container?.parent;
  if (container === undefined || owner === undefined || hop > MAX_HOPS) return undefined;

  /**
   * One level out: the slot this container was reached by, descended into.
   *
   * A default applies at EVERY step, not only the last.  `const { a: { k =
   * 'safe' } = { k: 'eval' } } = { a: undefined }` selects `undefined` for `a`,
   * so the OUTER default binds and the inner pattern destructures `{ k: 'eval'
   * }` — passing the `undefined` through instead made the inner default apply
   * and folded `k` to `safe`.
   */
  const through = (element: Syntax, outer: Syntax): Syntax | undefined => {
    const key = containerKey(element, outer, project);
    if (key === undefined) return undefined;
    const selected = valueAt(selectionSource(outer, project, hop + 1), key, project, 0);
    return selected === undefined || isUndefinedValue(selected, project) ? undefined : selected;
  };

  if (
    container.kind === SyntaxKind.ObjectLiteralExpression ||
    container.kind === SyntaxKind.ArrayLiteralExpression
  ) {
    if (
      owner.kind === SyntaxKind.BinaryExpression &&
      owner.operatorToken?.kind === SyntaxKind.EqualsToken &&
      unwrap(owner.left)?.getStart() === container.getStart()
    ) {
      return owner.right;
    }
    // A literal nested inside an assignment target is itself a target: by name
    // when its parent is a property, by position when it is an array element.
    if (owner.kind === SyntaxKind.PropertyAssignment && owner.parent !== undefined) {
      return through(owner, owner.parent);
    }
    if (owner.kind === SyntaxKind.ArrayLiteralExpression) return through(container, owner);
    return undefined;
  }

  // A binding pattern: owned by a declaration, a parameter, or — nested — by
  // the binding element that selected it.
  if (owner.kind !== SyntaxKind.BindingElement) return owner.initializer;
  const outer = owner.parent;
  return (outer === undefined ? undefined : through(owner, outer)) ?? owner.initializer;
}

/**
 * Whether an expression IS `undefined` — the value a destructuring default
 * replaces.
 */
function isUndefinedValue(node: Syntax | undefined, project: Project): boolean {
  const target = unwrap(node);
  if (target === undefined) return false;
  if (target.kind === SyntaxKind.VoidExpression) return true;
  // A conditional whose CONDITION is fixed at compile time selects one branch,
  // so `true ? undefined : 'safe'` is `undefined` and the default applies.
  // Rejecting the whole node kind read past that.
  if (target.kind === SyntaxKind.ConditionalExpression) {
    const taken = decidedBranch(target, project);
    return taken === undefined ? false : isUndefinedValue(taken, project);
  }
  if (target.kind !== SyntaxKind.Identifier) return false;
  if ((target.text ?? target.getText()) !== 'undefined') return false;
  // `undefined` is not a keyword — it is a global BINDING, and a parameter or a
  // local may shadow it.  `function f(undefined) { const { k = 'safe' } = { k:
  // undefined } }` holds whatever the caller passed, so reading the NAME and
  // folding to the default is the same mistake the parameter fold was: a name
  // read instead of resolved.  Only an unshadowed `undefined` is the primitive.
  return declarationOf(target, project) === undefined;
}

/**
 * What ONE binding element ultimately holds.
 *
 * A default applies when the selected property is ABSENT *or* explicitly
 * `undefined` — JavaScript makes no distinction, and reading only "found
 * nothing" left `const { a = 'ev' } = { a: undefined }` folding to the
 * `undefined` node instead of to `'ev'`.
 */
function selectedValue(
  element: Syntax,
  project: Project,
  hop: number,
  folding: Folding = 'possible',
): Syntax | undefined {
  const pattern = element.parent;
  if (pattern === undefined || hop > MAX_HOPS) return undefined;
  const source = selectionSource(pattern, project, hop + 1);
  const key = containerKey(element, pattern, project);
  const selected = key === undefined ? undefined : valueAt(source, key, project, 0);
  if (selected !== undefined && !isUndefinedValue(selected, project)) return selected;
  // The property is ABSENT or undefined, so the default is what binds — but
  // under CERTAIN folding that must be KNOWN, not assumed.  It is known only
  // when the source is a container this could actually read: `const { method =
  // 'get' } = getConfig()` may well bind `'post'`, and taking the fallback
  // there classified an unguarded governance POST as a GET.
  if (folding === 'certain' && !isReadableContainer(source, project, 0)) return undefined;
  return element.initializer ?? selected;
}

/**
 * The code argument is a STRING — the implicit-eval timer form.
 *
 * An INTERPOLATED template counts: a template with holes is still a string the
 * host compiles, so requiring a fully static literal would miss the form an
 * attacker is most likely to use.
 */
export const isStringLiteral = (values: readonly SinkValue[]): boolean =>
  values.some((value) => ('coercedString' in value ? true : isStringLike(value)));

/** Whether ONE expression is a string the host would compile. */
function isStringLike(node: Syntax | undefined): boolean {
  const target = unwrap(node);
  if (target === undefined) return false;
  if (
    target.kind === SyntaxKind.StringLiteral ||
    target.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    target.kind === SyntaxKind.TemplateExpression
  ) {
    return true;
  }
  // Concatenation with a string YIELDS a string, whichever side it is on.
  if (
    target.kind === SyntaxKind.BinaryExpression &&
    target.operatorToken?.kind === SyntaxKind.PlusToken
  ) {
    return isStringLike(target.left) || isStringLike(target.right);
  }
  return false;
}

/**
 * The code argument is a statically known URL that is NOT same-origin.
 *
 * An ALLOWLIST, not a denylist of remote schemes.  Listing the bad schemes is
 * the enumerate-the-spellings mistake in another costume: `http(s)://` and
 * protocol-relative `//` were listed, so `data:text/javascript,…`, `blob:`,
 * `javascript:` and `file:` all read as same-origin and loaded executable code
 * past the gate.  What the gate enforces is "same-origin imports only", and the
 * same-origin forms are the CLOSED set — a relative reference, with no scheme
 * and no authority.  Everything else is rejected, including schemes that do not
 * exist yet.
 *
 * A non-static argument yields `false`: the gate cannot evaluate
 * `importScripts(url)` and does not pretend to.  The CSP is the runtime half.
 *
 * URL-parser quirks are normalised first, because the browser normalises them
 * too and a check that skipped it would be reading a different URL than the one
 * that gets fetched: tabs and newlines are STRIPPED anywhere in a URL, and
 * leading control characters and spaces are trimmed.  A leading `\` is a `/`
 * for a special scheme, so `\\evil.example/x.js` is protocol-relative just as
 * `//evil.example/x.js` is.
 */
export const isNonSameOriginUrl = (values: readonly SinkValue[]): boolean =>
  // A coercion says a value is a STRING, not which URL it is, so it answers
  // nothing here and is skipped rather than guessed at.
  values.some((value) => !('coercedString' in value) && isOffOrigin(value));

/** Whether ONE expression is a statically known URL that is not same-origin. */
function isOffOrigin(node: Syntax): boolean {
  const prefix = staticPrefix(node);
  if (prefix === null) return false;
  // Written without a control-character regex class (which the linter forbids,
  // rightly — they are unreadable) but doing exactly what the URL parser does.
  const stripped = [...prefix].filter((c) => c !== '\t' && c !== '\n' && c !== '\r').join('');
  let from = 0;
  while (from < stripped.length && (stripped.codePointAt(from) ?? 0x21) <= 0x20) from += 1;
  const url = stripped.slice(from);
  if (/^[/\\]{2}/.test(url)) return true; // protocol-relative (either slash)
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url); // ANY scheme is off-origin
}

/**
 * Everything one file needs to answer "is this expression a sink".
 *
 * A closure rather than free functions because every answer depends on the
 * project the handles came from and on the container table built for this file.
 */
function analyser(root: Syntax, project: Project, source: string, batch: ReadonlySet<string>) {
  const filePath = String(root.path);
  /**
   * Whether a declaration belongs to a source in THIS SCAN.
   *
   * The question used to be "is it in THIS FILE", which made every import look
   * like a global: `export const run = eval` in one module and `run(payload)`
   * in another were two unrelated programs, and the invocation resolved to a
   * name with no declaration — the same answer a real global gives.  Splitting
   * an alias across a module boundary walked past every sink gate that way.
   */
  const inBatch = (path: unknown): boolean => batch.has(String(path));
  /**
   * The file a node belongs to.
   *
   * Only the ROOT carries `path`, so a nested node is asked for its source
   * file — which matters now that a declaration this follows may live in
   * ANOTHER source of the batch, where the offsets mean something else.
   */
  const pathOf = (node: Syntax): string =>
    String(node.getSourceFile?.()?.path ?? node.path ?? filePath);

  const symbolAt = (node: Syntax) =>
    project.checker.getSymbolAtPosition(pathOf(node), node.getStart());

  /**
   * Whether an identifier names a GLOBAL rather than something declared here.
   *
   * This is the whole of the scoping question, and the compiler answers it: a
   * parameter called `eval`, a `const eval` in a block, an import — each has a
   * declaration in this file, and none of them is the global sink.
   */
  const isGlobalBinding = (node: Syntax): boolean => {
    const symbol = symbolAt(node);
    if (symbol === undefined) return true;
    return !symbol.declarations.some((declaration) => inBatch(declaration.path));
  };

  /** The declaration a local name binds to, resolved to a node. */
  const localDeclaration = (node: Syntax): Syntax | undefined => {
    const symbol = symbolAt(node);
    const handle = symbol?.declarations.find((declaration) => inBatch(declaration.path));
    return handle?.resolve(project) as Syntax | undefined;
  };

  /**
   * A statically known property name, whatever spelling reaches it.
   *
   * `o.run`, `o['run']` and `o[key]` after `const key = 'run'` name the same
   * property; the key's TYPE settles all three, so no rule is needed per form.
   */
  const propertyName = (node: Syntax): string | undefined => {
    if (node.kind === SyntaxKind.PropertyAccessExpression) {
      return node.name === undefined ? undefined : nameOf(node.name);
    }
    if (node.kind !== SyntaxKind.ElementAccessExpression) return undefined;
    return staticKeyOf(node.argumentExpression, project);
  };

  /**
   * A stable key for the object a property hangs off.
   *
   * CANONICAL, because a second name for the same object is the same object:
   * `const alias = registry` must key where `registry` does, or a property
   * written through one name is invisible when read through the other.  So a
   * binding whose initializer is another identifier is followed to the name it
   * ultimately holds.
   *
   * That following stops at a GLOBAL, and the standard spellings OF the global
   * object collapse to ONE key there — `globalThis`, `window`, `self`, `top`
   * and the rest denote the same object at runtime, so a property written
   * through any of them is readable through all of them.  Keeping the spellings
   * apart made `window.run = eval; globalThis.run(payload)` invisible: two keys
   * for one slot, the write filed under the first and the read looked up under
   * the second.  `const g = globalThis` canonicalises there too.
   */
  const receiverKey = (base: Syntax, hop = 0): string | undefined => {
    const target = unwrap(base);
    if (target === undefined || hop > MAX_HOPS) return undefined;
    // A LITERAL is its own identity — it needs no name to be written into.
    // `Object.assign({}, { run: eval }).run(p)` fills a container that is never
    // bound to anything, and a key that required an identifier could not
    // record the write at all.
    if (
      target.kind === SyntaxKind.ObjectLiteralExpression ||
      target.kind === SyntaxKind.ArrayLiteralExpression
    ) {
      return `literal:${target.getStart()}:${target.getEnd()}`;
    }
    if (target.kind !== SyntaxKind.Identifier) return undefined;
    const declaration = symbolAt(target)?.declarations.find((each) => inBatch(each.path));
    if (declaration === undefined) {
      const name = nameOf(target);
      return GLOBAL_RECEIVERS.has(name) ? 'global:@globalThis' : `global:${name}`;
    }
    const bound = unwrap(
      (declaration.resolve(project) as unknown as Syntax | undefined)?.initializer,
    );
    if (bound?.kind === SyntaxKind.Identifier) return receiverKey(bound, hop + 1);
    return `${String(declaration.path)}#${declaration.index}`;
  };

  /**
   * Properties WRITTEN into a container: `const o = {}; o.run = eval`.
   *
   * Building a registry empty and filling it afterwards is the ordinary way one
   * is populated, so reading only the literal left the whole pattern open.
   */
  const written = new Map<string, Syntax[]>();
  /**
   * Values assigned to a NAME after it was declared.
   *
   * `let execute; execute = eval` gives the binding no initializer to read, and
   * a declaration is only where a name STARTS.  Every reaching assignment is
   * collected, because a gate must fire if any of them makes the name a sink.
   */
  const rebound = new Map<string, Syntax[]>();
  // Deferred: resolving a DESTRUCTURING target needs `heldAt`, which is defined
  // below, so the walk is invoked once the closure is fully built.
  const collectAssignments = (): void => {
    for (const node of walk(root)) {
      if (node.kind !== SyntaxKind.BinaryExpression) continue;
      if (node.operatorToken?.kind !== SyntaxKind.EqualsToken) continue;
      const target = unwrap(node.left);
      const value = node.right;
      if (target === undefined || value === undefined) continue;
      if (target.kind === SyntaxKind.Identifier) {
        const key = receiverKey(target);
        if (key !== undefined) rebound.set(key, [...(rebound.get(key) ?? []), value]);
        continue;
      }
      // `({ run: execute } = { run: eval })` rebinds `execute` exactly as
      // `execute = eval` does — a destructuring assignment is still an assignment.
      if (
        target.kind === SyntaxKind.ObjectLiteralExpression ||
        target.kind === SyntaxKind.ArrayLiteralExpression
      ) {
        const isArray = target.kind === SyntaxKind.ArrayLiteralExpression;
        childrenOf(target).forEach((member, index) => {
          const bound = member.kind === SyntaxKind.PropertyAssignment ? member.initializer : member;
          const from = isArray ? String(index) : nameOf(member.name ?? member);
          if (bound?.kind !== SyntaxKind.Identifier || from === undefined) return;
          const key = receiverKey(bound);
          const held = heldAt(value, from, 0);
          if (key === undefined || held === undefined) return;
          rebound.set(key, [...(rebound.get(key) ?? []), held]);
        });
        continue;
      }
      if (
        target.kind !== SyntaxKind.PropertyAccessExpression &&
        target.kind !== SyntaxKind.ElementAccessExpression
      ) {
        continue;
      }
      const base = target.expression;
      const name = propertyName(target);
      const key = base === undefined ? undefined : receiverKey(base);
      if (name === undefined || key === undefined) continue;
      // EVERY write, not just the last: `o.run = eval; o.run(payload);
      // o.run = safe` runs the sink before it is overwritten, and keeping one
      // source occurrence per slot lost exactly that.  The relation asks what a
      // slot CAN hold, which is all of them.
      const slot = `${key} ${name}`;
      written.set(slot, [...(written.get(slot) ?? []), value]);
    }
  };

  /** Whether an expression IS the global object, directly or through a name. */
  const isGlobalReceiver = (node: Syntax | undefined, hop = 0): boolean => {
    const target = unwrap(node);
    if (target === undefined || hop > MAX_HOPS) return false;
    if (target.kind !== SyntaxKind.Identifier) return false;
    if (isGlobalBinding(target)) return GLOBAL_RECEIVERS.has(nameOf(target));
    const declaration = localDeclaration(target);
    if (declaration?.kind !== SyntaxKind.VariableDeclaration) return false;
    return isGlobalReceiver(declaration.initializer, hop + 1);
  };

  /**
   * The key a binding element takes from its source — a NAME in an object
   * pattern, a POSITION in an array one.
   *
   * A COMPUTED key is resolved exactly as `o[key]` is, because it selects
   * exactly the same property: `const { ['eval']: run } = globalThis` and
   * `const { eval: run } = globalThis` bind the same value.  Reading the
   * computed form's text instead gave the key `['eval']` — a property no object
   * has — so the binding resolved to nothing and `run(payload)` reached no
   * sink, in a file that mentions the global only inside a string.
   */
  const bindingKey = (element: Syntax, pattern: Syntax): string | undefined => {
    if (pattern.kind === SyntaxKind.ArrayBindingPattern) {
      const at = childrenOf(pattern).findIndex((each) => each.getStart() === element.getStart());
      return at < 0 ? undefined : String(at);
    }
    const named = (element.propertyName ?? element.name) as Syntax | undefined;
    if (named === undefined) return undefined;
    if (named.kind === SyntaxKind.ComputedPropertyName) {
      return staticKeyOf(named.expression, project);
    }
    return nameOf(named);
  };

  /**
   * The expression a local name was bound TO.
   *
   * A declaration binds either from an initializer or from a destructuring
   * source, and both are the same act — so a container reached through
   * `const { list } = { list: [eval] }` resolves like one reached through
   * `const o = { list: [eval] }`.
   */
  const boundValue = (declaration: Syntax | undefined, hop: number): Syntax | undefined => {
    if (declaration === undefined || hop > MAX_HOPS) return undefined;
    if (declaration.kind === SyntaxKind.BindingElement) {
      const pattern = declaration.parent;
      const from = pattern?.parent?.initializer;
      const key = pattern === undefined ? undefined : bindingKey(declaration, pattern);
      if (from === undefined || key === undefined) return undefined;
      return heldAt(from, key, hop + 1);
    }
    return declaration.initializer;
  };

  /**
   * What a declaration binds, as a VALUE.
   *
   * A destructure from the global object names a GLOBAL rather than pointing at
   * an expression — `const { eval: e } = globalThis` binds `e` to the global
   * `eval`, which has no node in this file — so the binding edge has to be able
   * to yield either.  Returning only a node silently dropped that whole family.
   */
  const boundValues = (declaration: Syntax | undefined): Value[] => {
    if (declaration === undefined) return [];
    // A `function get() {}` / `class C {}` declaration IS the value its name
    // holds — there is no initializer to read.  The old return-walker knew this
    // privately, which is precisely why it had to exist; stated here, every
    // consumer of the relation gets it at once.
    if (isFunction(declaration) || declaration.kind === SyntaxKind.ClassDeclaration) {
      return [nodeValue(declaration)];
    }
    if (declaration.kind === SyntaxKind.BindingElement) {
      const pattern = declaration.parent;
      const from = pattern?.parent?.initializer;
      const key = pattern === undefined ? undefined : bindingKey(declaration, pattern);
      if (from === undefined || key === undefined) return [];
      if (isGlobalReceiver(from)) return [globalValue(key)];
      const held = heldAt(from, key, 0);
      return held === undefined ? [] : [nodeValue(held)];
    }
    return declaration.initializer === undefined ? [] : [nodeValue(declaration.initializer)];
  };

  /**
   * The container LITERAL an expression denotes, however it is reached.
   *
   * A container holds containers — `const h = [[eval]]` and `const o = { list:
   * [eval] }` are as ordinary as the one-level forms — so this recurses rather
   * than reading one level and stopping, which is the caveat that becomes the
   * next bypass.
   */
  const containerCache = new Map<string, Syntax | undefined>();
  const containerOf = (node: Syntax | undefined, hop: number): Syntax | undefined => {
    const target = unwrap(node);
    if (target === undefined || hop > MAX_HOPS) return undefined;
    // Memoised: `heldValues`, `members` and the fluent-target resolution all
    // ask this, and the relation asks them per property access.
    const key = `${target.getStart()}:${target.getEnd()}`;
    if (containerCache.has(key)) return containerCache.get(key);
    containerCache.set(key, undefined); // cycle guard while this one resolves
    const found = containerFrom(target, hop);
    containerCache.set(key, found);
    return found;
  };

  const containerFrom = (target: Syntax, hop: number): Syntax | undefined => {
    if (
      target.kind === SyntaxKind.ObjectLiteralExpression ||
      target.kind === SyntaxKind.ArrayLiteralExpression
    ) {
      return target;
    }
    if (target.kind === SyntaxKind.Identifier) {
      const declaration = localDeclaration(target);
      // A class NAME denotes the class; `new C()` denotes an instance of it.
      // Either way its members are what a property read finds.
      if (
        declaration?.kind === SyntaxKind.ClassDeclaration ||
        declaration?.kind === SyntaxKind.ClassExpression
      ) {
        return declaration;
      }
      return containerOf(boundValue(declaration, hop), hop + 1);
    }
    if (target.kind === SyntaxKind.NewExpression) {
      return containerOf(target.expression, hop + 1);
    }
    // `Object.create(proto)` returns an object that INHERITS from `proto`, so
    // a property read on it finds what the prototype holds — the one container
    // here reached across a prototype boundary rather than by ownership.
    if (target.kind === SyntaxKind.CallExpression) {
      for (const callee of accessesBehind(target.expression)) {
        if (propertyName(callee) !== 'create') continue;
        if (!isGlobalNamed(callee.expression, 'Object')) continue;
        return containerOf(argumentsOf(target)[0], hop + 1);
      }
    }
    // A reflective setter RETURNS its target, so the fluent form denotes the
    // same container the write landed in.
    if (target.kind === SyntaxKind.CallExpression && reflectiveWrites(target).length > 0) {
      return containerOf(argumentsOf(target)[0], hop + 1);
    }
    if (
      target.kind === SyntaxKind.PropertyAccessExpression ||
      target.kind === SyntaxKind.ElementAccessExpression
    ) {
      const name = propertyName(target);
      const base = target.expression;
      if (name === undefined || base === undefined) return undefined;
      return containerOf(heldAt(base, name, hop + 1), hop + 1);
    }
    return undefined;
  };

  /** What a container holds at `name` — from a later write, or from its literal. */
  const heldAt = (base: Syntax, name: string, hop: number): Syntax | undefined =>
    heldValues(base, name, hop)[0];

  /** EVERY value a slot can hold — writes first, then what the literal says. */
  const heldValues = (base: Syntax, name: string, hop: number): Syntax[] => {
    const key = receiverKey(base);
    const assigned = key === undefined ? [] : (written.get(`${key} ${name}`) ?? []);
    if (assigned.length > 0) return assigned;
    if (hop > MAX_HOPS) return [];
    // The write may have been keyed to the CONTAINER rather than to the
    // expression naming it: `Object.assign({}, { run: eval }).run(p)` records
    // against the anonymous literal, and the read arrives through the call
    // that returned it.
    const literal = containerOf(base, hop);
    const holderKey = literal === undefined ? undefined : receiverKey(literal);
    if (holderKey !== undefined && holderKey !== key) {
      const viaHolder = written.get(`${holderKey} ${name}`) ?? [];
      if (viaHolder.length > 0) return viaHolder;
    }
    // `Proxy.revocable(target, handler)` hands back `{ proxy, revoke }`, and
    // its `proxy` IS the target — the only container in this file that is
    // built by a call rather than written as a literal, so nothing else could
    // reach it.
    if (name === 'proxy') {
      const call = unwrap(base);
      if (call?.kind === SyntaxKind.CallExpression) {
        for (const callee of accessesBehind(call.expression)) {
          if (!isGlobalNamed(callee.expression, 'Proxy')) continue;
          if (propertyName(callee) !== 'revocable') continue;
          const wrapped = argumentsOf(call)[0];
          if (wrapped !== undefined) return [wrapped];
        }
      }
    }
    // `const o = { run: eval }`, `const h = [eval]`, and the nested forms —
    // reached through the binding rather than through a table beside the scan.
    if (literal === undefined) return [];
    if (literal.kind === SyntaxKind.ObjectLiteralExpression) {
      for (const member of childrenOf(literal)) {
        if (member.name === undefined) continue;
        // `{ ['run']: eval }` names the same property as `{ run: eval }`.
        const memberName =
          member.name.kind === SyntaxKind.ComputedPropertyName
            ? staticPrefix(member.name.expression)
            : nameOf(member.name);
        if (memberName !== name) continue;
        // A getter has no initializer; the MEMBER is the value, and the
        // relation reads its returns.  A method likewise IS the function.
        if (
          member.kind === SyntaxKind.GetAccessor ||
          member.kind === SyntaxKind.MethodDeclaration
        ) {
          return [member];
        }
        const held =
          member.kind === SyntaxKind.ShorthandPropertyAssignment ? member.name : member.initializer;
        return held === undefined ? [] : [held];
      }
      return [];
    }
    if (literal.kind === SyntaxKind.ArrayLiteralExpression) {
      const index = Number(name);
      const at = Number.isInteger(index) ? childrenOf(literal)[index] : undefined;
      return at === undefined ? [] : [at];
    }
    if (
      literal.kind === SyntaxKind.ClassDeclaration ||
      literal.kind === SyntaxKind.ClassExpression
    ) {
      // A method IS the function it declares; a property carries its
      // initializer; a getter is read through the relation as its returns.
      for (const member of childrenOf(literal)) {
        if (member.name === undefined || nameOf(member.name) !== name) continue;
        if (
          member.kind === SyntaxKind.MethodDeclaration ||
          member.kind === SyntaxKind.GetAccessor
        ) {
          return [member];
        }
        if (member.kind === SyntaxKind.PropertyDeclaration) {
          return member.initializer === undefined ? [] : [member.initializer];
        }
      }
      return [];
    }
    return [];
  };

  /**
   * The expression a `Reflect.apply` / `Reflect.construct` call INVOKES.
   *
   * Read through `propertyName`, so `Reflect['apply']` is the same call as the
   * dotted spelling rather than a second case.
   */
  /**
   * `Function.prototype.call.call(eval, …)` — a BORROWED invoker.
   *
   * `f.call(thisArg, …)` invokes `f`; when `f` IS `Function.prototype.call` (or
   * `.apply`), invoking it with `this = args[0]` invokes THAT.  Following the
   * immediate base stopped at the borrowed method and never saw the callable
   * handed to it.
   */
  const borrowedTarget = (call: Syntax): Syntax | undefined => {
    const callee = unwrap(call.expression);
    if (
      callee?.kind !== SyntaxKind.PropertyAccessExpression &&
      callee?.kind !== SyntaxKind.ElementAccessExpression
    ) {
      return undefined;
    }
    if (!INVOKERS.has(propertyName(callee) ?? '')) return undefined;
    for (const inner of accessesBehind(callee.expression)) {
      if (!INVOKERS.has(propertyName(inner) ?? '')) continue;
      // The receiver of the borrowed method is `Function.prototype`.
      const owner = unwrap(inner.expression);
      if (owner === undefined) continue;
      const onPrototype =
        (owner.kind === SyntaxKind.PropertyAccessExpression ||
          owner.kind === SyntaxKind.ElementAccessExpression) &&
        propertyName(owner) === 'prototype' &&
        isGlobalNamed(owner.expression, 'Function');
      if (!onPrototype) continue;
      return argumentsOf(call)[0];
    }
    return undefined;
  };

  const reflectTarget = (call: Syntax): Syntax | undefined => {
    const borrowed = borrowedTarget(call);
    if (borrowed !== undefined) return borrowed;
    for (const callee of accessesBehind(call.expression)) {
      if (!isGlobalNamed(callee.expression, 'Reflect')) continue;
      const method = propertyName(callee);
      if (method === undefined || !REFLECT_INVOKERS.has(method)) continue;
      return argumentsOf(call)[0];
    }
    return undefined;
  };

  /**
   * The property ACCESSES an expression can denote.
   *
   * `Reflect.construct` and `Object.assign` are values like any other, so
   * copying one into a local, passing it to a wrapper, or returning it from a
   * function all reach the same helper — and matching the ACCESS SYNTAX at the
   * call saw only the spelled form.
   *
   * This asks the RELATION, which is the whole point: a private walk here
   * covered bindings and nothing else, which is the same defect the value
   * relation was introduced to end, reintroduced one helper down.  The relation
   * asks about every call, so it would re-enter this function — hence the
   * in-progress guard rather than a weaker resolver.
   */
  const accessCache = new Map<string, Syntax[]>();
  const accessesBehind = (node: Syntax | undefined, hop = 0): Syntax[] => {
    const target = unwrap(node);
    if (target === undefined || hop > MAX_HOPS) return [];
    const key = `${target.getStart()}:${target.getEnd()}`;
    const cached = accessCache.get(key);
    if (cached !== undefined) return cached;
    const found: Syntax[] = [];
    accessCache.set(key, found); // cycle guard: a chain returning here sees it empty
    const add = (from: Syntax | undefined): void => {
      for (const each of accessesBehind(from, hop + 1)) found.push(each);
    };
    if (
      target.kind === SyntaxKind.PropertyAccessExpression ||
      target.kind === SyntaxKind.ElementAccessExpression
    ) {
      found.push(target);
      // …and whatever the slot HOLDS, which may itself be a helper:
      // `const o = { a: Object.assign }; o.a(node, { innerHTML: p })`.
      const name = propertyName(target);
      const base = target.expression;
      if (name !== undefined && base !== undefined) {
        for (const held of heldValues(base, name, hop + 1)) add(held);
      }
      return found;
    }
    if (target.kind === SyntaxKind.ConditionalExpression) {
      add(target.whenTrue);
      add(target.whenFalse);
      return found;
    }
    if (
      target.kind === SyntaxKind.BinaryExpression &&
      SELECTORS.has(target.operatorToken?.kind ?? -1)
    ) {
      add(target.left);
      add(target.right);
      return found;
    }
    // A CALL yields what the function it names returns.
    if (target.kind === SyntaxKind.CallExpression) {
      for (const fn of accessCallees(target, hop)) {
        for (const returned of returnsOf(fn)) add(returned);
      }
      return found;
    }
    if (target.kind !== SyntaxKind.Identifier || isGlobalBinding(target)) return found;
    const receiver = receiverKey(target);
    for (const assigned of receiver === undefined ? [] : (rebound.get(receiver) ?? []))
      add(assigned);
    const declaration = localDeclaration(target);
    if (declaration === undefined) return found;
    if (IMPORT_BINDINGS.has(declaration.kind)) {
      for (const value of aliasedValues(target)) {
        if (value.kind === 'node') add(value.node);
      }
      return found;
    }
    // A PARAMETER is bound by its call sites.
    if (declaration.kind === SyntaxKind.Parameter) {
      for (const supplied of argumentsAt(declaration)) add(supplied);
      add(declaration.initializer);
      return found;
    }
    add(declaration.initializer);
    return found;
  };

  /** The FUNCTIONS a callee expression can be, for the return hop above. */
  const accessCallees = (call: Syntax, hop: number): Syntax[] => {
    const callee = unwrap(call.expression);
    if (callee === undefined || hop > MAX_HOPS) return [];
    if (isFunction(callee)) return [callee];
    if (callee.kind !== SyntaxKind.Identifier || isGlobalBinding(callee)) return [];
    const declaration = localDeclaration(callee);
    if (declaration === undefined) return [];
    if (isFunction(declaration)) return [declaration];
    const bound = unwrap(declaration.initializer);
    return bound !== undefined && isFunction(bound) ? [bound] : [];
  };

  /**
   * Whether an expression IS the named global, however it was reached.
   *
   * `Reflect`, `Object` and `Proxy` are values too — `const P = Proxy; new
   * P(eval, {})` constructs the same proxy — so comparing the identifier's TEXT
   * left every receiver aliasable even after the helpers themselves were
   * resolved.  Guarded like the other resolutions here, because the relation
   * asks this question while answering one.
   */
  const isGlobalNamed = (node: Syntax | undefined, name: string): boolean =>
    globalsBehind(node).has(name);

  /**
   * The GLOBALS an expression can denote, following binding chains.
   *
   * A narrower question than "what values can this be", and deliberately
   * answered by its own memoised walk rather than by the general relation.
   * This is called from INSIDE `flowsInto` — for every call, to ask whether the
   * receiver is `Reflect`, `Object` or `Proxy` — so routing it through the full
   * search made the step function depend on the search's own closure, and a
   * repository scan went from 25 seconds to over ten minutes.
   *
   * It follows exactly what can rename a global: a binding, a reassignment, an
   * import, a selection between two of them, and the transparent wrappers.
   * That is what `const P = Proxy; new P(eval, {})` needs, and it stays linear.
   */
  const globalsCache = new Map<string, Set<string>>();
  const globalsBehind = (node: Syntax | undefined, hop = 0): Set<string> => {
    const target = unwrap(node);
    if (target === undefined || hop > MAX_HOPS) return new Set();
    const key = `${target.getStart()}:${target.getEnd()}`;
    const cached = globalsCache.get(key);
    if (cached !== undefined) return cached;
    const found = new Set<string>();
    globalsCache.set(key, found); // cycle guard: a chain that returns here sees it empty
    if (target.kind === SyntaxKind.Identifier) {
      if (isGlobalBinding(target)) {
        found.add(nameOf(target));
        return found;
      }
      const receiver = receiverKey(target);
      for (const assigned of receiver === undefined ? [] : (rebound.get(receiver) ?? [])) {
        for (const each of globalsBehind(assigned, hop + 1)) found.add(each);
      }
      const declaration = localDeclaration(target);
      if (declaration !== undefined && IMPORT_BINDINGS.has(declaration.kind)) {
        for (const value of aliasedValues(target)) {
          if (value.kind === 'global') found.add(value.name);
          else if (value.kind === 'node') {
            for (const each of globalsBehind(value.node, hop + 1)) found.add(each);
          }
        }
        return found;
      }
      for (const each of globalsBehind(declaration?.initializer, hop + 1)) found.add(each);
      return found;
    }
    if (target.kind === SyntaxKind.ConditionalExpression) {
      for (const side of [target.whenTrue, target.whenFalse]) {
        for (const each of globalsBehind(side, hop + 1)) found.add(each);
      }
      return found;
    }
    if (
      target.kind === SyntaxKind.BinaryExpression &&
      SELECTORS.has(target.operatorToken?.kind ?? -1)
    ) {
      for (const side of [target.left, target.right]) {
        for (const each of globalsBehind(side, hop + 1)) found.add(each);
      }
    }
    return found;
  };

  /** What an imported name is bound to, followed through the module edge. */
  const aliasedValues = (name: Syntax): Value[] => {
    const symbol = symbolAt(name);
    if (symbol === undefined) return [];
    let aliased: ReturnType<typeof project.checker.getAliasedSymbol>;
    try {
      aliased = project.checker.getAliasedSymbol(symbol);
    } catch {
      return [];
    }
    const handle = aliased?.declarations.find((each) => inBatch(each.path));
    const declaration = handle?.resolve(project) as Syntax | undefined;
    if (declaration === undefined) return [];
    // The ORIGINAL declaration is read exactly as a local one would be, so a
    // re-export chain and a plain import take the same path from here.
    return boundValues(declaration);
  };

  /** Whether a node is something that can be CALLED and has a body to read. */
  const isFunction = (node: Syntax | undefined): boolean =>
    node?.kind === SyntaxKind.ArrowFunction ||
    node?.kind === SyntaxKind.FunctionExpression ||
    node?.kind === SyntaxKind.FunctionDeclaration ||
    node?.kind === SyntaxKind.MethodDeclaration;

  /**
   * ARGUMENTS that reach each parameter, keyed by the parameter's range.
   *
   * A parameter is a binding like any other, and passing a sink to a wrapper —
   * `function invoke(fn) { fn(payload) } invoke(eval)` — is how one is written
   * through in practice.  Without this edge the relation stopped dead at every
   * parameter, so any indirection through a local helper was a bypass.
   */
  const argumentsForParameter = new Map<string, Syntax[]>();
  /**
   * Whether the call-site map is being built, which is what makes this
   * terminate.
   *
   * Building the map needs to know which function each call reaches, and that
   * is the relation itself — so parameter edges yield nothing WHILE the map is
   * being built and everything afterwards.  The one thing this cannot see is a
   * callee that is itself a parameter (a wrapper invoked through a wrapper);
   * the arguments of such a call are still followed, only the dispatch is not.
   */
  let buildingCallSites = false;
  let callSitesReady = false;

  const parameterKey = (parameter: Syntax): string =>
    `${parameter.getStart()}:${parameter.getEnd()}`;

  /**
   * The arguments a call actually passes to the FUNCTION, whatever invoked it.
   *
   * `f(a)`, `f.call(this, a)`, `f.apply(this, [a])` and `Reflect.apply(f, this,
   * [a])` all deliver `a` as the first parameter, and the receiver resolution
   * already treats them as calls of `f` — so reading the raw argument list
   * lined a wrapper's parameters up against a `thisArg`, and the sink one place
   * along went unseen.
   */
  const callArguments = (call: Syntax): Syntax[] => {
    const unwrapArray = (node: Syntax | undefined): Syntax[] => {
      const holder = unwrap(node);
      return holder?.kind === SyntaxKind.ArrayLiteralExpression ? childrenOf(holder) : [];
    };
    // A TAG is called with the strings object first and each SUBSTITUTION
    // after it, so `` invoke`x${eval}y` `` puts the sink in parameter 1.  The
    // ordinary argument list is empty for a tagged template, which left every
    // substitution disconnected from the parameter it binds.
    if (call.kind === SyntaxKind.TaggedTemplateExpression) {
      const template = childrenOf(call)[1];
      if (template === undefined) return [];
      const substitutions: Syntax[] = [];
      for (const span of childrenOf(template)) {
        if (span.kind !== SyntaxKind.TemplateSpan) continue;
        const value = childrenOf(span)[0];
        if (value !== undefined) substitutions.push(value);
      }
      // Index 0 stands for the strings object; the template node is a harmless
      // placeholder that resolves to no sink.
      return [template, ...substitutions];
    }
    const args = argumentsOf(call);
    if (reflectTarget(call) !== undefined) {
      const method = propertyName(unwrap(call.expression) as Syntax) ?? '';
      // `construct` takes its array one earlier than `apply` does.
      return unwrapArray(args[method === 'construct' ? 1 : 2]);
    }
    const callee = unwrap(call.expression);
    if (
      callee?.kind === SyntaxKind.PropertyAccessExpression ||
      callee?.kind === SyntaxKind.ElementAccessExpression
    ) {
      const method = propertyName(callee);
      if (method === 'apply') return unwrapArray(args[1]);
      if (method === 'call' || method === 'bind') return args.slice(1);
    }
    return args;
  };

  const buildCallSites = (): void => {
    if (callSitesReady || buildingCallSites) return;
    buildingCallSites = true;
    for (const node of walk(root)) {
      if (
        node.kind !== SyntaxKind.CallExpression &&
        node.kind !== SyntaxKind.NewExpression &&
        node.kind !== SyntaxKind.TaggedTemplateExpression
      ) {
        continue;
      }
      // `arr.forEach(fn => …)` hands each ELEMENT to the callback, so its
      // first parameter is bound by the receiver rather than by an argument at
      // the same index.  Without this a sink stored in a collection reached the
      // callback untracked.
      const iterated = iterationSource(node);
      if (iterated !== undefined) {
        const callback = unwrap(argumentsOf(node)[0]);
        if (callback !== undefined && isFunction(callback)) {
          const parameter = childrenOf(callback).find(
            (child) => child.kind === SyntaxKind.Parameter,
          );
          if (parameter !== undefined) {
            const key = parameterKey(parameter);
            for (const element of elementsOf(iterated)) {
              argumentsForParameter.set(key, [...(argumentsForParameter.get(key) ?? []), element]);
            }
          }
        }
      }
      const args = callArguments(node);
      if (args.length === 0) continue;
      // WHERE the called function is written differs by spelling: a tagged
      // template puts it in the tag, and `Reflect.apply` in its first argument
      // rather than in the callee.  The relation already resolves all three;
      // reading only `expression` here left the reflective form unmapped.
      const invokedFn =
        node.kind === SyntaxKind.TaggedTemplateExpression
          ? node.tag
          : (reflectTarget(node) ?? node.expression);
      for (const callee of nodesFrom(invokedFn)) {
        if (!isFunction(callee)) continue;
        childrenOf(callee)
          .filter((child) => child.kind === SyntaxKind.Parameter)
          .forEach((parameter, index) => {
            const supplied = args[index];
            if (supplied === undefined) return;
            const key = parameterKey(parameter);
            argumentsForParameter.set(key, [...(argumentsForParameter.get(key) ?? []), supplied]);
          });
      }
    }
    buildingCallSites = false;
    callSitesReady = true;
  };

  /**
   * Methods that hand each ELEMENT of their receiver to a callback.
   *
   * A closed set of platform APIs, named for the same reason the reflective
   * setters are: no parse answers "does this iterate", and the list does not
   * grow with the language the way a spelling list would.
   */
  const ITERATORS: ReadonlySet<string> = new Set([
    'forEach',
    'map',
    'filter',
    'find',
    'findLast',
    'some',
    'every',
    'flatMap',
  ]);

  /** The collection an iteration call walks, when it is one. */
  const iterationSource = (call: Syntax): Syntax | undefined => {
    const callee = unwrap(call.expression);
    if (
      callee?.kind !== SyntaxKind.PropertyAccessExpression &&
      callee?.kind !== SyntaxKind.ElementAccessExpression
    ) {
      return undefined;
    }
    if (!ITERATORS.has(propertyName(callee) ?? '')) return undefined;
    return callee.expression;
  };

  /** The elements an array-valued expression holds. */
  const elementsOf = (node: Syntax): Syntax[] => {
    const literal = containerOf(node, 0);
    return literal?.kind === SyntaxKind.ArrayLiteralExpression ? childrenOf(literal) : [];
  };

  /** The arguments that can arrive at a parameter, across every call site. */
  const argumentsAt = (parameter: Syntax): Syntax[] => {
    if (buildingCallSites) return [];
    buildCallSites();
    return argumentsForParameter.get(parameterKey(parameter)) ?? [];
  };

  /**
   * The expressions a function BODY hands back.
   *
   * Both body forms count: an arrow's expression body, and every `return` in a
   * block.  Nested functions are excluded — their returns belong to them, not
   * to the function being called.
   */
  const returnsOf = (fn: Syntax): Syntax[] => {
    const body = fn.body;
    if (body === undefined) return [];
    if (body.kind !== SyntaxKind.Block) return [body];
    const returned: Syntax[] = [];
    // Explicit recursion rather than a flat walk, because a nested function's
    // `return` has to be PRUNED, not skipped: it belongs to that function, and
    // `f()` does not yield what the arrow inside `f` returns.  Nothing is lost
    // by the precision — `f()()` reaches it as a `result` of a `result`.
    const visit = (node: Syntax): void => {
      if (isFunction(node)) return;
      // A GENERATOR hands values out by yielding, so a yield is a return for
      // this purpose: `function* g() { yield eval }` gives the global to
      // whoever reads the iterator.
      if (node.kind === SyntaxKind.ReturnStatement || node.kind === SyntaxKind.YieldExpression) {
        if (node.expression !== undefined) returned.push(node.expression);
        if (node.kind === SyntaxKind.YieldExpression) return;
        return;
      }
      for (const child of childrenOf(node)) visit(child);
    };
    for (const child of childrenOf(body)) visit(child);
    return returned;
  };

  /**
   * ONE STEP of value flow: everything that can supply this value.
   *
   * This is the whole model, and it is one relation on purpose.  It replaced
   * three overlapping walkers — one for selection and bindings, one for sink
   * names, one for containers — which is why every review round found another
   * mechanism modelled in one of them and missing from the others: a `||` the
   * name walker knew and the string test did not, a function RETURN the sink
   * walker knew and the value walker did not, a container alias the write side
   * knew and the read side did not.  Enumerating dataflow mechanisms three
   * times over is the same mistake as enumerating spellings, one level up.
   *
   * An EDGE means "this value IS that value".  Construction is deliberately not
   * an edge: `a + b` and a template make a NEW value out of their parts, so the
   * predicates that care about strings read those shapes structurally instead.
   */
  const flowsInto = (value: Value): Value[] => {
    // A global and a member are IDENTITIES, not expressions: nothing flows into
    // them, they are where a resolution ends.
    if (value.kind === 'global' || value.kind === 'member') return [];

    // Calling a value: read a function's returns, or push the call INWARDS
    // through the callee's own flow until one is found.  Distributing like this
    // is what makes every callee spelling work at once — an alias, a property,
    // a parameter, a `||` between two functions — without any of them being
    // named here.
    if (value.kind === 'result') {
      const of = value.of;
      if (of.kind === 'node' && isFunction(of.node)) return returnsOf(of.node).map(nodeValue);
      return flowsInto(of).map(resultValue);
    }

    const target = value.node;

    // Wrappers that yield exactly what they wrap.
    if (TRANSPARENT.has(target.kind) || target.kind === SyntaxKind.AwaitExpression) {
      return target.expression === undefined ? [] : [nodeValue(target.expression)];
    }

    if (target.kind === SyntaxKind.BinaryExpression) {
      const operator = target.operatorToken?.kind ?? -1;
      // `(0, eval)` yields its right operand; `||`/`&&`/`??` yield either.
      if (operator === SyntaxKind.CommaToken) {
        return target.right === undefined ? [] : [nodeValue(target.right)];
      }
      if (SELECTORS.has(operator)) {
        return [target.left, target.right]
          .filter((side): side is Syntax => side !== undefined)
          .map(nodeValue);
      }
      return [];
    }

    if (target.kind === SyntaxKind.ConditionalExpression) {
      return [target.whenTrue, target.whenFalse]
        .filter((side): side is Syntax => side !== undefined)
        .map(nodeValue);
    }

    if (target.kind === SyntaxKind.Identifier) {
      if (isGlobalBinding(target)) return [globalValue(nameOf(target))];
      const from: Value[] = [];
      // A later assignment reaches a name just as its initializer does.
      const key = receiverKey(target);
      for (const assigned of key === undefined ? [] : (rebound.get(key) ?? [])) {
        from.push(nodeValue(assigned));
      }
      const declaration = localDeclaration(target);
      // An IMPORT binds to a declaration in ANOTHER module, and the checker is
      // what crosses that edge: the specifier itself holds nothing, so a chain
      // that stopped there read `import { run } from './a.js'; run(payload)` as
      // an unresolvable name — which is how a sink aliased in one file and
      // invoked from another showed no finding in either.
      if (declaration !== undefined && IMPORT_BINDINGS.has(declaration.kind)) {
        from.push(...aliasedValues(target));
        return from;
      }
      // A PARAMETER is bound by its call sites rather than by an initializer.
      if (declaration?.kind === SyntaxKind.Parameter) {
        from.push(...argumentsAt(declaration).map(nodeValue));
        const fallback = declaration.initializer;
        if (fallback !== undefined) from.push(nodeValue(fallback));
        return from;
      }
      from.push(...boundValues(declaration));
      return from;
    }

    if (
      target.kind === SyntaxKind.PropertyAccessExpression ||
      target.kind === SyntaxKind.ElementAccessExpression
    ) {
      const name = propertyName(target);
      const base = target.expression;
      if (name === undefined || base === undefined) return [];
      const from: Value[] = [];
      // What was WRITTEN into this slot, and what its literal holds — ALL of
      // them, since the question is what the slot can hold rather than what it
      // holds last.
      for (const held of heldValues(base, name, 0)) from.push(nodeValue(held));
      if (isGlobalReceiver(base)) from.push(globalValue(name));
      // `F.call(…)` still runs `F`; an invoked `.constructor` is `Function`.
      if (INVOKERS.has(name)) from.push(nodeValue(base));
      if (name === 'constructor') from.push(globalValue('Function'));
      // `it.value` carries what the iterator produced, so it is transparent to
      // its source — the other half of the generator boundary, with `.next()`
      // below.
      if (name === 'value') from.push(nodeValue(base));
      // The access ALSO denotes the method itself, whoever the receiver turns
      // out to be — which is what survives being copied into a local.  Emitted
      // alongside the rest rather than instead of it, and harmless when the
      // property is nobody's sink: only a spec naming this property and
      // resolving to this receiver ever reads it.
      from.push(memberValue(target, name));
      return from;
    }

    if (target.kind === SyntaxKind.CallExpression || target.kind === SyntaxKind.NewExpression) {
      // `Reflect.apply(F, …)` invokes its first argument; any other call yields
      // whatever the function it names RETURNS.
      const invoked = reflectTarget(target);
      if (invoked !== undefined) return [nodeValue(invoked)];
      // `Object.assign(o, …)` and `Object.defineProperty(o, …)` RETURN their
      // target, so the fluent form `Object.assign({}, { run: eval }).run(p)`
      // reads the slot off the call itself.  The generic result edge follows a
      // function's declared returns and these are the platform's, not ours.
      if (reflectiveWrites(target).length > 0) {
        const written = argumentsOf(target)[0];
        if (written !== undefined) return [nodeValue(written)];
      }
      const callee = unwrap(target.expression);
      // `m.get('run')` reads the slot `m.set('run', …)` filled.
      if (
        (callee?.kind === SyntaxKind.PropertyAccessExpression ||
          callee?.kind === SyntaxKind.ElementAccessExpression) &&
        propertyName(callee) === 'get' &&
        callee.expression !== undefined
      ) {
        const key = argumentsOf(target)[0];
        const named = key === undefined ? null : staticPrefix(key);
        if (named !== null) {
          const held = heldValues(callee.expression, named, 0);
          if (held.length > 0) return held.map(nodeValue);
        }
      }
      // `it.next()` yields the iterator's own values, so the call is
      // transparent to the thing being iterated.
      if (
        (callee?.kind === SyntaxKind.PropertyAccessExpression ||
          callee?.kind === SyntaxKind.ElementAccessExpression) &&
        propertyName(callee) === 'next' &&
        callee.expression !== undefined
      ) {
        return [nodeValue(callee.expression)];
      }
      // `new Proxy(eval, {})` IS `eval` for every purpose that matters here: a
      // call on the proxy runs the target unless a handler trap says otherwise,
      // and a wrapper is the cheapest way to launder a forbidden global.
      if (isGlobalNamed(target.expression, 'Proxy')) {
        const wrapped = argumentsOf(target)[0];
        return wrapped === undefined ? [] : [nodeValue(wrapped)];
      }
      return target.expression === undefined ? [] : [resultValue(nodeValue(target.expression))];
    }

    // A CLASS is its superclass, for the purpose of what constructing it runs.
    // `class F extends Function {}` inherits `Function`'s constructor, so
    // `new F('return payload')()` compiles and runs code exactly as the global
    // does — the subclass changes the spelling, not the sink.
    if (target.kind === SyntaxKind.ClassDeclaration || target.kind === SyntaxKind.ClassExpression) {
      const extended: Value[] = [];
      for (const child of childrenOf(target)) {
        if (child.kind !== SyntaxKind.HeritageClause) continue;
        if (child.token !== SyntaxKind.ExtendsKeyword) continue;
        for (const base of childrenOf(child)) {
          const from =
            base.kind === SyntaxKind.ExpressionWithTypeArguments ? base.expression : base;
          if (from !== undefined) extended.push(nodeValue(from));
        }
      }
      return extended;
    }

    // `` tag`text` `` INVOKES its tag, so its value is what the tag returns —
    // the same edge a call has, and the tag is where the callee sits.
    if (target.kind === SyntaxKind.TaggedTemplateExpression) {
      return target.tag === undefined ? [] : [resultValue(nodeValue(target.tag))];
    }

    // A GETTER runs on READ, so `o.run` already IS what the accessor returns —
    // no call needed.  Reached here because `heldAt` hands back the accessor
    // itself when a container member is one.
    if (target.kind === SyntaxKind.GetAccessor) return returnsOf(target).map(nodeValue);

    return [];
  };

  /**
   * Every value an expression can hold, following the relation to exhaustion.
   *
   * One search serves every question asked of an expression — which globals it
   * can be, whether it can be a string, what URL prefix it can carry — so those
   * answers cannot drift apart the way three separate walkers did.
   */
  /**
   * `flowsInto`, memoised on the value's identity.
   *
   * The relation is a pure function of the tree, and the same values are asked
   * about constantly — every call site resolves its callee, and callees repeat.
   * Recomputing meant re-entering the checker for each one, which is the cost
   * that matters: symbol resolution, not the walk.
   */
  const stepCache = new Map<string, Value[]>();
  const stepsFrom = (value: Value, key: string): Value[] => {
    const cached = stepCache.get(key);
    if (cached !== undefined) return cached;
    const step = flowsInto(value);
    // While the call-site map is being built, parameter edges are empty BY
    // CONSTRUCTION rather than by fact, so those answers must not be kept.
    if (!buildingCallSites) stepCache.set(key, step);
    return step;
  };

  /**
   * `reaches`, memoised on the starting expression.
   *
   * `flowsInto` was already cached, but the SEARCH was not, so every question
   * asked of an expression re-walked its whole graph.  That was affordable
   * while the callers were few; once receiver identity became a resolved
   * question too — asked from inside the relation, for every call — the same
   * subgraphs were re-explored combinatorially and a repository scan went from
   * 25 seconds to over ten minutes.
   */
  const reachCache = new Map<string, Value[]>();

  const reaches = (node: Syntax | undefined): Value[] => {
    if (node === undefined) return [];
    const from = `${node.getStart()}:${node.getEnd()}`;
    const cached = reachCache.get(from);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const found: Value[] = [];
    const queue: Value[] = [nodeValue(node)];
    while (queue.length > 0) {
      const value = queue.shift() as Value;
      const key = valueKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      // The search runs to EXHAUSTION.  Every key is a node range or a global
      // name, so the space is finite and repetition ends each branch; stopping
      // early on a count was a bypass, because the padding that reaches the
      // ceiling is exactly what an attacker controls.
      if (found.length >= MAX_VALUES) {
        throw new Error(
          `sink analysis did not converge in ${filePath} after ${MAX_VALUES} values — ` +
            'refusing to report this file clean',
        );
      }
      found.push(value);
      queue.push(...stepsFrom(value, key));
    }
    // A search made WHILE the call-site map is being built is deliberately
    // partial — parameter edges are empty by construction there — so it must
    // not be kept as the answer for that expression.
    if (!buildingCallSites) reachCache.set(from, found);
    return found;
  };

  /** The GLOBAL NAMES an expression can hold — what a sink spec matches. */
  const sinkNames = (node: Syntax | undefined): string[] =>
    reaches(node).flatMap((value) => (value.kind === 'global' ? [value.name] : []));

  /** The EXPRESSIONS an expression can hold — what the value predicates read. */
  const nodesFrom = (node: Syntax | undefined): Syntax[] =>
    reaches(node).flatMap((value) => (value.kind === 'node' ? [value.node] : []));

  /**
   * Whether CALLING a value yields a string.
   *
   * `String(x)` is the global; `x.toString()`, `xs.join('')` and
   * `JSON.stringify(x)` are methods whose result is a string whatever they are
   * called on, so the property name settles it without resolving a receiver.
   */
  const coercesToString = (of: Value): boolean => {
    if (of.kind === 'global') return of.name === 'String';
    if (of.kind === 'member') return STRING_COERCIONS.has(of.property);
    return false;
  };

  /**
   * The values a sink's code argument is judged over.
   *
   * Expressions, plus a marker for a coercion the relation proved — which has
   * no node to hand back, and is exactly the case a node-only view missed:
   * `function w(s) { setTimeout(s(payload), 0) } w(String)` compiles code, and
   * nothing in the argument's syntax says so.
   */
  const codeValues = (node: Syntax | undefined): SinkValue[] =>
    reaches(node).flatMap<SinkValue>((value) => {
      if (value.kind === 'node') return [value.node];
      if (value.kind === 'result' && coercesToString(value.of)) return [COERCED];
      return [];
    });

  /** The METHODS-ON-A-RECEIVER an expression can hold — what a member spec matches. */
  const memberSinks = (node: Syntax | undefined): Array<{ access: Syntax; property: string }> =>
    reaches(node).flatMap((value) =>
      value.kind === 'member' ? [{ access: value.access, property: value.property }] : [],
    );

  /**
   * Where the CODE argument sits for the way this sink was reached.
   *
   * `f(code)` is index 0; `f.call(thisArg, code)` and `f.bind(thisArg, code)`
   * shift by one; `f.apply(thisArg, [code])` puts it inside an array;
   * `Reflect.apply(F, thisArg, [code])` does both, and `Reflect.construct(F,
   * [code])` takes the array one earlier.
   */
  const codePosition = (callee: Syntax): CodePosition => {
    const target = unwrap(callee);
    if (target === undefined) return { index: 0, inArray: false };
    // A CALL-shaped callee is an ordinary invocation of whatever it returned —
    // `const g = () => setTimeout; g()('evil()', 0)` passes its code first.
    // `Reflect` has its own position rule and never reaches here.
    if (
      target.kind === SyntaxKind.PropertyAccessExpression ||
      target.kind === SyntaxKind.ElementAccessExpression
    ) {
      const name = propertyName(target);
      if (name === 'apply') return { index: 1, inArray: true };
      if (name === 'call' || name === 'bind') return { index: 1, inArray: false };
    }
    return { index: 0, inArray: false };
  };

  /** The argument expressions a sink's predicate must be tested against. */
  const codeArguments = (call: Syntax, position: CodePosition, variadic: boolean): Syntax[] => {
    const args = argumentsOf(call);
    if (!position.inArray) {
      const from = args.slice(position.index);
      return variadic ? from : from.slice(0, 1);
    }
    const holder = unwrap(args[position.index]);
    if (holder?.kind !== SyntaxKind.ArrayLiteralExpression) return [];
    const elements = childrenOf(holder);
    return variadic ? elements : elements.slice(0, 1);
  };

  collectAssignments();

  const newlines = newlineIndex(source);
  const finding = (node: Syntax, label: string): SinkFinding => ({
    label,
    line: lineAt(newlines, node.getStart()),
    text: source.slice(node.getStart(), node.getEnd()).replace(/\s+/g, ' ').trim().slice(0, 200),
  });

  /**
   * Property WRITES a call performs, for the standard reflective setters.
   *
   * `node.innerHTML = payload` is one spelling of a write; the platform offers
   * three more that reach the SAME setter and parse the same HTML —
   * `Object.assign(node, { innerHTML: payload })`, `Reflect.set(node,
   * 'innerHTML', payload)` and `Object.defineProperty(node, 'innerHTML', {
   * value: payload })`.  A scan that recognised only an assignment TARGET saw
   * none of them, so the most direct XSS write in the language had three
   * unguarded synonyms.
   *
   * These are distinct platform APIs rather than lexical variants of one form,
   * which is why they are named here: no parse answers "does this invoke a
   * setter", and the set is closed and small.
   */
  const writeCache = new Map<
    string,
    Array<{ at: Syntax; property: string; on: Syntax; value?: Syntax }>
  >();
  const reflectiveWrites = (
    call: Syntax,
  ): Array<{ at: Syntax; property: string; on: Syntax; value?: Syntax }> => {
    // Memoised: the relation asks this of EVERY call, so recomputing it is the
    // per-step cost the rule above exists to avoid.
    const key = `${call.getStart()}:${call.getEnd()}`;
    const cached = writeCache.get(key);
    if (cached !== undefined) return cached;
    writeCache.set(key, []); // cycle guard while this one resolves
    const found = reflectiveWritesOf(call);
    writeCache.set(key, found);
    return found;
  };

  const reflectiveWritesOf = (
    call: Syntax,
  ): Array<{ at: Syntax; property: string; on: Syntax; value?: Syntax }> => {
    // Resolved through the relation, like the invocation helpers: `const
    // assign = Object.assign; assign(node, { innerHTML: payload })` reaches the
    // same setter, and a copy is the cheapest way past a scan matching syntax.
    const args = argumentsOf(call);
    const target = args[0];
    if (target === undefined) return [];
    const writes: Array<{ at: Syntax; property: string; on: Syntax }> = [];
    for (const callee of accessesBehind(call.expression)) {
      const method = propertyName(callee);
      if (method === undefined) continue;
      writes.push(...writesVia(method, callee, call, args, target));
    }
    return writes;
  };

  /** The writes ONE resolved setter performs with these arguments. */
  const writesVia = (
    method: string,
    callee: Syntax,
    call: Syntax,
    args: readonly Syntax[],
    target: Syntax,
  ): Array<{ at: Syntax; property: string; on: Syntax; value?: Syntax }> => {
    const writes: Array<{ at: Syntax; property: string; on: Syntax; value?: Syntax }> = [];
    /** Every statically-named member of an object literal. */
    const members = (
      source: Syntax | undefined,
      hop = 0,
    ): Array<{ at: Syntax; property: string; value?: Syntax }> => {
      const literal = containerOf(source, hop);
      if (literal?.kind !== SyntaxKind.ObjectLiteralExpression) return [];
      const named: Array<{ at: Syntax; property: string; value?: Syntax }> = [];
      for (const member of childrenOf(literal)) {
        // A SPREAD contributes the members of whatever it spreads, so
        // `{ ...{ innerHTML: payload } }` writes the same property the direct
        // form does — and a spread has no `name`, so it was skipped entirely.
        if (member.kind === SyntaxKind.SpreadAssignment) {
          if (hop < MAX_HOPS) named.push(...members(member.expression, hop + 1));
          continue;
        }
        if (member.name === undefined) continue;
        const property =
          member.name.kind === SyntaxKind.ComputedPropertyName
            ? staticPrefix(member.name.expression)
            : nameOf(member.name);
        if (property === null || property === undefined) continue;
        const value =
          member.kind === SyntaxKind.ShorthandPropertyAssignment ? member.name : member.initializer;
        named.push(
          value === undefined ? { at: member, property } : { at: member, property, value },
        );
      }
      return named;
    };

    // `Object.assign(target, …sources)` — every property of every literal
    // source.  `Object.defineProperties(target, descriptors)` names its
    // properties the same way, one level up from `defineProperty`.
    if (isGlobalNamed(callee.expression, 'Object')) {
      if (method === 'assign') {
        for (const source of args.slice(1)) {
          for (const each of members(source)) writes.push({ ...each, on: target });
        }
        return writes;
      }
      if (method === 'defineProperties') {
        // A descriptor map: each member's own `value` is what lands in the slot.
        for (const each of members(args[1])) {
          // The descriptor's `value` BY NAME, not by position: a descriptor
          // that writes `enumerable` or `writable` first put another member at
          // index 0, and reading that one silently took the wrong expression.
          const inner =
            each.value === undefined
              ? undefined
              : members(each.value).find((field) => field.property === 'value')?.value;
          writes.push(
            inner === undefined
              ? { at: each.at, property: each.property, on: target }
              : { at: each.at, property: each.property, on: target, value: inner },
          );
        }
        return writes;
      }
    }

    // `Reflect.set(target, key, value)` and `Object.defineProperty(target, key,
    // descriptor)` both name the property in their SECOND argument.
    const named =
      (method === 'set' && isGlobalNamed(callee.expression, 'Reflect')) ||
      (method === 'defineProperty' && isGlobalNamed(callee.expression, 'Object'));
    if (!named) return [];
    const key = args[1];
    const property = key === undefined ? null : staticPrefix(key);
    if (property === null) return [];
    // `Reflect.set` takes the value third; `Object.defineProperty` wraps it in
    // a descriptor whose own `value` is what the slot receives.
    const supplied =
      method === 'set'
        ? args[2]
        : args[2] === undefined
          ? undefined
          : ((): Syntax | undefined => {
              const descriptor = unwrap(args[2]);
              if (descriptor?.kind !== SyntaxKind.ObjectLiteralExpression) return undefined;
              for (const member of childrenOf(descriptor)) {
                if (member.name === undefined || nameOf(member.name) !== 'value') continue;
                return member.initializer;
              }
              return undefined;
            })();
    return [
      supplied === undefined
        ? { at: call, property, on: target }
        : { at: call, property, on: target, value: supplied },
    ];
  };

  /**
   * Reflective writes, recorded into the SAME container table as `o.run = …`.
   *
   * `Object.assign(o, { run: eval })` then `o.run(payload)` runs the global.
   * The reflective setters were read for member-sink REPORTING only, so the
   * value they place never reached the slot and laundering a sink through one
   * of them walked past the relation entirely.
   *
   * A second pass because it needs `reflectiveWrites`, which needs the
   * resolution built above it.
   */
  const collectReflectiveWrites = (): void => {
    for (const node of walk(root)) {
      if (node.kind !== SyntaxKind.CallExpression && node.kind !== SyntaxKind.NewExpression) {
        continue;
      }
      // `new Map([['run', eval]])` SEEDS the same slots `.set` fills, so the
      // constructor's iterable is read into the same table.
      if (node.kind === SyntaxKind.NewExpression && isGlobalNamed(node.expression, 'Map')) {
        const seed = containerOf(argumentsOf(node)[0], 0);
        if (seed?.kind === SyntaxKind.ArrayLiteralExpression) {
          // Keyed where the READ will look: `m.get('run')` keys on the binding
          // `m`, so the seed must be recorded against that same declaration
          // rather than against the `new` expression that produced it.
          const bound =
            node.parent?.kind === SyntaxKind.VariableDeclaration ? node.parent.name : undefined;
          const holder = bound === undefined ? undefined : receiverKey(bound);
          for (const entry of childrenOf(seed)) {
            const pair = containerOf(entry, 0);
            if (pair?.kind !== SyntaxKind.ArrayLiteralExpression) continue;
            const [key, value] = childrenOf(pair);
            const named = key === undefined ? null : staticPrefix(key);
            if (named === null || value === undefined || holder === undefined) continue;
            const slot = `${holder} ${named}`;
            written.set(slot, [...(written.get(slot) ?? []), value]);
          }
        }
      }
      // `m.set('run', eval)` fills a slot exactly as `o.run = eval` does; the
      // standard collection API is a container with a different spelling, and
      // reading only property syntax let a sink cross it untouched.
      const callee = unwrap(node.expression);
      if (
        (callee?.kind === SyntaxKind.PropertyAccessExpression ||
          callee?.kind === SyntaxKind.ElementAccessExpression) &&
        propertyName(callee) === 'set' &&
        callee.expression !== undefined
      ) {
        const args = argumentsOf(node);
        const key = args[0] === undefined ? null : staticPrefix(args[0]);
        const value = args[1];
        const holder = receiverKey(callee.expression);
        if (key !== null && value !== undefined && holder !== undefined) {
          const slot = `${holder} ${key}`;
          written.set(slot, [...(written.get(slot) ?? []), value]);
        }
      }
      for (const write of reflectiveWrites(node)) {
        if (write.value === undefined) continue;
        const key = receiverKey(write.on);
        if (key === undefined) continue;
        const slot = `${key} ${write.property}`;
        written.set(slot, [...(written.get(slot) ?? []), write.value]);
      }
    }
  };

  /** Where the code argument sits in a `Reflect.apply` / `Reflect.construct`. */
  const reflectPosition = (call: Syntax): CodePosition => {
    // Read off the RESOLVED helper: an aliased `Reflect.construct` has an
    // identifier as its callee, and asking that for a property name returned
    // nothing — which silently fell back to `apply`'s argument position.
    for (const callee of accessesBehind(call.expression)) {
      if (!isGlobalNamed(callee.expression, 'Reflect')) continue;
      if (propertyName(callee) === 'construct') return { index: 1, inArray: true };
    }
    return { index: 2, inArray: true };
  };

  // After BOTH collectors, so a slot filled reflectively is visible to every
  // question asked below.
  collectReflectiveWrites();

  return {
    sinkNames,
    memberSinks,
    codeValues,
    reflectiveWrites,
    codePosition,
    codeArguments,
    propertyName,
    reflectTarget,
    reflectPosition,
    nodesFrom,
    finding,
  };
}

/**
 * Find REFERENCES to globals this project may not mention at all.
 *
 * THE BOUNDED QUESTION, and the reason it exists.  Everything else in this file
 * answers "is this sink INVOKED", which is unbounded: a value can reach a call
 * through a container, a prototype, a proxy, an iterator, a borrowed method,
 * a coercion — and each shape modelled invites the next, exactly as each regex
 * once invited the next spelling.  Six review rounds of `Map` seeds,
 * `Object.create`, `Proxy.revocable` and `Function.prototype.call.call` are
 * that list restarting one level up: the JavaScript STANDARD LIBRARY, restated
 * by hand, in a file whose own header describes escaping precisely this trap
 * for the grammar.
 *
 * For `eval` and `Function` the question does not need to be asked.  This
 * project references them ZERO times in 1284 first-party files, so the rule is
 * that it never does — the shape `check:no-applause` and `check:no-raw-egress`
 * already use, and the shape that ENDS a list rather than extending it.  Every
 * laundering route above still has to name the global somewhere, and naming it
 * is the violation.
 *
 * A reference is a VALUE reference: a type annotation (`fn: Function`) is
 * erased and means nothing at runtime, a property called `eval` on some object
 * is not the global, and a local binding that shadows the name is not it
 * either.  The compiler settles all three.
 *
 * WHAT THIS IS NOT.  It is not a defence against an author determined to
 * evade it — `globalThis[atob('ZXZhbA==')]` defeats any static reading, and
 * always will.  What stops that is the CSP: `script-src` without
 * `'unsafe-eval'` plus `require-trusted-types-for 'script'`, enforced by the
 * browser rather than by a scan, and asserted on the BUILT artifact by
 * `check:csp-parity`.  This gate is hygiene over first-party source; the
 * runtime boundary is the control.
 */
export function findGlobalReferencesIn(
  sources: readonly Source[],
  names: readonly string[],
): Map<string, SinkFinding[]> {
  const forbidden = new Set(names);
  return withParsedSources(sources, (parsed, project) => {
    const byPath = new Map<string, SinkFinding[]>();
    for (const { path, content, root } of parsed) {
      const here = String(root.path);
      const newlines = newlineIndex(content);
      const found: SinkFinding[] = [];
      /**
       * Whether an expression is a spelling of the GLOBAL OBJECT.
       *
       * One bounded hop through a binding, which is all `const g = globalThis`
       * needs — and all it can need, since the alias itself has to name a
       * global receiver to exist.
       */
      const isGlobalObject = (node: Syntax | undefined, hop = 0): boolean => {
        if (node?.kind !== SyntaxKind.Identifier || hop > 4) return false;
        const declaration = project.checker
          .getSymbolAtPosition(here, node.getStart())
          ?.declarations.find((each) => String(each.path) === here)
          ?.resolve(project) as unknown as Syntax | undefined;
        if (declaration === undefined) {
          return GLOBAL_RECEIVERS.has(node.text ?? node.getText());
        }
        if (declaration.kind !== SyntaxKind.VariableDeclaration) return false;
        return isGlobalObject(declaration.initializer, hop + 1);
      };

      /**
       * The forbidden global a DESTRUCTURE selects off the global object.
       *
       * A destructure names the property it takes, and `const { ['eval']: run }
       * = globalThis` selects exactly what `globalThis.eval` selects — but it
       * spells the name in a string literal, which is neither an identifier nor
       * a property access, so both branches below walked past it.  A
       * destructuring ASSIGNMENT, `({ eval: run } = globalThis)`, spells it in
       * a key the declaration-name exclusion skips, and was invisible for the
       * other reason.
       *
       * The SOURCE must still be the global object, so a key off an unrelated
       * record is not a reference to the global — the same discipline the
       * property branch applies to its receiver.
       */
      const destructuredGlobal = (node: Syntax): string | undefined => {
        let named: Syntax | undefined;
        if (node.kind === SyntaxKind.BindingElement) {
          // A SEPARATE identifier key (`{ eval: run }`) is reported as a bare
          // reference below; claiming it here too would say it twice.  A
          // SHORTHAND (`{ Function }`) has no separate key node, so that branch
          // suppresses it as a name being declared and every later use resolves
          // to the local — which left `const { Function } = globalThis` naming
          // the global nowhere at all.
          if (node.propertyName?.kind === SyntaxKind.Identifier) return undefined;
          named = node.propertyName ?? node.name;
        } else if (
          node.kind === SyntaxKind.PropertyAssignment ||
          node.kind === SyntaxKind.ShorthandPropertyAssignment
        ) {
          named = node.name;
        } else {
          return undefined;
        }
        const key = keyText(named, project);
        if (key === undefined || !forbidden.has(key)) return undefined;
        return isGlobalObject(selectionSource(node.parent, project, 0)) ? key : undefined;
      };

      for (const node of walk(root)) {
        const selected = destructuredGlobal(node);
        if (selected !== undefined) {
          found.push({
            label: `reference to the forbidden global \`${selected}\``,
            line: lineAt(newlines, node.getStart()),
            text: content.slice(node.getStart(), node.getEnd()),
          });
          continue;
        }
        // `globalThis.eval` and `self['eval']` name the global through a
        // PROPERTY, where the identifier is the property half — which the
        // declaration-name exclusion below was skipping, so the rule had a hole
        // in exactly the shape it exists to close.  The receiver is resolved
        // one hop, so `o.eval` on an unrelated object is still not the global.
        if (
          node.kind === SyntaxKind.PropertyAccessExpression ||
          node.kind === SyntaxKind.ElementAccessExpression
        ) {
          // The computed half is read with the SAME resolver the destructure
          // branch uses.  Taking `argumentExpression.text` saw only a bare
          // literal, so `globalThis['ev' + 'al']` — a fully static key naming
          // the global, with no invocation for the sink scan to report either —
          // passed the rule the file's whole premise rests on.
          const named =
            node.kind === SyntaxKind.PropertyAccessExpression
              ? node.name === undefined
                ? undefined
                : (node.name.text ?? node.name.getText())
              : staticKeyOf(node.argumentExpression, project);
          if (named !== undefined && forbidden.has(named) && isGlobalObject(node.expression)) {
            found.push({
              label: `reference to the forbidden global \`${named}\``,
              line: lineAt(newlines, node.getStart()),
              text: content.slice(node.getStart(), node.getEnd()),
            });
          }
          continue;
        }
        if (node.kind !== SyntaxKind.Identifier) continue;
        const name = node.text ?? node.getText();
        if (!forbidden.has(name)) continue;
        // A NAME being declared is not a reference to the global.
        if (node.parent?.name?.getStart() === node.getStart()) continue;
        // A TYPE position is erased at build and runs nothing.  The range is
        // the compiler's own, so a new type node kind needs no entry here.
        let inType = false;
        for (let above = node.parent; above !== undefined; above = above.parent) {
          if (above.kind >= SyntaxKind.FirstTypeNode && above.kind <= SyntaxKind.LastTypeNode) {
            inType = true;
            break;
          }
        }
        if (inType) continue;
        // A local binding that shadows the name is not the global.
        const symbol = project.checker.getSymbolAtPosition(here, node.getStart());
        if (symbol?.declarations.some((each) => String(each.path) === here) === true) continue;
        found.push({
          label: `reference to the forbidden global \`${name}\``,
          line: lineAt(newlines, node.getStart()),
          text: content.slice(node.getStart(), node.getEnd()),
        });
      }
      byPath.set(path, found);
    }
    return byPath;
  });
}

/**
 * Find dynamic-code sink INVOCATIONS across many sources, in ONE project.
 *
 * Batched because opening a project is the cost that matters: a repository-wide
 * scan that opened one per file spent three minutes doing it, and the same scan
 * in a single project is a few seconds.  Every gate that walks a tree of files
 * should call this rather than the single-source form.
 */
export function findSinkInvocationsIn(
  sources: readonly Source[],
  specs: readonly SinkSpec[],
): Map<string, SinkFinding[]> {
  return withParsedSources(sources, (parsed, project) => {
    const byPath = new Map<string, SinkFinding[]>();
    // Every source in the scan, so a declaration reached ACROSS a module edge
    // is recognised as local to the batch rather than mistaken for a global.
    const batch = new Set(parsed.map((each) => String(each.root.path)));
    for (const { path, content, root } of parsed) {
      byPath.set(path, invocationsIn(root, project, content, specs, batch));
    }
    return byPath;
  });
}

/** Find dynamic-code sink INVOCATIONS in one source. */
export function findSinkInvocations(source: string, specs: readonly SinkSpec[]): SinkFinding[] {
  return findSinkInvocationsIn([{ path: 'scan.ts', content: source }], specs).get('scan.ts') ?? [];
}

function invocationsIn(
  root: Syntax,
  project: Project,
  source: string,
  specs: readonly SinkSpec[],
  batch: ReadonlySet<string>,
): SinkFinding[] {
  {
    const read = analyser(root, project, source, batch);
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    const found = new Map<string, SinkFinding>();

    for (const node of walk(root)) {
      const tagged = node.kind === SyntaxKind.TaggedTemplateExpression;
      if (
        node.kind !== SyntaxKind.CallExpression &&
        node.kind !== SyntaxKind.NewExpression &&
        !tagged
      ) {
        continue;
      }
      // `` eval`code` `` invokes its TAG, and the template is the argument.
      const callee = tagged ? node.tag : node.expression;
      if (callee === undefined) continue;
      // A dynamic `import(…)` has the KEYWORD as its callee; every other sink is
      // reached through an expression.
      const viaImport = callee.kind === SyntaxKind.ImportKeyword;
      // `Reflect.apply(eval, null, ['x'])` runs the sink HERE, rather than
      // producing something that is invoked later.
      const reflected = viaImport ? undefined : read.reflectTarget(node);
      const names = viaImport
        ? ['import']
        : reflected === undefined
          ? read.sinkNames(callee)
          : read.sinkNames(reflected);
      // The callee may be a SELECTION, so several names are possible and only
      // this caller knows which of them are sinks.
      const spec = names.map((name) => byName.get(name)).find((each) => each !== undefined);
      if (spec === undefined) continue;
      if (spec.codeArgument !== undefined) {
        const position = viaImport
          ? { index: 0, inArray: false }
          : reflected !== undefined
            ? read.reflectPosition(node)
            : tagged
              ? { index: 0, inArray: false }
              : read.codePosition(callee);
        const args = read.codeArguments(node, position, spec.variadic === true);
        // Each argument is judged over everything it could BE, not over the
        // syntax written at the call: `setTimeout(code, 0)` compiles a string
        // when `code` holds one.
        if (!args.some((arg) => spec.codeArgument?.(read.codeValues(arg)) === true)) continue;
      }
      const entry = read.finding(node, spec.label);
      found.set(`${entry.line}:${entry.label}:${entry.text}`, entry);
    }
    return [...found.values()].sort((a, b) => a.line - b.line || a.label.localeCompare(b.label));
  }
}

/**
 * A `javascript:` URL — string CONTENT that executes when navigated to.
 *
 * Read from the COOKED value of a string, not from a pattern over the source.
 * The pattern this replaces required the quote immediately before the scheme,
 * so it saw `'javascript:alert(1)'` and missed every equivalent spelling: a
 * leading space (`' javascript:…'` — the URL parser trims it), an escape
 * (`'\x6aavascript:…'`), and a tab inside the scheme (`'java\tscript:…'`,
 * which HTML attribute parsing strips).  All three navigate.
 */
function isJavascriptUrl(value: string): boolean {
  const stripped = [...value].filter((c) => c !== '\t' && c !== '\n' && c !== '\r').join('');
  let from = 0;
  while (from < stripped.length && (stripped.codePointAt(from) ?? 0x21) <= 0x20) from += 1;
  return /^javascript:/i.test(stripped.slice(from));
}

/** Every `javascript:` URL literal in each source. */
export function findJavascriptUrlsIn(sources: readonly Source[]): Map<string, SinkFinding[]> {
  return withParsedSources(sources, (parsed, project) => {
    const byPath = new Map<string, SinkFinding[]>();
    for (const { path, content, root } of parsed) {
      const here = String(root.path);
      /**
       * What a NAME holds, for folding a scheme.
       *
       * The narrow question this scan asks — `const scheme = 'javascript';
       * scheme + ':alert(1)'` navigates as the literal does — answered by
       * following the binding, memoised.
       *
       * NOT the value relation.  Asking the general machine here built a
       * call-site map this scan never consults and ran a whole-program search
       * for every identifier in every string concatenation in the repository,
       * which took the scan from milliseconds to never finishing.  The general
       * relation is for the general question; this one has one hop and a name.
       */
      const boundTo = new Map<number, readonly Syntax[]>();
      const held = (name: Syntax): readonly Syntax[] => {
        const at = name.getStart();
        const cached = boundTo.get(at);
        if (cached !== undefined) return cached;
        boundTo.set(at, []); // cycle guard while this one resolves
        const declaration = project.checker
          .getSymbolAtPosition(here, at)
          ?.declarations.find((each) => String(each.path) === here)
          ?.resolve(project) as unknown as Syntax | undefined;
        const initializer =
          declaration?.kind === SyntaxKind.VariableDeclaration
            ? declaration.initializer
            : undefined;
        const found = initializer === undefined ? [] : [initializer];
        boundTo.set(at, found);
        return found;
      };
      const newlines = newlineIndex(content);
      const found: SinkFinding[] = [];
      const seen = new Set<number>();
      for (const node of walk(root)) {
        // The SCHEME is the static part, so an interpolated template counts:
        // `\`javascript:${payload}\`` navigates exactly as the literal does, and
        // so does `'java' + 'script:x'`.  `staticPrefix` folds all three.
        if (
          node.kind !== SyntaxKind.StringLiteral &&
          node.kind !== SyntaxKind.NoSubstitutionTemplateLiteral &&
          node.kind !== SyntaxKind.TemplateExpression &&
          !(
            node.kind === SyntaxKind.BinaryExpression &&
            node.operatorToken?.kind === SyntaxKind.PlusToken
          )
        ) {
          continue;
        }
        const prefix = staticPrefix(node, 0, held);
        if (prefix === null || !isJavascriptUrl(prefix)) continue;
        const line = lineAt(newlines, node.getStart());
        // A folded concatenation and the literal inside it are one URL.
        if (seen.has(line)) continue;
        seen.add(line);
        found.push({
          label: 'javascript: URL (XSS vector)',
          line,
          text: content.slice(node.getStart(), node.getEnd()).slice(0, 200),
        });
      }
      byPath.set(path, found);
    }
    return byPath;
  });
}

/** Find member-named DOM sink uses across many sources, in ONE project. */
export function findMemberSinkUsesIn(
  sources: readonly Source[],
  specs: readonly MemberSinkSpec[],
): Map<string, SinkFinding[]> {
  return withParsedSources(sources, (parsed, project) => {
    const byPath = new Map<string, SinkFinding[]>();
    const batch = new Set(parsed.map((each) => String(each.root.path)));
    for (const { path, content, root } of parsed) {
      byPath.set(path, memberUsesIn(root, project, content, specs, batch));
    }
    return byPath;
  });
}

/** Find uses of member-named DOM sinks, in every access spelling. */
export function findMemberSinkUses(
  source: string,
  specs: readonly MemberSinkSpec[],
): SinkFinding[] {
  return findMemberSinkUsesIn([{ path: 'scan.ts', content: source }], specs).get('scan.ts') ?? [];
}

function memberUsesIn(
  root: Syntax,
  project: Project,
  source: string,
  specs: readonly MemberSinkSpec[],
  batch: ReadonlySet<string>,
): SinkFinding[] {
  {
    const read = analyser(root, project, source, batch);
    const found = new Map<string, SinkFinding>();
    const callSpecs = specs.filter((spec) => spec.form === 'call');
    const assignSpecs = specs.filter((spec) => spec.form !== 'call');

    const report = (access: Syntax, spec: MemberSinkSpec, on?: Syntax): void => {
      if (spec.receiver !== undefined) {
        // The receiver is resolved, not spelled: `const doc = document;
        // doc.write(p)` reaches the same absolutely-forbidden method, and
        // comparing identifier TEXT saw only the literal name.
        const base = on ?? access.expression;
        if (base === undefined || !read.sinkNames(base).includes(spec.receiver)) return;
      }
      const entry = read.finding(access, spec.label);
      found.set(`${entry.line}:${entry.label}`, entry);
    };

    for (const node of walk(root)) {
      // CALLING one.  Asked of the CALLEE'S VALUE rather than of the syntax at
      // the call, which is the whole difference: `document.write(p)` and
      // `const write = document.write; write(p)` invoke the same method, and a
      // scan keyed on "a property access whose parent is a call" saw only the
      // first.  The wrapper spellings — `document.write.call(…)`,
      // `Reflect.apply(document.write, …)` — need no case of their own either,
      // since the relation already resolves both to the same member value.
      if (
        node.kind === SyntaxKind.CallExpression ||
        node.kind === SyntaxKind.NewExpression ||
        node.kind === SyntaxKind.TaggedTemplateExpression
      ) {
        // `` document.write`<b>${p}</b>` `` invokes the method exactly as the
        // parenthesised call does — the tag is where the callee sits.
        // A call may also WRITE a property, through the reflective setters.
        if (node.kind !== SyntaxKind.TaggedTemplateExpression) {
          for (const write of read.reflectiveWrites(node)) {
            for (const spec of assignSpecs) {
              if (spec.property === write.property) report(write.at, spec, write.on);
            }
          }
        }
        const invoked =
          node.kind === SyntaxKind.TaggedTemplateExpression
            ? node.tag
            : (read.reflectTarget(node) ?? node.expression);
        for (const member of read.memberSinks(invoked)) {
          for (const spec of callSpecs) {
            if (spec.property === member.property) report(member.access, spec);
          }
        }
        continue;
      }

      // WRITING one.  An assignment TARGET is a location, not a value, so it
      // cannot be aliased into a local the way a method can — reading the
      // syntax here is not a shortcut, it is what the property is.
      if (
        node.kind !== SyntaxKind.PropertyAccessExpression &&
        node.kind !== SyntaxKind.ElementAccessExpression
      ) {
        continue;
      }
      const name = read.propertyName(node);
      if (name === undefined) continue;
      const parent = node.parent;
      // Every operator that writes the property, `=` through `??=`.
      const assigned =
        parent?.kind === SyntaxKind.BinaryExpression &&
        WRITING_ASSIGNMENTS.has(parent.operatorToken?.kind ?? -1) &&
        parent.left?.getStart() === node.getStart();
      if (!assigned) continue;
      for (const spec of assignSpecs) {
        if (spec.property === name) report(node, spec);
      }
    }
    return [...found.values()].sort((a, b) => a.line - b.line || a.label.localeCompare(b.label));
  }
}
