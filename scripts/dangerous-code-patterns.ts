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
 * eval-equivalent sink: `Function(src)` and `new Function(src)` are the same
 * operation (the `new` is optional per ECMA-262), and `globalThis.Function(src)`
 * / `window.Function(src)` / `self.Function(src)` reach it through the global
 * object.
 *
 * The first pattern's lookbehind excludes a member/private access (`.Function(`,
 * `#Function(`) and word-suffix false positives (`getFunction(`,
 * `AsyncFunction(`) so only a real constructor call is flagged; the qualified
 * global forms are matched explicitly by the second pattern precisely because
 * that lookbehind would otherwise skip them.
 */
export const FUNCTION_CONSTRUCTOR_PATTERNS: readonly RegExp[] = [
  /(?<![.\w$#])Function\s*\(/,
  /\b(?:globalThis|window|self)\s*\.\s*Function\s*\(/,
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
 * literal survive for the importScripts checks that need to see them. Block
 * comments collapse to a SPACE rather than nothing, so `a/**\/b` cannot fuse
 * two identifiers into one.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}
