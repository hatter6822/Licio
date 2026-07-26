// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the semantic-hue usage gate's pure core, plus a run against the
// REAL web source — so the suite fails if a call site drifts back onto the bare
// hue for normal text.
//
// The fixtures deliberately cover the forms the PREVIOUS guard could not see (it
// matched only a same-line quoted literal directly after `className=`): `cn(...)`
// arguments, module-level class maps, multi-line ternaries, and template
// literals.  Each of those was a live miss, not a hypothetical one.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findBareHueTextUses,
  isScannedPath,
  type SourceFile,
  WEB_SRC,
} from './check-a11y-hue-usage.js';

const ROOT = resolve(import.meta.dirname, '..');
const file = (content: string, path = 'apps/web/src/x.tsx'): SourceFile[] => [{ path, content }];
const hues = (content: string): string[] =>
  findBareHueTextUses(file(content)).map((finding) => `${finding.line}:${finding.hue}`);

describe('the bare hue on normal text', () => {
  it('flags a plain className literal', () => {
    expect(hues(`<p className="text-sm text-error">no</p>`)).toEqual(['1:error']);
  });

  it('flags a hue inside a cn(...) argument', () => {
    expect(
      hues(`<p className={cn('text-sm', blocked ? 'text-error' : 'text-ink-muted')} />`),
    ).toEqual(['1:error']);
  });

  it('flags a hue held in a module-level class map', () => {
    const source = [
      `const META = {`,
      `  under_debate: { chip: 'border-warning/50 text-warning' },`,
      `  incorrect: { chip: 'border-error/60 text-error' },`,
      `};`,
    ].join('\n');
    expect(hues(source)).toEqual(['2:warning', '3:error']);
  });

  it('flags a hue in a multi-line ternary, on the line the class sits on', () => {
    const source = [
      `const tone =`,
      `  outcome === 'ok'`,
      `    ? 'text-ink-muted'`,
      `    : outcome === 'rejected'`,
      `      ? 'text-warning'`,
      `      : 'text-error';`,
    ].join('\n');
    expect(hues(source)).toEqual(['5:warning', '6:error']);
  });

  it('flags a hue in a template literal, and reports its own line', () => {
    const source = ['const c = `', '  text-sm', '  text-error', '`;'].join('\n');
    expect(hues(source)).toEqual(['3:error']);
  });

  // A template is ONE token, so a literal inside a `${…}` hole is not emitted
  // separately and the hole-blanking erased its only occurrence — letting the
  // most ordinary computed-class form through.  The scan descends into holes.
  it('flags a hue in a string literal INSIDE a template interpolation', () => {
    const source = `<p className={\`text-sm \${blocked ? 'text-error' : ''}\`} />`;
    expect(hues(source)).toEqual(['1:error']);
  });

  it('descends into a NESTED template interpolation', () => {
    const source = `const c = \`a \${cond ? \`b \${on ? 'text-warning' : ''}\` : ''}\`;`;
    expect(hues(source)).toEqual(['1:warning']);
  });

  it('reports the line the nested literal sits on, not the template start', () => {
    const source = ['const c = `', '  base', `  \${bad ? 'text-error' : ''}`, '`;'].join('\n');
    expect(hues(source)).toEqual(['3:error']);
  });

  it('flags every hue in the family', () => {
    expect(hues(`const a = 'text-success text-warning text-error text-info';`)).toEqual([
      '1:success',
    ]);
    for (const hue of ['primary', 'success', 'warning', 'error', 'info']) {
      expect(hues(`const a = 'text-${hue}';`)).toEqual([`1:${hue}`]);
    }
  });
});

describe('what is NOT a violation', () => {
  it('accepts the -on-soft pair', () => {
    expect(hues(`<p className="text-sm text-error-on-soft">ok</p>`)).toEqual([]);
  });

  it('accepts every other suffixed token in the family', () => {
    for (const suffix of ['-on-soft', '-soft', '-fg', '-strong']) {
      expect(hues(`const a = 'text-warning${suffix}';`)).toEqual([]);
    }
  });

  it('accepts an icon, which is a graphical object at 3:1 (WCAG 1.4.11)', () => {
    expect(hues(`<Icon className="size-4 shrink-0 text-success" />`)).toEqual([]);
  });

  it('accepts an icon whether the size comes before or after the hue', () => {
    expect(hues(`<Icon className="text-success size-4" />`)).toEqual([]);
  });

  it('accepts an icon whose props span several lines', () => {
    const source = [
      '<Icon',
      '  name="x"',
      '  aria-hidden',
      '  className="size-4 text-success"',
      '/>',
    ].join('\n');
    expect(hues(source)).toEqual([]);
  });
});

