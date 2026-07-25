// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The canonical DYNAMIC-CODE-SINK patterns, shared by every static gate that
// must reject runtime code evaluation:
//
//   • `lint:security`                  — the repository-wide source scan
//   • `check:sw`                       — the built service worker
//   • `check:update-channel`           — the private-mode update path's SW
//   • `check:private-bundle-transparency` — the private-mode bundle
//
// Owned HERE rather than copied into each gate because the four copies had
// already DIVERGED into a shared hole: every one of them pinned only
// `new Function(…)`, so the bare `Function(…)` call — which constructs the
// exact same function object, and is the form a minifier or an obfuscated
// payload naturally emits — passed all four gates untouched. A single
// definition means a sink closed here is closed everywhere at once.
//
// Deliberately DEPENDENCY-FREE (no zod, no `node:` builtins) so the
// `scripts`-rooted vitest project — which resolves no external packages —
// can unit test it directly.

/**
 * Whitespace and/or BLOCK COMMENTS that may legally sit between a callee and
 * its `(` — the separator every sink pattern uses in place of a bare `\s*`.
 *
 * Building the comment into the PATTERN is what makes these robust. A call can
 * be split by an interposed comment (`Function/*gap*\/('…')`), and the previous
 * design handled that by stripping comments first — which made every detection
 * depend on lexing the WHOLE FILE correctly, and review found three separate
 * ways to defeat that lexer (a `/*` inside a string, a `/` after `a++`, an
 * object literal inside a template interpolation). Matching the gap in place
 * needs no lexer at all, so a mis-lex can no longer hide a call.
 *
 * LINEARITY MATTERS HERE, and the first cut of this got it wrong: writing the
 * whitespace branch as `\s+` inside the outer `*` nests two quantifiers over
 * the same characters, so a long run of indentation followed by a non-match can
 * be split exponentially many ways. That took `lint:security` from ~2s to
 * unbounded (killed at 9+ minutes of 100% CPU on this repo).
 *
 * The safe form below consumes exactly ONE whitespace character per iteration,
 * so a whitespace run has a single possible split; the block-comment branch is
 * the standard unrolled (`[^*]*\*+(?:[^/*][^*]*\*+)*`) construction; and the
 * two alternatives are disjoint at their first character (`\s` vs `/`). With no
 * ambiguity at any step the match is linear, which `dangerous-code-patterns`
 * pins with a timing canary.
 */
const GAP = String.raw`(?:\s|/\*[^*]*\*+(?:[^/*][^*]*\*+)*/)*`;

/** Build a sink pattern from a template whose `~` placeholders become {@link GAP}. */
const sink = (source: string): RegExp => new RegExp(source.split('~').join(GAP));

/**
 * Every textual form that reaches the **Function constructor**, an
 * eval-equivalent sink. `Function(src)` and `new Function(src)` are the same
 * operation (the `new` is optional per ECMA-262), and the reference itself can
 * be reached indirectly — parenthesized, through the global object by dot or by
 * computed member access, called optionally, or invoked as a TEMPLATE TAG:
 *
 *     Function('…')             new Function('…')          Function?.('…')
 *     (Function)('…')           new (Function)('…')        (0, Function)('…')
 *     globalThis.Function('…')  window.Function('…')       self.Function('…')
 *     globalThis['Function']('…')                          self["Function"]('…')
 *     Function`…`()             — the tag form: the strings array is coerced
 *                                 with String(), so the template body becomes
 *                                 the function body and the trailing () runs it
 *     Function.call(null, '…')()          Function.apply(null, ['…'])()
 *     Function.bind(null)('…')()          Reflect.apply(Function, null, ['…'])()
 *
 * The direct pattern's lookbehind excludes a member/private access
 * (`.Function(`, `#Function(`) and word-suffix false positives (`getFunction(`,
 * `AsyncFunction(`), so the qualified and computed forms need their own
 * patterns — that lookbehind would otherwise skip them.
 *
 * The FUNCTION-METHOD forms are the reason the reference and the call have to
 * be matched separately. Every pattern above requires the reference to be
 * followed DIRECTLY by a call token, so interposing an inherited method
 * (`.call`/`.apply`/`.bind`, which every function object carries) defeated all
 * of them while still constructing and running the code — verified by
 * execution, all four returning 42. There is no legitimate use of these three
 * methods ON the `Function` constructor itself, so they are matched without
 * requiring an argument shape.
 *
 * SCOPE, stated honestly: this is a text scan, so it recognises the syntactic
 * forms an author or a minifier actually emits, not every semantically
 * equivalent route to the constructor (`[]['constructor']['constructor']`, a
 * name assembled at runtime, a reference stored in a variable first). Those are
 * unreachable by ANY regex; the runtime enforcement is the CSP, which ships
 * without `'unsafe-eval'` so the constructor throws in the browser however it
 * is spelled. This gate is the build-time half that keeps the reachable
 * spellings from landing in the first place — and it matters most in `apps/api`,
 * where there is no CSP behind it.
 */
