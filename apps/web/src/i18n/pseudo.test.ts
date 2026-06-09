// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { formatMessage } from './message.js';
import { isPseudoLocale, PSEUDO_LOCALE, pseudoFormat } from './pseudo.js';

describe('isPseudoLocale', () => {
  it('matches the pseudo-locale tag (and extensions) but not real locales', () => {
    expect(PSEUDO_LOCALE).toBe('en-XA');
    expect(isPseudoLocale('en-XA')).toBe(true);
    expect(isPseudoLocale('en-xa')).toBe(true); // case-insensitive
    expect(isPseudoLocale('en-XA-x-dev')).toBe(true);
    expect(isPseudoLocale('en')).toBe(false);
    expect(isPseudoLocale('en-US')).toBe(false);
    expect(isPseudoLocale('es')).toBe(false);
  });
});

describe('formatMessage transformLiteral hook', () => {
  it('transforms only literal text, never placeholder names or values', () => {
    expect(
      formatMessage('Hi {who}', { who: 'Ada' }, 'en', { transformLiteral: (s) => s.toUpperCase() }),
    ).toBe('HI Ada');
  });

  it('threads the transform through nested plural bodies and # substitution', () => {
    expect(
      formatMessage('{n, plural, other {# left}}', { n: 2 }, 'en', {
        transformLiteral: (s) => `[${s}]`,
      }),
    ).toBe('[2 left]');
  });
});

describe('pseudoFormat', () => {
  it('brackets and expands the string and accents literal letters', () => {
    const out = pseudoFormat('Reader view', undefined, PSEUDO_LOCALE);
    expect(out.startsWith('⟦')).toBe(true);
    expect(out.endsWith('⟧')).toBe(true);
    // Letters are accented, so the plain English word no longer appears…
    expect(out).not.toContain('Reader');
    // …but it is recognizably the same word (first letter accented).
    expect(out).toContain('Ŕ');
    // Expansion makes it longer than the source (truncation canary).
    expect([...out].length).toBeGreaterThan('Reader view'.length);
  });

  it('preserves interpolated values verbatim (only the template is localized)', () => {
    const out = pseudoFormat('Hello, {name}', { name: 'Ada' }, PSEUDO_LOCALE);
    expect(out).toContain('Ada'); // dynamic data is not pseudo-translated
    expect(out).not.toContain('Hello'); // surrounding copy is
  });

  it('keeps ICU plural selection working under the pseudo-locale', () => {
    const msg = '{n, plural, one {# item} other {# items}}';
    const one = pseudoFormat(msg, { n: 1 }, PSEUDO_LOCALE);
    const many = pseudoFormat(msg, { n: 5 }, PSEUDO_LOCALE);
    expect(one).toContain('1');
    expect(many).toContain('5');
    // Singular and plural arms resolve to different copy.
    expect(one).not.toBe(many);
  });

  it('leaves digits and punctuation untouched', () => {
    const out = pseudoFormat('Plan A: 100%', undefined, PSEUDO_LOCALE);
    expect(out).toContain('100%');
  });
});
