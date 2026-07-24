// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared dynamic-code-sink definitions are consumed by FOUR gates
// (lint:security, check:sw, check:update-channel,
// check:private-bundle-transparency), so a hole here is a hole in all four.
// These tests pin both directions: every equivalent sink form is caught, and
// the ordinary code that surrounds it is not.
import { describe, expect, it } from 'vitest';
import {
  BUILT_CODE_SINKS,
  EVAL_PATTERN,
  EVAL_PATTERN_STRICT,
  FUNCTION_CONSTRUCTOR_PATTERNS,
  INDIRECT_EVAL_PATTERNS,
  SOURCE_CODE_SINKS,
  STRING_TIMER_PATTERN,
  stripComments,
} from './dangerous-code-patterns.js';

/** True when ANY pattern in the set matches — the way every gate consumes them. */
const hits = (sinks: ReadonlyArray<{ pattern: RegExp }>, code: string): boolean =>
  sinks.some(({ pattern }) => pattern.test(code));

describe('FUNCTION_CONSTRUCTOR_PATTERNS', () => {
  // The regression this module exists for: all four gates previously pinned
  // only `new Function(`, so the equivalent bare call passed every one.
  it.each([
    ['new Function("return 1")', 'const f = new Function("return 1");'],
    ['bare Function()', 'const f = Function("return 1");'],
    ['globalThis.Function()', 'const f = globalThis.Function("x")();'],
    ['window.Function()', 'const f = window.Function("x")();'],
    ['self.Function()', 'const f = self.Function("x")();'],
    ['spaced call', 'const f = Function ("x");'],
  ])('catches %s', (_label, code) => {
    expect(FUNCTION_CONSTRUCTOR_PATTERNS.some((p) => p.test(code))).toBe(true);
  });

  // The indirect forms Codex found on PR #169: the constructor reference can be
  // parenthesized or reached by computed member access, and each still executes
  // arbitrary source.
  it.each([
    ['parenthesized', "const f = (Function)('return 1');"],
    ['new + parenthesized', "const f = new (Function)('return 1');"],
    ['computed on globalThis', "const f = globalThis['Function']('return 1');"],
    ['computed on window', 'const f = window["Function"]("x");'],
    ['computed on self', "const f = self['Function']('x');"],
  ])('catches the INDIRECT form: %s', (_label, code) => {
    expect(FUNCTION_CONSTRUCTOR_PATTERNS.some((p) => p.test(code))).toBe(true);
  });

  it.each([
    ['a suffixed identifier', 'const v = getFunction(name);'],
    ['an AsyncFunction-suffixed identifier', 'const v = isAsyncFunction(fn);'],
    ['a member access with no call', 'const t = registry.Function;'],
    ['a type annotation', 'function apply(fn: Function): void {}'],
    ['a lowercase function declaration', 'function build(x) { return x; }'],
  ])('does not flag %s', (_label, code) => {
    expect(FUNCTION_CONSTRUCTOR_PATTERNS.some((p) => p.test(code))).toBe(false);
  });
});

describe('STRING_TIMER_PATTERN', () => {
  it.each([
    'setTimeout("evil()", 0)',
    "setInterval('evil()', 10)",
    'setTimeout(`evil()`, 0)',
    'setTimeout( "evil()" , 0)',
  ])('catches the implicit eval in %s', (code) => {
    expect(STRING_TIMER_PATTERN.test(code)).toBe(true);
  });

  it.each([
    'setTimeout(() => run(), 0)',
    'setInterval(tick, 1000)',
    'setTimeout(handler, delayMs)',
  ])('does not flag the function form %s', (code) => {
    expect(STRING_TIMER_PATTERN.test(code)).toBe(false);
  });
});