export const FUNCTION_CONSTRUCTOR_PATTERNS: readonly RegExp[] = [
  // Direct call, with or without `new`, and with an optional call `?.()`.
  sink(String.raw`(?<![.\w$#])Function~(?:\?\.)?~\(`),
  // Reached through the global object by dot access.
  sink(String.raw`\b(?:globalThis|window|self)~\??\.~Function~(?:\?\.)?~[(\`]`),
  // Parenthesized reference: `(Function)('…')`, `new (Function)('…')`, and the
  // comma/sequence idiom `(0, Function)('…')`.
  sink(String.raw`\((?:[^()]*,~)?~Function~\)~(?:\?\.)?~[(\`]`),
  // Computed member access: `globalThis['Function']('…')`, `x["Function"](…)`.
  sink(String.raw`\[~(['"\`])Function\1~\]~(?:\?\.)?~[(\`]`),
  // Invoked through an inherited function method: `Function.call(null, '…')()`.
  sink(String.raw`(?<![.\w$#])Function~\.~(?:call|apply|bind)~(?:\?\.)?~\(`),
  // The same, qualified by a global receiver: `globalThis.Function.apply(…)`.
  sink(String.raw`\b(?:globalThis|window|self)~\??\.~Function~\.~(?:call|apply|bind)~(?:\?\.)?~\(`),
  // Reflective invocation: `Reflect.apply(Function, …)`, `Reflect.construct(Function, …)`.
  sink(String.raw`\bReflect~\.~(?:apply|construct)~\(~Function\b`),
];

/**
 * `Function` invoked as a TEMPLATE TAG: `` Function`body`() `` constructs the
 * same function object (the strings array is coerced with String()) and runs it.
 *
 * Held separately because it is COMMENT-SENSITIVE — prose that writes
 * `` `new Function` `` in markdown is textually identical — so it runs only
 * against comment-stripped source. (`eval` needs no equivalent: a tag receives
 * the strings ARRAY, and eval returns a non-string argument unchanged rather
 * than evaluating it — verified, not assumed.)
 */
export const FUNCTION_TAGGED_TEMPLATE_PATTERN = sink(String.raw`(?<![.\w$#])Function~\``);

/**
 * `eval` reached other than as a bare call. Each of these evaluates arbitrary
 * source, and several are the CANONICAL way to ask for *indirect* eval — which
 * runs in global scope rather than the caller's, if anything the worse of the
 * two:
 *
 *     (0, eval)('…')        the classic indirect-eval idiom
 *     (eval)('…')           parenthesized reference
 *     globalThis.eval('…')  window.eval('…')  self.eval('…')
 *     globalThis['eval']('…')                 eval?.('…')
 *     eval.call(null, '…')  eval.apply(null, ['…'])  Reflect.apply(eval, …)
 *
 * The bare {@link EVAL_PATTERN} deliberately excludes member access so a Redis
 * Lua wrapper (`redis.eval(script, 0)`) is not flagged; the GLOBAL-object
 * receivers are named explicitly here because those are never a library method.
 * The `.call`/`.apply` forms carry the SAME lookbehind for the same reason —
 * `redis.eval.call(…)` is a library method invocation, not a sink.
 */
