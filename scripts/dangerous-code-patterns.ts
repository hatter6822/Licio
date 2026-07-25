// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The canonical DYNAMIC-CODE-SINK definitions, shared by every static gate that
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
// HOW THE SINKS ARE DETECTED — not by regex. Review of PR #169 found a new
// bypass SPELLING on six consecutive rounds (`Function['call'](…)`,
// `Reflect['apply'](…)`, `globalThis.Function?.call(…)`, computed timer
// methods, …) because "an expression that evaluates to a sink and is then
// INVOKED" is a structural property no regex can express. Detection therefore
// lives in `js-sink-analyzer.ts`, which tokenises and walks the access chain;
// this module only declares WHICH names are sinks and which argument makes an
// invocation dangerous.
//
// The regex machinery below is retained ONLY for the textual DOM sinks
// (`innerHTML =`, `javascript:` URLs). Those have no call chain to walk, so
// they have no equivalent class of spellings and a pattern is the right tool.
//
// Deliberately DEPENDENCY-FREE (no zod, no `node:` builtins) so the
// `scripts`-rooted vitest project — which resolves no external packages —
// can unit test it directly.

import type { MemberSinkSpec, SinkSpec } from './js-sink-analyzer.js';
import { findSinkInvocations, isNonSameOriginUrl, isStringLiteral } from './js-sink-analyzer.js';

export type { MemberSinkSpec, SinkSpec, Token } from './js-sink-analyzer.js';
export {
  findMemberSinkUses,
  findSinkInvocations,
  isNonSameOriginUrl,
  isStringLiteral,
  tokenize,
} from './js-sink-analyzer.js';

/**
 * The dynamic-code sinks. `eval` and the `Function` constructor evaluate
 * whatever they are handed, so ANY invocation counts; the timers compile their
 * argument only when it is a STRING, so `setTimeout(fn, 0)` stays clean.
 *
 * There is no longer a separate "strict" variant for built artifacts. That
 * existed to also match `x.eval(`, on the theory a bundler might rewrite the
 * reference — but a minifier emits `eval(` for a global eval call, so it caught
 * nothing real while matching prose such as "no remote code, no eval
 * (WS-C.2.1d)", which is precisely the false positive it produced against the
 * shipped service worker. The analyzer separates a global sink from somebody
 * else's property structurally, so the heuristic is no longer needed.
 */
export const DYNAMIC_CODE_SINKS: readonly SinkSpec[] = [
  { name: 'eval', label: 'eval()' },
  { name: 'Function', label: 'Function() constructor (equivalent to eval)' },
  {
    name: 'setTimeout',
    label: 'setTimeout/setInterval with a string body (implicit eval)',
    codeArgument: isStringLiteral,
  },
  {
    name: 'setInterval',
    label: 'setTimeout/setInterval with a string body (implicit eval)',
    codeArgument: isStringLiteral,
  },
];

/**
 * `importScripts` loading anything that is NOT same-origin — foreign CODE.
 *
 * VARIADIC: it loads every URL it is handed, so a same-origin first argument
 * does not make the call safe — `importScripts('/local.js', 'https://evil/x.js')`
 * fetches remote code. Each argument is judged.
 */
export const REMOTE_IMPORT_SCRIPTS_SINK: SinkSpec = {
  name: 'importScripts',
  label: 'external importScripts (remote code)',
  codeArgument: isNonSameOriginUrl,
  variadic: true,
};

/**
 * A dynamic `import()` of a non-same-origin URL — remote code, loaded and run.
 *
 * `import` lexes as an identifier, so the analyzer walks it like any other
 * callee and the specifier gets the same constant folding every other argument
 * does: `import('ht' + 'tps://evil/x.js')` is the same module load as the
 * unsplit literal, and a pattern anchored on the scheme could not see it.
 * A STATIC `import … from '…'` is not a CALL, so it never matches.
 */
export const REMOTE_DYNAMIC_IMPORT_SINK: SinkSpec = {
  name: 'import',
  label: 'dynamic import() of a remote URL',
  codeArgument: isNonSameOriginUrl,
};

/**
 * The sink set for a SOURCE-tree scan and for a BUILT-artifact scan. They are
 * now IDENTICAL (see the note on the strict `eval` variant above) and kept as
 * two names only so each gate reads clearly at its own call site.
 */
export const SOURCE_CODE_SINKS: readonly SinkSpec[] = DYNAMIC_CODE_SINKS;
export const BUILT_CODE_SINKS: readonly SinkSpec[] = DYNAMIC_CODE_SINKS;

/** A finding: the sink's human label and the 1-based line it starts on. */
export interface SinkMatch {
  readonly label: string;
  readonly line: number;
}

/**
 * Find dynamic-code sink INVOCATIONS in `source`.
 *
 * A thin wrapper over the analyzer so the gates share one entry point.
 * Comments can never produce a finding — the tokeniser discards them — so
 * doctrine may be discussed in prose, and no comment-stripping pass is
 * load-bearing for detection.
 */
export function findDynamicCodeSinks(
  source: string,
  sinks: readonly SinkSpec[] = DYNAMIC_CODE_SINKS,
): SinkMatch[] {
  return findSinkInvocations(source, sinks).map(({ label, line }) => ({ label, line }));
}

