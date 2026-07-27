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

import type { Node } from 'typescript/unstable/ast';
import { SyntaxKind } from 'typescript/unstable/ast';
import type { Project } from 'typescript/unstable/sync';
import {
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
function analyser(root: Syntax, project: Project, source: string) {
  const filePath = String(root.path);
  // `Syntax` is this module's reading view of the tree; the checker wants the
  // API's own node type, and the two describe the same object.
  const asNode = (node: Syntax): Node => node as unknown as Node;

  const symbolAt = (node: Syntax) => project.checker.getSymbolAtPosition(filePath, node.getStart());

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
    return !symbol.declarations.some((declaration) => String(declaration.path) === filePath);
  };

  /** The declaration a local name binds to, resolved to a node. */
  const localDeclaration = (node: Syntax): Syntax | undefined => {
    const symbol = symbolAt(node);
    const handle = symbol?.declarations.find(
      (declaration) => String(declaration.path) === filePath,
    );
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
   * That following stops at a GLOBAL, which is what keeps the copy-on-write
   * behaviour honest: `const g = globalThis` canonicalises to `globalThis`, so
   * `g.zzz = eval` is visible through `globalThis.zzz` — and not through
   * `self.zzz`, a different name for a different key.
   */
  const receiverKey = (base: Syntax, hop = 0): string | undefined => {
    const target = unwrap(base);
    if (target === undefined || target.kind !== SyntaxKind.Identifier || hop > MAX_HOPS) {
      return undefined;
    }
    const declaration = symbolAt(target)?.declarations.find(
      (each) => String(each.path) === filePath,
    );
    if (declaration === undefined) return `global:${nameOf(target)}`;
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
      return containerOf(boundValue(localDeclaration(target), hop), hop + 1);
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
    return undefined;
  };

  /**
   * The expression a `Reflect.apply` / `Reflect.construct` call INVOKES.
   *
   * Read through `propertyName`, so `Reflect['apply']` is the same call as the
   * dotted spelling rather than a second case.
   */
  const reflectTarget = (call: Syntax): Syntax | undefined => {
    const callee = unwrap(call.expression);
    if (
      callee?.kind !== SyntaxKind.PropertyAccessExpression &&
      callee?.kind !== SyntaxKind.ElementAccessExpression
    ) {
      return undefined;
    }
    if (!isGlobalNamed(callee.expression, 'Reflect')) return undefined;
    const method = propertyName(callee);
    if (method === undefined || !REFLECT_INVOKERS.has(method)) return undefined;
    return argumentsOf(call)[0];
  };

  /** Whether an expression is the named global (and nothing local). */
  const isGlobalNamed = (node: Syntax | undefined, name: string): boolean => {
    const target = unwrap(node);
    if (target === undefined || target.kind !== SyntaxKind.Identifier) return false;
    return nameOf(target) === name && isGlobalBinding(target);
  };

  /**
   * Every expression a node could evaluate to.
   *
   * SELECTION and BINDING are the two ways a value arrives somewhere other than
   * where it was written, and both must be followed or the thing at the end of
   * them is invisible: `(eval || fallback)(x)` invokes `eval` because it is
   * truthy, and `const code = 'alert(1)'; setTimeout(code, 0)` compiles a string
   * the argument's own syntax does not show.
   *
   * One resolver rather than a rule per predicate, because the sink walk, the
   * string test and the URL test all ask the same question of the same shapes —
   * and answering it in only one of them is how the other two went stale.
   */
  const valuesOf = (node: Syntax | undefined, hop = 0, seen = new Set<string>()): Syntax[] => {
    const target = unwrap(node);
    if (target === undefined || hop > MAX_HOPS) return [];
    // Keyed on the full RANGE: a binary expression starts where its left operand
    // does, so a start offset alone is not an identity and the operand that
    // matters would be skipped as already-seen.
    const at = `${target.getStart()}:${target.getEnd()}`;
    if (seen.has(at)) return [];
    seen.add(at);

    if (target.kind === SyntaxKind.ConditionalExpression) {
      return [
        ...valuesOf(target.whenTrue, hop + 1, seen),
        ...valuesOf(target.whenFalse, hop + 1, seen),
      ];
    }
    // `||`, `&&` and `??` all SELECT one operand; either may be the one that runs.
    if (
      target.kind === SyntaxKind.BinaryExpression &&
      SELECTORS.has(target.operatorToken?.kind ?? -1)
    ) {
      return [...valuesOf(target.left, hop + 1, seen), ...valuesOf(target.right, hop + 1, seen)];
    }
    if (target.kind === SyntaxKind.Identifier && !isGlobalBinding(target)) {
      const from: Syntax[] = [];
      const key = receiverKey(target);
      for (const assigned of key === undefined ? [] : (rebound.get(key) ?? [])) {
        from.push(...valuesOf(assigned, hop + 1, seen));
      }
      const declaration = localDeclaration(target);
      if (declaration?.kind === SyntaxKind.VariableDeclaration) {
        from.push(...valuesOf(declaration.initializer, hop + 1, seen));
      }
      // The name itself stays a candidate: it may BE the thing (a parameter, an
      // import), and dropping it would lose every sink reached through one.
      return [target, ...from];
    }
    return [target];
  };

  /**
   * The GLOBAL NAME an expression evaluates to, if any.
   *
   * EVERY name, not the first: a selection runs one of its operands and only
   * the caller knows which names are sinks, so `(ready && eval)(x)` must offer
   * both rather than stopping at the first global it can name.
   *
   * Names rather than specs, so one walk serves every spec set and
   * `globalThis.whatever` resolves without knowing which names the caller cares
   * about.
   */
  const sinkNames = (node: Syntax | undefined, hop = 0): string[] => {
    const target = unwrap(node);
    if (target === undefined || hop > MAX_HOPS) return [];

    if (target.kind === SyntaxKind.Identifier) {
      if (isGlobalBinding(target)) return [nameOf(target)];
      // A later assignment reaches this name just as an initializer does, and
      // either can be the one that makes it a sink.
      const names: string[] = [];
      const key = receiverKey(target);
      for (const assigned of key === undefined ? [] : (rebound.get(key) ?? [])) {
        names.push(...sinkNames(assigned, hop + 1));
      }
      const declaration = localDeclaration(target);
      if (declaration?.kind === SyntaxKind.VariableDeclaration) {
        names.push(...sinkNames(declaration.initializer, hop + 1));
      }
      if (names.length > 0) return names;
      if (declaration?.kind === SyntaxKind.BindingElement) {
        // `const { eval: e } = globalThis` names a property off the global; and
        // `const [F] = [Function]` names one off a container by POSITION.  Both
        // are the same act, so both are read through the same lookup.
        const pattern = declaration.parent;
        const from = pattern?.parent?.initializer;
        if (pattern === undefined || from === undefined) return [];
        const name = bindingKey(declaration, pattern);
        if (name === undefined) return [];
        if (isGlobalReceiver(from)) return [name];
        const held = heldAt(from, name, hop);
        return held === undefined ? [] : sinkNames(held, hop + 1);
      }
      return [];
    }

    if (
      target.kind === SyntaxKind.PropertyAccessExpression ||
      target.kind === SyntaxKind.ElementAccessExpression
    ) {
      const name = propertyName(target);
      const base = target.expression;
      if (name === undefined || base === undefined) return [];
      // What was WRITTEN into this slot wins over what the receiver is.
      const held = heldAt(base, name, hop);
      if (held !== undefined) return sinkNames(held, hop + 1);
      if (isGlobalReceiver(base)) return [name];
      // `F.call(…)` still runs `F`; an invoked `.constructor` is `Function`.
      if (INVOKERS.has(name)) return sinkNames(base, hop + 1);
      if (name === 'constructor') return ['Function'];
      return [];
    }

    if (target.kind === SyntaxKind.CallExpression) {
      // `Reflect.apply(F, …)` / `Reflect.construct(F, …)` invoke their FIRST
      // argument, so the sink is whatever that argument resolves to.
      const invoked = reflectTarget(target);
      if (invoked !== undefined) return sinkNames(invoked, hop + 1);
      // A local function RETURNING a sink hands it to the caller:
      // `const get = () => eval; get()(payload)` runs the global.
      return returnedBy(target.expression, hop).flatMap((value) => sinkNames(value, hop + 1));
    }

    // A SELECTION runs one of its operands, and either may be the sink:
    // `(eval || fallback)(x)` invokes `eval` because it is truthy.
    if (target.kind === SyntaxKind.ConditionalExpression) {
      return [...sinkNames(target.whenTrue, hop + 1), ...sinkNames(target.whenFalse, hop + 1)];
    }
    if (
      target.kind === SyntaxKind.BinaryExpression &&
      SELECTORS.has(target.operatorToken?.kind ?? -1)
    ) {
      return [...sinkNames(target.left, hop + 1), ...sinkNames(target.right, hop + 1)];
    }
    return [];
  };

  /**
   * The expressions a called function can RETURN, when it is a local one.
   *
   * `const get = () => eval` hands the global to whoever calls `get()`, so a
   * callee that is itself a call is not automatically clean — the value it
   * yields has to be resolved too.  Both body forms count: an arrow's
   * expression body, and every `return` in a block.
   */
  const returnedBy = (callee: Syntax | undefined, hop: number): Syntax[] => {
    const target = unwrap(callee);
    if (target === undefined || hop > MAX_HOPS) return [];
    let fn: Syntax | undefined;
    if (target.kind === SyntaxKind.Identifier && !isGlobalBinding(target)) {
      const declaration = localDeclaration(target);
      if (declaration?.kind === SyntaxKind.FunctionDeclaration) fn = declaration;
      else fn = unwrap(boundValue(declaration, hop));
    } else {
      fn = target;
    }
    if (
      fn?.kind !== SyntaxKind.ArrowFunction &&
      fn?.kind !== SyntaxKind.FunctionExpression &&
      fn?.kind !== SyntaxKind.FunctionDeclaration
    ) {
      return [];
    }
    const body = fn.body;
    if (body === undefined) return [];
    if (body.kind !== SyntaxKind.Block) return [body];
    const returned: Syntax[] = [];
    for (const node of walk(body)) {
      if (node.kind === SyntaxKind.ReturnStatement && node.expression !== undefined) {
        returned.push(node.expression);
      }
    }
    return returned;
  };

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

  /** Where the code argument sits in a `Reflect.apply` / `Reflect.construct`. */
  const reflectPosition = (call: Syntax): CodePosition => {
    const method = propertyName(unwrap(call.expression) as Syntax) ?? '';
    return method === 'construct' ? { index: 1, inArray: true } : { index: 2, inArray: true };
  };

  return {
    sinkNames,
    codePosition,
    codeArguments,
    propertyName,
    reflectTarget,
    reflectPosition,
    valuesOf,
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
    for (const { path, content, root } of parsed) {
      byPath.set(path, invocationsIn(root, project, content, specs));
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
): SinkFinding[] {
  {
    const read = analyser(root, project, source);
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
        if (!args.some((arg) => spec.codeArgument?.(read.valuesOf(arg)) === true)) continue;
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
    for (const { path, content, root } of parsed) {
      byPath.set(path, memberUsesIn(root, project, content, specs));
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
): SinkFinding[] {
  {
    const read = analyser(root, project, source);
    const found = new Map<string, SinkFinding>();

    for (const node of walk(root)) {
      if (
        node.kind !== SyntaxKind.PropertyAccessExpression &&
        node.kind !== SyntaxKind.ElementAccessExpression
      ) {
        continue;
      }
      const name = read.propertyName(node);
      if (name === undefined) continue;
      const parent = node.parent;
      const at = node.getStart();
      // `x.p(…)` — the access is the CALLEE.  It is ALSO invoked through the
      // standard wrappers, which run the same method without naming it
      // differently: `document.write.call(document, p)` and
      // `Reflect.apply(document.write, document, [p])`.
      const directly =
        parent?.kind === SyntaxKind.CallExpression && parent.expression?.getStart() === at;
      const viaInvoker =
        (parent?.kind === SyntaxKind.PropertyAccessExpression ||
          parent?.kind === SyntaxKind.ElementAccessExpression) &&
        parent.expression?.getStart() === at &&
        INVOKERS.has(read.propertyName(parent) ?? '') &&
        parent.parent?.kind === SyntaxKind.CallExpression;
      const viaReflect =
        parent?.kind === SyntaxKind.CallExpression && read.reflectTarget(parent)?.getStart() === at;
      const called = directly || viaInvoker === true || viaReflect === true;
      // Every operator that writes the property, `=` through `??=`.
      const assigned =
        parent?.kind === SyntaxKind.BinaryExpression &&
        WRITING_ASSIGNMENTS.has(parent.operatorToken?.kind ?? -1) &&
        parent.left?.getStart() === at;

      for (const spec of specs) {
        if (spec.property !== name) continue;
        if (spec.form === 'call' ? !called : !assigned) continue;
        if (spec.receiver !== undefined) {
          // The receiver is resolved, not spelled: `const doc = document;
          // doc.write(p)` reaches the same absolutely-forbidden method, and
          // comparing identifier TEXT saw only the literal name.
          const base = node.expression;
          if (base === undefined || !read.sinkNames(base).includes(spec.receiver)) continue;
        }
        const entry = read.finding(node, spec.label);
        found.set(`${entry.line}:${entry.label}`, entry);
      }
    }
    return [...found.values()].sort((a, b) => a.line - b.line || a.label.localeCompare(b.label));
  }
}