export const INDIRECT_EVAL_PATTERNS: readonly RegExp[] = [
  // `(eval)('…')` and the sequence form `(0, eval)('…')`.
  sink(String.raw`\((?:[^()]*,~)?~eval~\)~(?:\?\.)?~\(`),
  sink(String.raw`\[~(['"\`])eval\1~\]~(?:\?\.)?~\(`),
  sink(String.raw`\b(?:globalThis|window|self)~\??\.~eval~(?:\?\.)?~\(`),
  // Optional call on the bare binding: `eval?.('…')`.
  sink(String.raw`(?<![.\w$#])eval~\?\.~\(`),
  // Invoked through an inherited function method: `eval.call(null, '…')`.
  sink(String.raw`(?<![.\w$#])eval~\.~(?:call|apply|bind)~(?:\?\.)?~\(`),
  sink(String.raw`\b(?:globalThis|window|self)~\??\.~eval~\.~(?:call|apply|bind)~(?:\?\.)?~\(`),
  // Reflective invocation: `Reflect.apply(eval, null, ['…'])`.
  sink(String.raw`\bReflect~\.~(?:apply|construct)~\(~eval\b`),
];

/** The two timer names that compile a string argument as source. */
const TIMER = 'set(?:Timeout|Interval)';

/**
 * `setTimeout`/`setInterval` with a STRING first argument — an implicit eval:
 * the host compiles the string exactly as `eval` would. A function argument
 * (the only legitimate use) never matches, because every pattern requires a
 * quote character in the first-argument position.
 *
 * The timer reference is reachable by the SAME indirections as `eval` and
 * `Function`, and the host compiles the string either way:
 *
 *     setTimeout('…')            setTimeout?.('…')
 *     globalThis.setTimeout('…')  window.setTimeout?.('…')
 *     (0, setTimeout)('…')        (setInterval)('…')
 *     globalThis['setTimeout']('…')            self["setInterval"]('…')
 *     setTimeout.call(window, '…', 0)  setTimeout.apply(window, ['…', 0])
 *
 * Covering only the bare `name(` form left the others passing every gate, so
 * the set mirrors {@link INDIRECT_EVAL_PATTERNS} rather than standing alone
 * — a sink closed for `eval` must be closed here too, or the shared list is
 * canonical in name only.
 *
 * The `.call`/`.apply` forms move the code to the SECOND argument, so unlike
 * `Function.call` they still have to pin the string's position: a timer really
 * is called with a function through `.call` in ordinary code, and a pattern
 * that flagged the shape alone would fire on `setTimeout.call(window, tick, 0)`.
 */
export const STRING_TIMER_PATTERNS: readonly RegExp[] = [
  // Direct or member call, with an optional call `?.()`:
  // `setTimeout('…')`, `setTimeout?.('…')`, `globalThis.setTimeout?.('…')`.
  sink(String.raw`\b${TIMER}~(?:\?\.)?~\(~['"\`]`),
  // Parenthesized reference and the comma/sequence idiom `(0, setTimeout)('…')`.
  sink(String.raw`\((?:[^()]*,~)?~${TIMER}~\)~(?:\?\.)?~\(~['"\`]`),
  // Computed member access: `globalThis['setTimeout']('…')`.
  sink(String.raw`\[~(['"\`])${TIMER}\1~\]~(?:\?\.)?~\(~['"\`]`),
  // `setTimeout.call(thisArg, '…')` — the code is the second argument.
  sink(String.raw`\b${TIMER}~\.~call~(?:\?\.)?~\(~[^,()]*,~['"\`]`),
  // `setTimeout.apply(thisArg, ['…', …])` — the code is the array's head.
  sink(String.raw`\b${TIMER}~\.~apply~(?:\?\.)?~\(~[^,()]*,~\[~['"\`]`),
];

