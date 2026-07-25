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
  findSinkMatches,
  INDIRECT_EVAL_PATTERNS,
  SOURCE_CODE_SINKS,
  STRING_TIMER_PATTERN,
  scanSourceForSinks,
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

  // Round-3 indirections: dot-qualified on a global, optional call, and the
  // comma/sequence idiom.
  it.each([
    ['optional call', "const f = Function?.('x');"],
    ['sequence idiom', "const f = (0, Function)('x');"],
  ])('catches %s', (_label, code) => {
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

  // Round-3: the global-object receivers, the optional call, and the canonical
  // `(0, eval)` idiom all reach the same sink.
  it.each([
    "globalThis.eval('x')",
    "window.eval('x')",
    "self.eval('x')",
    "eval?.('x')",
    "(0, eval)('x')",
  ])('catches %s', (code) => {
    expect(INDIRECT_EVAL_PATTERNS.some((p) => p.test(code))).toBe(true);
  });

  it('does not flag a LIBRARY member eval — the Redis Lua wrapper must survive', () => {
    for (const code of ['await redis.eval(script, 0);', 'await client.eval(lua, keys);']) {
      expect(INDIRECT_EVAL_PATTERNS.some((p) => p.test(code))).toBe(false);
    }
  });
});

describe('findSinkMatches (whole-text scan)', () => {
  // Every sink pattern allows whitespace between the callee and its `(`, and
  // that whitespace may be a NEWLINE — a per-line scan can never match these
  // however permissive the pattern is.
  it.each([
    ['Function across a newline', "const f = Function\n('return 1');"],
    ['parenthesized across a newline', "const f = (Function)\n('return 1');"],
    ['eval across a newline', "const v = eval\n('1');"],
  ])('catches %s', (_label, code) => {
    expect(findSinkMatches(code).length).toBeGreaterThan(0);
  });

  it('reports the line the match STARTS on', () => {
    const code = ['const a = 1;', 'const b = 2;', "eval('x');"].join('\n');
    expect(findSinkMatches(code)).toEqual([{ label: 'eval()', line: 3 }]);
  });

  it('finds nothing in ordinary multi-line code', () => {
    const code = ['export function build(x) {', '  return getFunction(x);', '}'].join('\n');
    expect(findSinkMatches(code)).toEqual([]);
  });
});

describe('scanSourceForSinks (raw ∪ stripped)', () => {
  // The class of bug found three times in review: a strip that DELETED the call
  // it was meant to reveal. Scanning raw as well makes the strip non-load-bearing
  // — it can only ever ADD findings, never remove them.
  it('catches a sink even when the strip mis-lexes the surrounding code', () => {
    // `a++ / b` is a division; a lexer that reads the `/` as a regex start
    // swallows the following `/*gap*/` comment and hides the constructor.
    const source = "a++ / b; Function/*gap*/('globalThis.pwned=true')();";
    expect(scanSourceForSinks(source).length).toBeGreaterThan(0);
  });

  it('still catches the comment-gap form the raw pass cannot see', () => {
    const source = "const f = Function/*gap*/('return 1');";
    expect(scanSourceForSinks(source).length).toBeGreaterThan(0);
  });

  it('reports each (line, label) once despite scanning twice', () => {
    expect(scanSourceForSinks("eval('x');")).toEqual([{ label: 'eval()', line: 1 }]);
  });

  it('finds nothing in ordinary code', () => {
    expect(scanSourceForSinks('export const go = () => getFunction(name);')).toEqual([]);
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

  // The regression a regex-based strip introduced: comment delimiters INSIDE
  // string literals were treated as real delimiters, so the strip itself
  // deleted the code between them — hiding a sink from every gate. Strictly
  // worse than not stripping at all.
  it('does NOT treat comment delimiters inside string literals as comments', () => {
    const source = 'const start = "/*"; eval("payload"); const end = "*/";';
    const stripped = stripComments(source);
    expect(stripped).toBe(source); // nothing here is a comment
    expect(hits(SOURCE_CODE_SINKS, stripped)).toBe(true);
  });

  it.each([
    ['single quotes', "const s = '/*'; eval('x'); const e = '*/';"],
    ['template literal', 'const s = `/*`; eval("x"); const e = `*/`;'],
    ['a // inside a string', 'const s = "// not a comment"; eval("x");'],
    ['a regex literal containing a slash', 'const re = /a\\/b/; eval("x");'],
  ])('keeps code visible past a comment delimiter in %s', (_label, source) => {
    expect(hits(SOURCE_CODE_SINKS, stripComments(source))).toBe(true);
  });

  it('is LENGTH- and NEWLINE-preserving, so match offsets map to real lines', () => {
    const source = [
      'const a = 1; // trailing',
      '/* one',
      '   two */',
      'const s = "/* not a comment */";',
      "eval('x');",
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).toHaveLength(source.length);
    expect((stripped.match(/\n/g) ?? []).length).toBe((source.match(/\n/g) ?? []).length);
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

  it('blanks a block comment to WHITESPACE so identifiers cannot fuse', () => {
    // Length is preserved (offsets stay valid), and the tokens either side stay
    // separate — `ab` would be a new identifier the scan never saw in the source.
    const stripped = stripComments('a/* joiner */b');
    expect(stripped).toHaveLength('a/* joiner */b'.length);
    expect(stripped).toMatch(/^a\s+b$/);
    expect(stripped).not.toContain('ab');
  });
});