/**
 * The DOM sinks named by a PROPERTY. Walked structurally, not matched: a
 * pattern anchored on `.innerHTML` reads only the dotted spelling, so
 * `node['innerHTML'] = payload` and `document['write'](payload)` reached the
 * same sinks past a merge-blocking XSS gate.
 */
export const DOM_MEMBER_SINKS: readonly MemberSinkSpec[] = [
  { property: 'innerHTML', form: 'assign', label: 'Direct innerHTML assignment (use DOMPurify)' },
  { property: 'outerHTML', form: 'assign', label: 'Direct outerHTML assignment' },
  { receiver: 'document', property: 'write', form: 'call', label: 'document.write() call' },
  { receiver: 'document', property: 'writeln', form: 'call', label: 'document.writeln() call' },
];

// ---------------------------------------------------------------------------
// Textual sinks. A `javascript:` URL is string CONTENT with no call chain, so
// a pattern remains the right tool for it.
// ---------------------------------------------------------------------------

export interface CodeSinkPattern {
  readonly pattern: RegExp;
  /** Short human label naming the sink (gates wrap this in their own phrasing). */
  readonly label: string;
}

/** Keywords after which a `/` begins a REGEX literal rather than a division. */
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

/**
 * Blank out COMMENTS so doctrine may be DISCUSSED in prose while real code
 * still trips a scan.
 *
 * NO LONGER LOAD-BEARING FOR SINK DETECTION — the analyzer discards comments
 * while tokenising, which is correct by construction rather than by heuristic.
 * This remains for the gates' MARKER checks (`check:update-channel` requires
 * certain identifiers to be present as real wiring, not merely mentioned in a
 * comment) and for the textual DOM patterns above.
 *
 * LENGTH- AND NEWLINE-PRESERVING: every blanked character becomes a space and
 * newlines are kept, so a match index still maps back to its original line.
 */
export function stripComments(source: string, preferRegex = false): string {
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
    // Ambiguous without a parser (`if (ok) /re/` vs `(a) / b`); `preferRegex`
    // flips the guess so a caller can scan both readings.
    if (/[)\]}]/.test(prev)) return preferRegex;
    // POSTFIX `++`/`--` yields a value, so a `/` after it divides.
    if ((prev === '+' || prev === '-') && source[k - 1] === prev) return false;
    if (/[A-Za-z0-9_$]/.test(prev)) {
      let s = k;
      while (s >= 0 && /[A-Za-z0-9_$]/.test(source[s] as string)) s -= 1;
      const word = source.slice(s + 1, k + 1);
      return KEYWORDS_BEFORE_REGEX.has(word) ? true : preferRegex;
    }
    return true;
  };

  // Template-literal `${…}` spans push a BRACE-DEPTH counter onto this stack;
  // tracking depth (not merely presence) keeps an object literal inside an
  // interpolation from ending the interpolation early.
  const templateStack: number[] = [];

  /** Scan forward from inside a template literal body. */
  const resumeTemplate = (from: number): number => {
    let k = from;
    while (k < n) {
      const ch = source[k] as string;
      if (ch === '\\') k += 2;
      else if (ch === '`') return k + 1;
      else if (ch === '$' && source[k + 1] === '{') {
        templateStack.push(1);
        return k + 2;
      } else k += 1;
    }
    return n;
  };

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
        } else if (ch === '\n') break;
        else i += 1;
      }
      continue;
    }
    if (c === '`') {
      i = resumeTemplate(i + 1);
      continue;
    }
    if (c === '{' && templateStack.length > 0) {
      templateStack.push((templateStack.pop() as number) + 1);
      i += 1;
      continue;
    }
    if (c === '}' && templateStack.length > 0) {
      const depth = (templateStack.pop() as number) - 1;
      if (depth > 0) {
        templateStack.push(depth);
        i += 1;
        continue;
      }
      i = resumeTemplate(i + 1);
      continue;
    }
    if (c === '/' && opensRegex(i)) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const ch = source[i] as string;
        if (ch === '\\') i += 2;
        else if (ch === '\n') break;
        else if (ch === '[') {
          inClass = true;
          i += 1;
        } else if (ch === ']') {
          inClass = false;
          i += 1;
        } else if (ch === '/' && !inClass) {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Find matches of TEXTUAL patterns across the whole file, reporting the line
 * each match starts on.
 *
 * Whole-text rather than per-line: a pattern may span a newline, which a
 * line-by-line scan can never match. Both lexings of the ambiguous `/` are
 * scanned and unioned so a lexer guess cannot hide a match.
 */
export function scanSourceForSinks(
  source: string,
  patterns: readonly CodeSinkPattern[],
): SinkMatch[] {
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

  const seen = new Set<string>();
  const matches: SinkMatch[] = [];
  for (const text of [stripComments(source), stripComments(source, true)]) {
    for (const { pattern, label } of patterns) {
      const global = new RegExp(
        pattern.source,
        pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
      );
      for (const match of text.matchAll(global)) {
        if (match.index === undefined) continue;
        const line = lineOf(match.index);
        const key = `${line}:${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({ label, line });
      }
    }
  }
  return matches.sort((a, b) => a.line - b.line || a.label.localeCompare(b.label));
}