/**
 * The bare global `eval(` call. The lookbehind excludes a member/private
 * access (`.eval(`, `#eval(` — e.g. a Redis Lua wrapper method), a `$eval(`
 * helper, and word-suffix false positives (`retrieval(`, `medieval(`).
 * Source-tree gates want this narrow form; a gate scanning BUILT output should
 * prefer {@link EVAL_PATTERN_STRICT}.
 */
export const EVAL_PATTERN = sink(String.raw`(?<![.\w$#])eval~\(`);

/**
 * The strict `eval(` form used over BUILT artifacts (service worker, bundle),
 * where a member call such as `x.eval(` has no legitimate meaning either and
 * a bundler may have rewritten the reference.
 */
export const EVAL_PATTERN_STRICT = sink(String.raw`\beval~\(`);

export interface CodeSinkPattern {
  readonly pattern: RegExp;
  /** Short human label naming the sink (gates wrap this in their own phrasing). */
  readonly label: string;
  /**
   * True when the pattern cannot safely run over RAW text because prose can
   * spell it. Only the tagged-template form is like this: a doc comment that
   * writes `` `new Function` `` in markdown puts a backtick straight after the
   * word, which is textually identical to a template tag. Such patterns are
   * applied to the COMMENT-STRIPPED copy only.
   */
  readonly commentSensitive?: boolean;
}

/**
 * The complete dynamic-code-sink set for a SOURCE-tree scan: the narrow `eval`
 * form plus every Function-constructor form plus the string-timer implicit eval.
 */
export const SOURCE_CODE_SINKS: readonly CodeSinkPattern[] = [
  { pattern: EVAL_PATTERN, label: 'eval()' },
  ...INDIRECT_EVAL_PATTERNS.map((pattern) => ({ pattern, label: 'indirect eval()' })),
  ...FUNCTION_CONSTRUCTOR_PATTERNS.map((pattern) => ({
    pattern,
    label: 'Function() constructor (equivalent to eval)',
  })),
  ...STRING_TIMER_PATTERNS.map((pattern) => ({
    pattern,
    label: 'setTimeout/setInterval with a string body (implicit eval)',
  })),
  {
    pattern: FUNCTION_TAGGED_TEMPLATE_PATTERN,
    label: 'Function() constructor (equivalent to eval) as a template tag',
    commentSensitive: true,
  },
];

/**
 * The same set for a BUILT-artifact scan (service worker / bundle): identical
 * except that `eval` is matched in its strict form.
 */
export const BUILT_CODE_SINKS: readonly CodeSinkPattern[] = [
  { pattern: EVAL_PATTERN_STRICT, label: 'eval()' },
  ...INDIRECT_EVAL_PATTERNS.map((pattern) => ({ pattern, label: 'indirect eval()' })),
  ...FUNCTION_CONSTRUCTOR_PATTERNS.map((pattern) => ({
    pattern,
    label: 'Function() constructor',
  })),
  ...STRING_TIMER_PATTERNS.map((pattern) => ({
    pattern,
    label: 'setTimeout/setInterval with a string body (implicit eval)',
  })),
  {
    pattern: FUNCTION_TAGGED_TEMPLATE_PATTERN,
    label: 'Function() constructor as a template tag',
    commentSensitive: true,
  },
];

