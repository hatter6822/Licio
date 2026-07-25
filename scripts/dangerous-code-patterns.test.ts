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
  EVAL_STRING_ARG_PATTERN,
  FUNCTION_CONSTRUCTOR_PATTERNS,
  FUNCTION_TAGGED_TEMPLATE_PATTERN,
  findSinkMatches,
  INDIRECT_EVAL_PATTERNS,
  SOURCE_CODE_SINKS,
  STRING_TIMER_PATTERNS,
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

  // Round-5 finding: every pattern above requires the reference to be followed
  // DIRECTLY by a call token, so interposing an inherited function method
  // defeated all of them. Each form below was verified to actually construct
  // and run code (all return 42) before the pattern was written.
  it.each([
    ['call', "const f = Function.call(null, 'return 42')();"],
    ['apply', "const f = Function.apply(null, ['return 42'])();"],
    ['bind', "const f = Function.bind(null)('return 42')();"],
    ['global receiver + apply', "globalThis.Function.apply(null, ['x'])();"],
    ['Reflect.apply', "Reflect.apply(Function, null, ['return 42'])();"],
    ['Reflect.construct', "Reflect.construct(Function, ['return 42'])();"],
    // Round-6: the reflective pattern accepted only the BARE identifier, even
    // though every direct call site already recognised qualified references.
    ['Reflect.apply + global receiver', "Reflect.apply(globalThis.Function, null, ['x'])();"],
    ['Reflect.construct + computed', "Reflect.construct(window['Function'], ['x'])();"],
    // Round-7: the METHOD side accepted only a plain `.`, so computed and
    // optional access to the very same inherited method slipped through.
    ['computed method', "Function['call'](null, 'return 42')();"],
    ['computed method, double quotes', 'Function["apply"](null, ["return 42"])();'],
    ['optional method on a global', "globalThis.Function?.call(null, 'return 42')();"],
    ['optional method, bare', "Function?.bind(null)('return 42')();"],
  ])('catches the METHOD form: %s', (_label, code) => {
    expect(FUNCTION_CONSTRUCTOR_PATTERNS.some((p) => p.test(code))).toBe(true);
  });

  it.each([
    ['a suffixed identifier', 'const v = getFunction(name);'],
    ['an ordinary .call on some other callee', "handler.call(null, 'x');"],
    ['an ordinary .apply on some other callee', 'fn.apply(this, args);'],
    ['an AsyncFunction-suffixed identifier', 'const v = isAsyncFunction(fn);'],
    ['a member access with no call', 'const t = registry.Function;'],
    ['a type annotation', 'function apply(fn: Function): void {}'],
    ['a lowercase function declaration', 'function build(x) { return x; }'],
  ])('does not flag %s', (_label, code) => {
    expect(FUNCTION_CONSTRUCTOR_PATTERNS.some((p) => p.test(code))).toBe(false);
  });
});

