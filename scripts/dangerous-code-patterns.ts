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

/**
 * Strip block + line comments so gate doctrine may be DISCUSSED in prose (e.g.
 * "no eval here") while a real call still trips the scan.
 *
 * The line-comment rule ignores a `//` preceded by `:` or by a quote, so both
 * an absolute `https://…` URL and a protocol-relative `"//host/x.js"` string
 * literal survive for the importScripts checks that need to see them.
 *
 * A block comment is replaced by a SPACE when it sits on one line, so
 * `a/**\/b` cannot fuse into a single token — and by its own NEWLINES when it
 * spans several, so every later line keeps its original number. Gates report
 * `file:line`, and collapsing a 20-line licence header to one space would have
 * pointed every subsequent violation at the wrong line.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => {
      const newlines = match.match(/\n/g)?.length ?? 0;
      return newlines === 0 ? ' ' : '\n'.repeat(newlines);
    })
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}