/** Keywords after which a `/` begins a REGEX literal rather than a division. */
const KEYWORDS_BEFORE_REGEX = new Set([
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

/**
 * Blank out COMMENTS so gate doctrine may be DISCUSSED in prose ("no eval
 * here") while a real call still trips the scan.
 *
 * STRING-AWARE, and that is the whole point rather than a refinement. A
 * regex-based strip treats comment delimiters that appear INSIDE string
 * literals as real delimiters, so
 *
 *     const start = "/*"; eval("payload"); const end = "*\/";
 *
 * collapses to `const start = " ";` — the strip itself HIDES the `eval` from
 * every gate that consumes it. That is strictly worse than not stripping at
 * all, so this walks the source instead: single/double-quoted strings,
 * template literals (tracking `${…}` nesting, which can hold further strings
 * and comments), and regex literals are skipped intact; only true comment
 * spans are blanked.
 *
 * LENGTH- AND NEWLINE-PRESERVING: every blanked character becomes a space and
 * newlines are kept, so the result is the same length as the input and each
 * character keeps its original offset and line. Gates report `file:line` and
 * can therefore map a match index straight back to the source.
 *
 * The one construct not disambiguated perfectly is `/` as division versus a
 * regex literal — that needs a real parser. The heuristic below (a regex may
 * follow an operator, a punctuator, or one of the keywords above, but not an
 * identifier, literal, `)`, `]`, or `}`) is the standard one and is exercised
 * against the whole repository by the gate's own run.
 */
export function stripComments(source: string): string {
  const out = source.split('');
  const n = source.length;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };

  /** Does the `/` at `at` open a regex literal (rather than divide)? */
  const opensRegex = (at: number): boolean => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(source[k] as string)) k -= 1;
    if (k < 0) return true;
    const prev = source[k] as string;
    if (/[)\]}]/.test(prev)) return false;
    // POSTFIX `++`/`--` yields a value, so the `/` after it divides. Looking at
    // the previous CHARACTER alone gets this wrong: `+` is an operator (a regex
    // may follow `a + /re/`), but `++` is not (`a++ / b` is a division).
    if ((prev === '+' || prev === '-') && source[k - 1] === prev) return false;
    if (/[A-Za-z0-9_$]/.test(prev)) {
      let s = k;
      while (s >= 0 && /[A-Za-z0-9_$]/.test(source[s] as string)) s -= 1;
      return KEYWORDS_BEFORE_REGEX.has(source.slice(s + 1, k + 1));
    }
    return true;
  };

  // Template-literal `${…}` spans push a BRACE-DEPTH counter onto this stack.
  // Tracking depth (not merely presence) is required: an interpolation may hold
  // an object literal or a block, and treating its first `}` as the end of the
  // interpolation resumes template scanning early — which swallowed a later
  // comment and hid the call after it.
  const templateStack: number[] = [];
  let i = 0;
  while (i < n) {
    const c = source[i] as string;
    const two = source.slice(i, i + 2);

    if (two === '//') {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (two === '/*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      i += 1;
      while (i < n) {
        const ch = source[i] as string;
        if (ch === '\\') i += 2;
        else if (ch === c) {
          i += 1;
          break;
        } else if (ch === '\n')
          break; // unterminated: do not run past the line
        else i += 1;
      }
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < n) {
        const ch = source[i] as string;
        if (ch === '\\') i += 2;
        else if (ch === '`') {
          i += 1;
          break;
        } else if (ch === '$' && source[i + 1] === '{') {
          // Enter an interpolation: ordinary scanning resumes inside it, at
          // brace depth 0.
          templateStack.push(0);
          i += 2;
          break;
        } else i += 1;
      }
      continue;
    }
    // Inside an interpolation, a nested `{` must be balanced before the `}`
    // that actually closes it.
    if (c === '{' && templateStack.length > 0) {
      templateStack[templateStack.length - 1] = (templateStack.at(-1) as number) + 1;
      i += 1;
      continue;
    }
    if (c === '}' && templateStack.length > 0) {
      const depth = templateStack.at(-1) as number;
      if (depth > 0) {
        templateStack[templateStack.length - 1] = depth - 1;
        i += 1;
        continue;
      }
      templateStack.pop();
      // Resume the enclosing template literal after the interpolation closes.
      i += 1;
      while (i < n) {
        const ch = source[i] as string;
        if (ch === '\\') i += 2;
        else if (ch === '`') {
          i += 1;
          break;
        } else if (ch === '$' && source[i + 1] === '{') {
          templateStack.push(0);
          i += 2;
          break;
        } else i += 1;
      }
      continue;
    }
    if (c === '/' && opensRegex(i)) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const ch = source[i] as string;
        if (ch === '\\') i += 2;
        else if (ch === '[') {
          inClass = true;
          i += 1;
        } else if (ch === ']') {
          inClass = false;
          i += 1;
        } else if (ch === '/' && !inClass) {
          i += 1;
          break;
        } else if (ch === '\n')
          break; // unterminated: not a regex after all
        else i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** One sink match, with the 1-based line it sits on (for `file:line` output). */
export interface SinkMatch {
  readonly label: string;
  readonly line: number;
}

/**
 * THE entry point every source-tree gate should use: scan a file for sinks in a
 * way no comment-stripping bug can defeat.
 *
 * The strip is deliberately NOT load-bearing here. It is scanned IN ADDITION to
 * the raw source, and the results are unioned:
 *
 *   • the RAW pass guarantees that however the strip mis-lexes a construct —
 *     a regex-versus-division call, an exotic template nesting, a form nobody
 *     has thought of yet — it can never DELETE a sink from view. Every
 *     regression found on PR #169 was of exactly that shape: a strip that hid
 *     the call it was supposed to reveal.
 *   • the STRIPPED pass adds the one thing the raw pass cannot see: a call
 *     split by an interposed comment, `Function/*gap*\/('…')`.
 *
 * The cost is that a sink call written literally inside a COMMENT is reported.
 * That is the right trade: it is trivially fixed by rewording the comment,
 * whereas the opposite failure silently disarms the gate. (Before the strip
 * existed this gate already scanned raw source and passed, so no such comment
 * exists in the scanned trees today.)
 */
export function scanSourceForSinks(
  source: string,
  sinks: readonly CodeSinkPattern[] = SOURCE_CODE_SINKS,
): SinkMatch[] {
  const seen = new Set<string>();
  const merged: SinkMatch[] = [];
  // Comment-sensitive patterns are excluded from the RAW pass: prose can spell
  // them, and a false positive on a doc comment would be a gate nobody trusts.
  const rawSafe = sinks.filter((s) => s.commentSensitive !== true);
  for (const match of [
    ...findSinkMatches(source, rawSafe),
    ...findSinkMatches(stripComments(source), sinks),
  ]) {
    const key = `${match.line}:${match.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(match);
  }
  return merged.sort((a, b) => a.line - b.line || a.label.localeCompare(b.label));
}

/**
 * Find every sink match in a WHOLE source text, reporting the line of each.
 *
 * Scanning the whole text — not line by line — is what makes the patterns'
 * `\s*` meaningful: `Function\n('x')` and `(Function)\n('x')` are legal calls,
 * and a per-line scan can never match them however permissive the pattern is.
 * Offsets are converted to line numbers only for reporting.
 *
 * `code` is expected to be {@link stripComments} output, which preserves both
 * length and newlines, so a match index maps to the original file's line.
 */
export function findSinkMatches(
  code: string,
  sinks: readonly CodeSinkPattern[] = SOURCE_CODE_SINKS,
): SinkMatch[] {
  const matches: SinkMatch[] = [];
  // Precompute newline offsets once: line = (count of newlines before index) + 1.
  const newlines: number[] = [];
  for (let k = 0; k < code.length; k += 1) if (code[k] === '\n') newlines.push(k);
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((newlines[mid] as number) < index) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  for (const { pattern, label } of sinks) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    );
    for (const match of code.matchAll(global)) {
      if (match.index !== undefined) matches.push({ label, line: lineOf(match.index) });
    }
  }
  return matches.sort((a, b) => a.line - b.line);
}