describe('STRING_TIMER_PATTERNS', () => {
  it.each([
    'setTimeout("evil()", 0)',
    "setInterval('evil()', 10)",
    'setTimeout(`evil()`, 0)',
    'setTimeout( "evil()" , 0)',
    'globalThis.setTimeout("evil()", 0)',
  ])('catches the implicit eval in %s', (code) => {
    expect(
      hits(
        STRING_TIMER_PATTERNS.map((pattern) => ({ pattern })),
        code,
      ),
    ).toBe(true);
  });

  // The round-5 gap: the timer reference is reachable by exactly the same
  // indirections as `eval`/`Function`, and the host compiles the string
  // argument either way — so covering only the bare `name(` form left every
  // one of these passing all four gates.
  it.each([
    ['optional call', "setTimeout?.('evil()', 0)"],
    ['optional call on a global', "globalThis.setTimeout?.('evil()', 0)"],
    ['computed on globalThis', "globalThis['setTimeout']('evil()', 0)"],
    ['computed on self', 'self["setInterval"]("evil()", 10)'],
    ['parenthesized reference', "(setInterval)('evil()', 10)"],
    ['sequence idiom', "(0, setTimeout)('evil()', 0)"],
    ['comment gap', 'setTimeout/* c */("evil()", 0)'],
    // Round-5: the code moves to the SECOND argument through .call/.apply.
    ['call', "setTimeout.call(window, 'evil()', 0)"],
    ['apply', 'setInterval.apply(window, ["evil()", 10])'],
    // Round-6: bound and reflective invocation compile the string too.
    ['bind', "setTimeout.bind(globalThis, 'evil()')()"],
    ['Reflect.apply', "Reflect.apply(setTimeout, globalThis, ['evil()'])"],
    ['Reflect.apply + global receiver', "Reflect.apply(globalThis.setTimeout, self, ['evil()'])"],
  ])('catches the INDIRECT form: %s', (_label, code) => {
    expect(
      hits(
        STRING_TIMER_PATTERNS.map((pattern) => ({ pattern })),
        code,
      ),
    ).toBe(true);
  });

  it.each([
    'setTimeout(() => run(), 0)',
    'setInterval(tick, 1000)',
    'setTimeout(handler, delayMs)',
    // The indirect forms must stay quiet on a FUNCTION argument too, or the
    // widened set would flag ordinary scheduling code.
    "globalThis['setTimeout'](tick, 0)",
    'setTimeout?.(() => run(), 0)',
    '(0, setTimeout)(handler, 0)',
    // `.call`/`.apply` with a FUNCTION is ordinary code — unlike Function.call,
    // the timer forms must pin the string's position rather than the shape.
    'setTimeout.call(window, tick, 0);',
    'setTimeout.apply(window, [tick, 0]);',
    'setTimeout.bind(globalThis, tick)();',
    'Reflect.apply(setTimeout, globalThis, [tick, 0]);',
  ])('does not flag the function form %s', (code) => {
    expect(
      hits(
        STRING_TIMER_PATTERNS.map((pattern) => ({ pattern })),
        code,
      ),
    ).toBe(false);
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

  // Both general eval patterns match ordinary PROSE — the real service worker
  // carries `// …no remote code, no eval (WS-C.2.1d)` — so they are marked
  // commentSensitive and run only on the stripped copy. The string-argument
  // form is what keeps eval covered on the RAW pass, so a strip mis-lex cannot
  // hide `eval('…')` the way it can hide a call the strip blanks away.
  it('the general eval patterns match prose, which is why they are comment-sensitive', () => {
    const prose = '// no remote code, no eval (WS-C.2.1d)';
    expect(EVAL_PATTERN.test(prose)).toBe(true);
    expect(EVAL_PATTERN_STRICT.test(prose)).toBe(true);
    // …and the union therefore does NOT report it.
    expect(scanSourceForSinks(prose, SOURCE_CODE_SINKS)).toEqual([]);
    expect(scanSourceForSinks(prose, BUILT_CODE_SINKS)).toEqual([]);
  });

  it('the string-argument form is prose-safe, so it covers the RAW pass', () => {
    expect(EVAL_STRING_ARG_PATTERN.test('// no eval (WS-C.2.1d)')).toBe(false);
    expect(EVAL_STRING_ARG_PATTERN.test(`eval('payload')`)).toBe(true);
    // The payoff: a file the strip mis-lexes still reports the eval.
    const misLexed = `if (ok) /[/*]/.test(x); eval('payload'); const tail = '*/';`;
    expect(stripComments(misLexed)).not.toContain('eval');
    expect(scanSourceForSinks(misLexed, BUILT_CODE_SINKS).length).toBeGreaterThan(0);
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

  // Round-5: `eval.call`/`eval.apply` are indirect eval — they evaluate in
  // GLOBAL scope — and every pattern above required a call token straight
  // after the reference, so all of them passed.
  it.each([
    ['call', "eval.call(null, '40+2')"],
    ['apply', "eval.apply(null, ['40+2'])"],
    ['bind', "eval.bind(null)('40+2')"],
    ['global receiver + call', "globalThis.eval.call(null, 'x')"],
    ['Reflect.apply', "Reflect.apply(eval, null, ['x'])"],
    ['Reflect.apply + global receiver', "Reflect.apply(globalThis.eval, null, ['payload'])"],
    ['Reflect.apply + computed', "Reflect.apply(self['eval'], null, ['payload'])"],
    ['computed method', "eval['call'](null, '40+2')"],
    ['optional computed receiver + optional method', "self?.['eval']?.call(null, 'x')"],
  ])('catches the METHOD form: %s', (_label, code) => {
    expect(INDIRECT_EVAL_PATTERNS.some((p) => p.test(code))).toBe(true);
  });

  it('does not flag a LIBRARY member eval — the Redis Lua wrapper must survive', () => {
    for (const code of [
      'await redis.eval(script, 0);',
      'await client.eval(lua, keys);',
      // The method forms carry the same lookbehind, so a library wrapper
      // invoked through `.call` is still not a sink.
      'await redis.eval.call(client, script, 0);',
      'await client.eval.apply(client, [lua, keys]);',
      // The computed-method widening must not reach a library wrapper either.
      "await redis['eval'].call(client, script, 0);",
      "await redis.eval['apply'](client, [lua, keys]);",
    ]) {
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

describe('the in-pattern comment gap', () => {
  // The patterns themselves tolerate an interposed comment, so the comment-gap
  // form is caught on RAW source — no whole-file lexing required. That is what
  // makes the scan robust against a mis-lex rather than dependent on a correct
  // one.
  it.each([
    ['constructor', "Function/*gap*/('return 1')"],
    ['eval', "eval/*gap*/('1')"],
    ['multi-line comment gap', 'Function/* a\n b */("x")'],
    ['several comments', 'Function/*a*//*b*/("x")'],
  ])('matches through the gap on RAW source: %s', (_label, code) => {
    expect(findSinkMatches(code).length).toBeGreaterThan(0);
  });

  it('catches a sink the STRIP cannot reach — nested braces in an interpolation', () => {
    // An object literal inside `${…}` used to end the interpolation early, so
    // the strip left the comment in place. The raw pass no longer cares.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this string IS the source text under test — the `${…}` must stay literal, not interpolate.
    const source = "const x = `${{a:1}.a, Function/*gap*/('payload')()}`;";
    expect(scanSourceForSinks(source).length).toBeGreaterThan(0);
  });

  it('does not run away on ordinary comment-heavy code', () => {
    const clean = [
      '/** doc */',
      'export const go = () => {',
      '  // note',
      '  return 1;',
      '};',
    ].join('\n');
    expect(findSinkMatches(clean)).toEqual([]);
  });
});

describe('FUNCTION_TAGGED_TEMPLATE_PATTERN', () => {
  // Round-4: `Function` as a TEMPLATE TAG constructs and runs the same function
  // (verified by execution, not assumed) — every other pattern requires `(`.
  it.each([
    ['tagged template', 'Function`globalThis.pwned=true`();'],
    ['tagged template with a comment gap', 'Function /* c */ `body`();'],
  ])('catches %s through scanSourceForSinks: %#', (_label, code) => {
    expect(scanSourceForSinks(code).length).toBeGreaterThan(0);
  });

  it('is COMMENT-SENSITIVE, so markdown prose does not trip it', () => {
    // A doc comment writing `` `new Function` `` puts a backtick straight after
    // the word — textually identical to a tag. Running this pattern on raw
    // source produced exactly that false positive on `update/sw-pinning.ts`.
    const prose = '// it issues no `importScripts`, `eval`, or `new Function`, and runs no code';
    expect(scanSourceForSinks(prose)).toEqual([]);
  });

  it('is flagged commentSensitive in both sink sets', () => {
    for (const set of [SOURCE_CODE_SINKS, BUILT_CODE_SINKS]) {
      const tag = set.find((s) => s.pattern === FUNCTION_TAGGED_TEMPLATE_PATTERN);
      expect(tag?.commentSensitive).toBe(true);
    }
  });
});

describe('linearity (ReDoS canary)', () => {
  // The first cut of the in-pattern gap used `\s+` inside the outer `*`, which
  // nests two quantifiers over the same characters and made `lint:security` run
  // unbounded (killed at 9+ minutes of 100% CPU). These bound the shape that
  // triggered it so a future edit to GAP cannot quietly reintroduce it.
  it('matches a long whitespace gap followed by a NON-match in linear-ish time', () => {
    const started = Date.now();
    findSinkMatches(`Function${' '.repeat(5000)}X`);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('scans a large, deeply indented file quickly', () => {
    const started = Date.now();
    findSinkMatches(`${'\n    '.repeat(20000)}const a = 1;`);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('scans a comment-heavy file quickly', () => {
    const started = Date.now();
    findSinkMatches(`${'/* filler comment */\n'.repeat(5000)}const a = 1;`);
    expect(Date.now() - started).toBeLessThan(2000);
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
