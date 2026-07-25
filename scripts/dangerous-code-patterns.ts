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
 * Every textual form that reaches the **Function constructor**, an
 * eval-equivalent sink. `Function(src)` and `new Function(src)` are the same
 * operation (the `new` is optional per ECMA-262), and the reference itself can
 * be reached indirectly — parenthesized, through the global object by dot OR
 * by computed member access:
 *
 *     Function('…')            new Function('…')
 *     (Function)('…')          new (Function)('…')
 *     globalThis.Function('…')  window.Function('…')  self.Function('…')
 *     globalThis['Function']('…')                     self["Function"]('…')
 *
 * The direct pattern's lookbehind excludes a member/private access
 * (`.Function(`, `#Function(`) and word-suffix false positives (`getFunction(`,
 * `AsyncFunction(`), so the qualified and computed forms need their own
 * patterns — that lookbehind would otherwise skip them.
 *
 * SCOPE, stated honestly: this is a text scan, so it recognises the syntactic
 * forms an author or a minifier actually emits, not every semantically
 * equivalent route to the constructor (`Reflect.construct(Function, …)`,
 * `[]['constructor']['constructor']`, a name assembled at runtime). Those are
 * unreachable by ANY regex; the runtime enforcement is the CSP, which ships
 * without `'unsafe-eval'` so the constructor throws in the browser however it
 * is spelled. This gate is the build-time half that keeps the obvious routes
 * from landing in the first place.
 */
export const FUNCTION_CONSTRUCTOR_PATTERNS: readonly RegExp[] = [
  /(?<![.\w$#])Function\s*\(/,
  /\b(?:globalThis|window|self)\s*\.\s*Function\s*\(/,
  // Parenthesized reference: `(Function)('…')` and `new (Function)('…')`.
  /\(\s*Function\s*\)\s*\(/,
  // Computed member access: `globalThis['Function']('…')`, `x["Function"](…)`.
  /\[\s*(['"`])Function\1\s*\]\s*\(/,
];

/**
 * The same indirection applied to `eval`: a parenthesized or computed reference
 * reaches the same sink. (Indirect eval runs in global scope rather than the
 * caller's, which is if anything the more dangerous of the two.)
 */
export const INDIRECT_EVAL_PATTERNS: readonly RegExp[] = [
  /\(\s*eval\s*\)\s*\(/,
  /\[\s*(['"`])eval\1\s*\]\s*\(/,
];

/**
 * `setTimeout`/`setInterval` with a STRING first argument — an implicit eval:
 * the host compiles the string exactly as `eval` would. A function argument
 * (the only legitimate use) never matches, because the pattern requires a
 * quote character in the first-argument position.
 */
export const STRING_TIMER_PATTERN = /\bset(?:Timeout|Interval)\s*\(\s*['"`]/;

/**
 * The bare global `eval(` call. The lookbehind excludes a member/private
 * access (`.eval(`, `#eval(` — e.g. a Redis Lua wrapper method), a `$eval(`
 * helper, and word-suffix false positives (`retrieval(`, `medieval(`).
 * Source-tree gates want this narrow form; a gate scanning BUILT output should
 * prefer {@link EVAL_PATTERN_STRICT}.
 */
export const EVAL_PATTERN = /(?<![.\w$#])eval\s*\(/;

/**
 * The strict `eval(` form used over BUILT artifacts (service worker, bundle),
 * where a member call such as `x.eval(` has no legitimate meaning either and
 * a bundler may have rewritten the reference.
 */
export const EVAL_PATTERN_STRICT = /\beval\s*\(/;

export interface CodeSinkPattern {
  readonly pattern: RegExp;
  /** Short human label naming the sink (gates wrap this in their own phrasing). */
  readonly label: string;
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
  {
    pattern: STRING_TIMER_PATTERN,
    label: 'setTimeout/setInterval with a string body (implicit eval)',
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
  {
    pattern: STRING_TIMER_PATTERN,
    label: 'setTimeout/setInterval with a string body (implicit eval)',
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
    if (/[A-Za-z0-9_$]/.test(prev)) {
      let s = k;
      while (s >= 0 && /[A-Za-z0-9_$]/.test(source[s] as string)) s -= 1;
      return KEYWORDS_BEFORE_REGEX.has(source.slice(s + 1, k + 1));
    }
    return true;
  };

  // Template-literal `${…}` spans push onto this stack; a `}` at depth pops
  // back into the enclosing template.
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
          // Enter an interpolation: ordinary scanning resumes inside it.
          templateStack.push(1);
          i += 2;
          break;
        } else i += 1;
      }
      continue;
    }
    if (c === '}' && templateStack.length > 0) {
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
          templateStack.push(1);
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