// `size-*` says the element has a fixed square size, NOT that it is a graphical
// object — so exempting on the class alone waves through normal text that
// happens to sit in a square.  The exemption is the size class AND the element
// that actually renders an icon.
describe('the icon exemption is scoped to the icon element', () => {
  it('REJECTS a sized non-icon element carrying the bare hue', () => {
    expect(hues(`<span className="size-8 text-error">!</span>`)).toEqual(['1:error']);
    expect(hues(`<div className="size-8 text-warning">x</div>`)).toEqual(['1:warning']);
  });

  it('REJECTS a sized class map entry, which has no element at all', () => {
    // No evidence of being non-text, so it needs the reasoned marker instead.
    expect(hues(`const m = { a: 'size-4 text-info' };`)).toEqual(['1:info']);
  });

  it('ignores a class name only NAMED in a comment', () => {
    expect(hues(`// never use text-error for body copy\nconst a = 1;`)).toEqual([]);
    expect(hues(`/* text-warning is large-text only */\nconst a = 1;`)).toEqual([]);
  });

  it('ignores an interpolation hole, whose contents are an expression', () => {
    // `textError` is an identifier, not class text; a class spliced through a
    // hole is a literal of its own and is caught as that literal instead.
    //
    // Written as an escaped template so the backticks and `${` belong to the
    // FIXTURE's source text rather than to this file's own string.
    expect(hues(`const c = \`text-sm \${textError}\`;`)).toEqual([]);
  });

  it('accepts an icon or an -on-soft pair reached through an interpolation', () => {
    // The descent must not lose the exemptions it descends past.  The icon case
    // needs its element, since `size-*` alone no longer exempts anything.
    expect(hues(`<Icon className={\`b \${on ? 'size-4 text-success' : ''}\`} />`)).toEqual([]);
    expect(hues(`const c = \`b \${on ? 'text-error-on-soft' : ''}\`;`)).toEqual([]);
  });

  it('does not confuse a hue-prefixed longer word', () => {
    expect(hues(`const a = 'text-errors text-successful';`)).toEqual([]);
  });

  it('does not read a regex literal containing quotes as a string', () => {
    // The repo's own lexer trap: a naive scanner treats the quote inside the
    // character class as opening a string and swallows the code after it.
    const source = [`const q = /['"\`]/;`, `const c = 'text-error';`].join('\n');
    expect(hues(source)).toEqual(['2:error']);
  });
});

describe('the reasoned exemption', () => {
  it('accepts a marker on the same line', () => {
    const source = `const c = 'text-warning'; // a11y-bare-hue-ok: bar fill, not text`;
    expect(hues(source)).toEqual([]);
  });

  it('accepts a marker anywhere in the comment block directly above', () => {
    const source = [
      `// a11y-bare-hue-ok: this colours the <progress> FILL, so WCAG 1.4.11`,
      `// (3:1) applies rather than 1.4.3, and the bare hue clears it.  The`,
      `// value is also stated in words below the bar.`,
      `const c = 'text-warning';`,
    ].join('\n');
    expect(hues(source)).toEqual([]);
  });

  it('accepts a marker inside a JSX comment', () => {
    const source = [`{/* a11y-bare-hue-ok: svg stroke */}`, `<p className="text-error" />`].join(
      '\n',
    );
    expect(hues(source)).toEqual([]);
  });

  it('accepts a marker inside a block comment', () => {
    const source = [
      `/**`,
      ` * a11y-bare-hue-ok: chart series colour.`,
      ` */`,
      `const c = 'text-info';`,
    ].join('\n');
    expect(hues(source)).toEqual([]);
  });

  it('REJECTS a marker with no reason', () => {
    expect(hues([`// a11y-bare-hue-ok:`, `const c = 'text-error';`].join('\n'))).toEqual([
      '2:error',
    ]);
  });

  it('REJECTS a marker separated from the class by real code', () => {
    // One exemption must never cover the next line's mistake.
    const source = [
      `// a11y-bare-hue-ok: bar fill`,
      `const bar = 'text-warning';`,
      `const label = 'text-error';`,
    ].join('\n');
    expect(hues(source)).toEqual(['3:error']);
  });

  it('lets a blank line sit between the comment block and the class', () => {
    const source = [`// a11y-bare-hue-ok: bar fill`, ``, `const c = 'text-warning';`].join('\n');
    expect(hues(source)).toEqual([]);
  });
});

describe('the scanned file set', () => {
  it('takes web source, in both extensions', () => {
    expect(isScannedPath(`${WEB_SRC}/components/x.tsx`)).toBe(true);
    expect(isScannedPath(`${WEB_SRC}/lib/api.ts`)).toBe(true);
  });

  it('leaves out tests, which name classes in assertions', () => {
    expect(isScannedPath(`${WEB_SRC}/components/x.test.tsx`)).toBe(false);
    expect(isScannedPath(`${WEB_SRC}/e2e/x.spec.ts`)).toBe(false);
    expect(isScannedPath(`${WEB_SRC}/design-system/__tests__/tokens.test.ts`)).toBe(false);
  });

  it('leaves out other workspaces and non-source files', () => {
    expect(isScannedPath('apps/api/src/routes/x.ts')).toBe(false);
    expect(isScannedPath(`${WEB_SRC}/styles/index.css`)).toBe(false);
  });
});

describe('the real web source', () => {
  it('uses the -on-soft pair for every semantic hue on normal text', () => {
    const tracked = execFileSync('git', ['ls-files', WEB_SRC], {
      cwd: ROOT,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .filter(isScannedPath);
    expect(tracked.length).toBeGreaterThan(100);

    const files = tracked.map((path) => ({
      path,
      content: readFileSync(resolve(ROOT, path), 'utf-8'),
    }));
    expect(findBareHueTextUses(files).map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });
});
