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
  readonly codeArgument?: (values: readonly Syntax[]) => boolean;
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
function staticPrefix(node: Syntax | undefined, hop = 0): string | null {
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
    const left = staticPrefix(target.left, hop + 1);
    if (left === null) return null;
    const right = staticPrefix(target.right, hop + 1);
    return right === null ? left : left + right;
  }
  return null;
}

/**
 * The code argument is a STRING — the implicit-eval timer form.
 *
 * An INTERPOLATED template counts: a template with holes is still a string the
 * host compiles, so requiring a fully static literal would miss the form an
 * attacker is most likely to use.
 */
export const isStringLiteral = (values: readonly Syntax[]): boolean =>
  values.some((value) => isStringLike(value));

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
  // COERCIONS produce a string the host compiles just the same:
  // `setTimeout(String(payload), 0)` and `setInterval(x.toString(), 0)` are
  // implicit eval, and recognising only literal syntax read them as clean.
  // The receiver is not resolved here on purpose — anything's `.toString()`
  // returns a string, so the method name alone settles it.
  if (target.kind === SyntaxKind.CallExpression) {
    const callee = unwrap(target.expression);
    if (callee?.kind === SyntaxKind.Identifier && (callee.text ?? callee.getText()) === 'String') {
      return true;
    }
    if (
      callee?.kind === SyntaxKind.PropertyAccessExpression &&
      callee.name !== undefined &&
      (callee.name.text ?? callee.name.getText()) === 'toString'
    ) {
      return true;
    }
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
export const isNonSameOriginUrl = (values: readonly Syntax[]): boolean =>
  values.some((value) => isOffOrigin(value));

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
    const argument = node.argumentExpression;
    if (argument === undefined) return undefined;
    const type = project.checker.getTypeAtLocation(asNode(argument));
    if (type?.isStringLiteralType() === true) return String(type.value);
    if (type?.isNumberLiteralType() === true) return String(type.value);
    // A literal the checker did not narrow (a `.js` source has no `as const`).
    if (argument.kind === SyntaxKind.NumericLiteral) return argument.text ?? argument.getText();
    // A key the checker did not narrow, including a COMPOSED one:
    // `node['inner' + 'HTML']` names the same property as the plain spelling.
    return staticPrefix(argument) ?? undefined;
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
    if (target === undefined || target.kind !== SyntaxKind.Identifier || hop > MAX_HOPS) {
      return undefined;
    }
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
  const written = new Map<string, Syntax>();
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
      written.set(`${key} ${name}`, value);
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
   */
  const bindingKey = (element: Syntax, pattern: Syntax): string | undefined => {
    if (pattern.kind === SyntaxKind.ArrayBindingPattern) {
      const at = childrenOf(pattern).findIndex((each) => each.getStart() === element.getStart());
      return at < 0 ? undefined : String(at);
    }
    const named = (element.propertyName ?? element.name) as Syntax | undefined;
    return named === undefined ? undefined : nameOf(named);
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
  const containerOf = (node: Syntax | undefined, hop: number): Syntax | undefined => {
    const target = unwrap(node);
    if (target === undefined || hop > MAX_HOPS) return undefined;
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
  const heldAt = (base: Syntax, name: string, hop: number): Syntax | undefined => {
    const key = receiverKey(base);
    const assigned = key === undefined ? undefined : written.get(`${key} ${name}`);
    if (assigned !== undefined) return assigned;
    if (hop > MAX_HOPS) return undefined;
    // `const o = { run: eval }`, `const h = [eval]`, and the nested forms —
    // reached through the binding rather than through a table beside the scan.
    const literal = containerOf(base, hop);
    if (literal === undefined) return undefined;
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
          return member;
        }
        return member.kind === SyntaxKind.ShorthandPropertyAssignment
          ? member.name
          : member.initializer;
      }
      return undefined;
    }
    if (literal.kind === SyntaxKind.ArrayLiteralExpression) {
      const index = Number(name);
      return Number.isInteger(index) ? childrenOf(literal)[index] : undefined;
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
          return member;
        }
        if (member.kind === SyntaxKind.PropertyDeclaration) return member.initializer;
      }
      return undefined;
    }
    return undefined;
  };

  /**
   * The expression a `Reflect.apply` / `Reflect.construct` call INVOKES.
   *
   * Read through `propertyName`, so `Reflect['apply']` is the same call as the
   * dotted spelling rather than a second case.
   */
  const reflectTarget = (call: Syntax): Syntax | undefined => {
    const callee = accessBehind(call.expression, 0);
    if (callee === undefined) return undefined;
    if (!isGlobalNamed(callee.expression, 'Reflect')) return undefined;
    const method = propertyName(callee);
    if (method === undefined || !REFLECT_INVOKERS.has(method)) return undefined;
    return argumentsOf(call)[0];
  };

  /**
   * The property ACCESS an expression denotes, through any bindings.
   *
   * `Reflect.construct` is a value like any other, so copying it into a local
   * (`const c = Reflect.construct; c(Function, ['x'])`) invokes the same helper
   * — and matching the ACCESS SYNTAX at the call saw only the spelled form.
   *
   * Resolved with the binding walk rather than the full relation on purpose:
   * the relation asks this function about every call, so consulting it here
   * would not terminate.
   */
  const accessBehind = (node: Syntax | undefined, hop: number): Syntax | undefined => {
    const target = unwrap(node);
    if (target === undefined || hop > MAX_HOPS) return undefined;
    if (
      target.kind === SyntaxKind.PropertyAccessExpression ||
      target.kind === SyntaxKind.ElementAccessExpression
    ) {
      return target;
    }
    if (target.kind !== SyntaxKind.Identifier || isGlobalBinding(target)) return undefined;
    const key = receiverKey(target);
    for (const assigned of key === undefined ? [] : (rebound.get(key) ?? [])) {
      const found = accessBehind(assigned, hop + 1);
      if (found !== undefined) return found;
    }
    return accessBehind(boundValue(localDeclaration(target), hop), hop + 1);
  };

  /** Whether an expression is the named global (and nothing local). */
  const isGlobalNamed = (node: Syntax | undefined, name: string): boolean => {
    const target = unwrap(node);
    if (target === undefined || target.kind !== SyntaxKind.Identifier) return false;
    return nameOf(target) === name && isGlobalBinding(target);
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
      if (node.kind === SyntaxKind.ReturnStatement) {
        if (node.expression !== undefined) returned.push(node.expression);
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
      // What was WRITTEN into this slot, and what its literal holds.
      const held = heldAt(base, name, 0);
      if (held !== undefined) from.push(nodeValue(held));
      if (isGlobalReceiver(base)) from.push(globalValue(name));
      // `F.call(…)` still runs `F`; an invoked `.constructor` is `Function`.
      if (INVOKERS.has(name)) from.push(nodeValue(base));
      if (name === 'constructor') from.push(globalValue('Function'));
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

  const reaches = (node: Syntax | undefined): Value[] => {
    if (node === undefined) return [];
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
    return found;
  };

  /** The GLOBAL NAMES an expression can hold — what a sink spec matches. */
  const sinkNames = (node: Syntax | undefined): string[] =>
    reaches(node).flatMap((value) => (value.kind === 'global' ? [value.name] : []));

  /** The EXPRESSIONS an expression can hold — what the value predicates read. */
  const nodesFrom = (node: Syntax | undefined): Syntax[] =>
    reaches(node).flatMap((value) => (value.kind === 'node' ? [value.node] : []));

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
  const reflectiveWrites = (call: Syntax): Array<{ at: Syntax; property: string; on: Syntax }> => {
    // Resolved through bindings, like the invocation helpers: `const assign =
    // Object.assign; assign(node, { innerHTML: payload })` reaches the same
    // setter, and a copy is the cheapest way past a scan that matches syntax.
    const callee = accessBehind(call.expression, 0);
    if (callee === undefined) return [];
    const method = propertyName(callee);
    if (method === undefined) return [];
    const args = argumentsOf(call);
    const target = args[0];
    if (target === undefined) return [];
    const writes: Array<{ at: Syntax; property: string; on: Syntax }> = [];

    // `Object.assign(target, …sources)` — every property of every literal source.
    if (method === 'assign' && isGlobalNamed(callee.expression, 'Object')) {
      for (const source of args.slice(1)) {
        const literal = unwrap(source);
        if (literal?.kind !== SyntaxKind.ObjectLiteralExpression) continue;
        for (const member of childrenOf(literal)) {
          if (member.name === undefined) continue;
          const named =
            member.name.kind === SyntaxKind.ComputedPropertyName
              ? staticPrefix(member.name.expression)
              : nameOf(member.name);
          if (named !== null && named !== undefined) {
            writes.push({ at: member, property: named, on: target });
          }
        }
      }
      return writes;
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
    return [{ at: call, property, on: target }];
  };

  /** Where the code argument sits in a `Reflect.apply` / `Reflect.construct`. */
  const reflectPosition = (call: Syntax): CodePosition => {
    const method = propertyName(unwrap(call.expression) as Syntax) ?? '';
    return method === 'construct' ? { index: 1, inArray: true } : { index: 2, inArray: true };
  };

  return {
    sinkNames,
    memberSinks,
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
        if (!args.some((arg) => spec.codeArgument?.(read.nodesFrom(arg)) === true)) continue;
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
  return withParsedSources(sources, (parsed) => {
    const byPath = new Map<string, SinkFinding[]>();
    for (const { path, content, root } of parsed) {
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
        const prefix = staticPrefix(node);
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
