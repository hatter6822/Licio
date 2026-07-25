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

/** Global objects through which a sink can be reached by property access. */
const GLOBAL_RECEIVERS: ReadonlySet<string> = new Set(['globalThis', 'window', 'self']);

/**
 * Read a member access at `i` — `.name`, `?.name`, `['name']`, `?.['name']`.
 * Returns the accessed name and the index after it, or `null`.
 */
function readMember(tokens: readonly Token[], i: number): { name: string; next: number } | null {
  let k = i;
  if (isPunct(tokens[k], '?.')) k += 1;
  else if (isPunct(tokens[k], '.')) k += 1;
  else if (isPunct(tokens[k], '[')) {
    const name = stringValue(tokens[k + 1]);
    if (name !== null && isPunct(tokens[k + 2], ']')) return { name, next: k + 3 };
    return null;
  } else return null;

  if (isPunct(tokens[k], '[')) {
    const name = stringValue(tokens[k + 1]);
    if (name !== null && isPunct(tokens[k + 2], ']')) return { name, next: k + 3 };
    return null;
  }
  const t = tokens[k];
  if (t?.kind === 'ident') return { name: t.value, next: k + 1 };
  return null;
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
}

/**
 * The code argument is a STRING — the implicit-eval timer form.
 *
 * An INTERPOLATED template counts: `setTimeout(\`evil(${v})\`, 0)` is still a
 * string the host compiles, so requiring a fully static literal would miss the
 * form an attacker is most likely to use.
 */
export const isStringLiteral = (arg: readonly Token[]): boolean =>
  arg.length > 0 && isStringToken(arg[0]);

/** The code argument is a string whose STATIC prefix names a REMOTE script. */
export const isRemoteUrl = (arg: readonly Token[]): boolean => {
  const value = stringPrefix(arg[0]);
  return value !== null && (/^https?:\/\//i.test(value) || value.startsWith('//'));
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
 * Names bound directly to a sink, so `const F = Function; F('x')()` is caught.
 *
 * Deliberately SIMPLE and flow-insensitive: it recognises `NAME = <sink
 * reference>` and treats the binding as holding for the whole file, iterating
 * to a fixpoint so an alias of an alias resolves too. That covers the form an
 * obfuscator or a careless commit actually produces.
 *
 * What it does NOT do, stated plainly rather than implied: destructuring
 * (`const { eval: e } = globalThis`), a sink stored in an object property or
 * array element, and anything requiring real scope analysis. Those need data
 * flow, not lexing. The CSP remains the runtime half in the browser; in
 * `apps/api`, where there is none, this is the reachable-spelling half.
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

function collectAliases(
  tokens: readonly Token[],
  specByName: ReadonlyMap<string, SinkSpec>,
  resolve: (i: number, aliases: ReadonlyMap<string, SinkSpec>) => SinkSpec | null,
): Map<string, SinkSpec> {
  const aliases = new Map<string, SinkSpec>();
  // A fixpoint: each pass can bind a name to a sink that the previous pass
  // only just learned about. Bounded because every pass either adds a binding
  // or stops.
  for (let pass = 0; pass < 8; pass += 1) {
    const before = aliases.size;
    for (let i = 0; i + 2 < tokens.length; i += 1) {
      const name = tokens[i];
      if (name?.kind !== 'ident' || specByName.has(name.value)) continue;
      const previous = tokens[i - 1];
      if (isPunct(previous, '.') || isPunct(previous, '?.')) continue;
      const initializer = initializerIndex(tokens, i);
      if (initializer === null) continue;
      const spec = resolve(initializer, aliases);
      if (spec) aliases.set(name.value, spec);
    }
    if (aliases.size === before) break;
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
  const referenceAt = (
    i: number,
    aliases: ReadonlyMap<string, SinkSpec>,
  ): { spec: SinkSpec; next: number } | null => {
    const t = tokens[i];
    if (t?.kind !== 'ident') return null;

    // `globalThis.eval`, `self['Function']`, `window?.setTimeout`
    if (GLOBAL_RECEIVERS.has(t.value)) {
      const member = readMember(tokens, i + 1);
      const spec = member ? specByName.get(member.name) : undefined;
      if (member && spec) return { spec, next: member.next };
      return null;
    }

    // The sink itself, or a NAME BOUND TO IT (`const F = Function`).
    const spec = specByName.get(t.value) ?? aliases.get(t.value);
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

  const record = (spec: SinkSpec, startTok: Token, endIndex: number): void => {
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
  const walkInvocation = (spec: SinkSpec, refStart: number, afterRef: number): void => {
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
        const args = callArguments(tokens, j);
        let arg = args[position.index] ?? [];
        if (position.inArray) {
          // `.apply(thisArg, ['code', …])` — the code is the array's head.
          const inner = arg[0] && isPunct(arg[0], '[') ? arg.slice(1) : [];
          arg = inner;
        }
        if (spec.codeArgument(arg))
          record(spec, tokens[refStart] as Token, end === -1 ? j + 1 : end);
        return;
      }
      const member = readMember(tokens, j);
      if (!member) return;
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
          const inner = first.length > 0 ? findReferenceIn(first, specByName, aliasMap) : null;
          if (inner) {
            const isConstruct = member.name === 'construct';
            // apply(fn, thisArg, [args]) → args are the 3rd; construct(fn, [args]) → 2nd.
            const argsArray = args[isConstruct ? 1 : 2] ?? [];
            const codeArg = argsArray[0] && isPunct(argsArray[0], '[') ? argsArray.slice(1) : [];
            const end = matchGroup(tokens, k);
            if (inner.codeArgument === undefined || inner.codeArgument(codeArg)) {
              record(inner, t, end === -1 ? k + 1 : end);
            }
          }
        }
      }
      continue;
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
  specByName: ReadonlyMap<string, SinkSpec>,
  aliases: ReadonlyMap<string, SinkSpec>,
): SinkSpec | null {
  const first = argument[0];
  if (first?.kind !== 'ident') return null;
  if (GLOBAL_RECEIVERS.has(first.value)) {
    const member = readMember(argument, 1);
    return member ? (specByName.get(member.name) ?? null) : null;
  }
  return specByName.get(first.value) ?? aliases.get(first.value) ?? null;
}