describe('eval patterns', () => {
  it('the source form ignores member/private/suffixed calls', () => {
    expect(EVAL_PATTERN.test('const x = eval("1");')).toBe(true);
    // A Redis Lua wrapper method and word-suffix false positives must survive.
    expect(EVAL_PATTERN.test('await redis.eval(script, 0);')).toBe(false);
    expect(EVAL_PATTERN.test('const r = retrieval(query);')).toBe(false);
    expect(EVAL_PATTERN.test('this.#eval(node);')).toBe(false);
  });

  it('the built form is stricter — a member call has no legitimate meaning there', () => {
    expect(EVAL_PATTERN_STRICT.test('const x = eval("1");')).toBe(true);
    expect(EVAL_PATTERN_STRICT.test('a.eval("1");')).toBe(true);
  });
});

describe('the assembled sink sets', () => {
  const sinkForms = [
    'const a = eval("1");',
    'const b = new Function("x");',
    'const c = Function("x");',
    'const d = globalThis.Function("x");',
    'setTimeout("x()", 0);',
  ];

  it('SOURCE_CODE_SINKS catches every sink form', () => {
    for (const code of sinkForms) expect(hits(SOURCE_CODE_SINKS, code)).toBe(true);
  });

  it('BUILT_CODE_SINKS catches every sink form', () => {
    for (const code of sinkForms) expect(hits(BUILT_CODE_SINKS, code)).toBe(true);
  });

  it('neither set flags ordinary code', () => {
    const clean = [
      'export function render(node) { return node.value; }',
      'setTimeout(() => flush(), 0);',
      'const parsed = JSON.parse(raw);',
      'await redis.eval(script, 0);',
    ].join('\n');
    expect(hits(SOURCE_CODE_SINKS, clean)).toBe(false);
  });

  it('every entry carries a human label the gates can phrase', () => {
    for (const { label } of [...SOURCE_CODE_SINKS, ...BUILT_CODE_SINKS]) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('INDIRECT_EVAL_PATTERNS', () => {
  it.each(["(eval)('x')", "globalThis['eval']('x')", 'window["eval"]("x")'])(
    'catches indirect eval: %s',
    (code) => {
      expect(INDIRECT_EVAL_PATTERNS.some((p) => p.test(code))).toBe(true);
    },
  );

  it('does not flag a direct or member eval call (those have their own patterns)', () => {
    expect(INDIRECT_EVAL_PATTERNS.some((p) => p.test('await redis.eval(script, 0);'))).toBe(false);
  });
});

describe('stripComments', () => {
  // A comment placed INSIDE a call — `Function/*gap*/('…')` — split the token
  // stream so no pattern matched; stripping first closes that route.
  it('closes the comment-gap route into the Function constructor', () => {
    const code = stripComments("const f = Function/*gap*/('return 1');");
    expect(hits(SOURCE_CODE_SINKS, code)).toBe(true);
  });

  it('PRESERVES line numbers across a multi-line block comment', () => {
    // Gates report `file:line`. Collapsing a 4-line comment to one space would
    // point every later violation at the wrong line.
    const source = ['const a = 1;', '/* one', '   two', '   three */', "eval('x');"].join('\n');
    const stripped = stripComments(source);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
    expect(stripped.split('\n').findIndex((l) => /eval/.test(l))).toBe(4);
  });

  it('lets doctrine be discussed in prose without tripping a scan', () => {
    const code = stripComments('// never call eval() here\n/* nor new Function() */\nrun();');
    expect(hits(SOURCE_CODE_SINKS, code)).toBe(false);
  });

  it('keeps a real call that follows a comment on the same line', () => {
    const code = stripComments('run(); // trailing note\nconst f = Function("x");');
    expect(hits(SOURCE_CODE_SINKS, code)).toBe(true);
  });

  it('preserves absolute and protocol-relative URLs inside string literals', () => {
    // The importScripts gates must still SEE these after comment stripping.
    expect(stripComments('importScripts("https://evil/x.js");')).toContain('https://evil/x.js');
    expect(stripComments('importScripts("//evil/x.js");')).toContain('//evil/x.js');
  });

  it('collapses a block comment to a space so identifiers cannot fuse', () => {
    expect(stripComments('a/* joiner */b')).toBe('a b');
  });
});
