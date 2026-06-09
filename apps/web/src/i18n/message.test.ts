// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { formatMessage } from './message.js';

describe('formatMessage (ICU MessageFormat)', () => {
  it('substitutes simple named arguments', () => {
    expect(formatMessage('Hello, {name}', { name: 'Ada' }, 'en')).toBe('Hello, Ada');
  });

  it('leaves unknown placeholders intact and passes through plain strings', () => {
    expect(formatMessage('No placeholders here', undefined, 'en')).toBe('No placeholders here');
    expect(formatMessage('Hi {missing}', {}, 'en')).toBe('Hi {missing}');
  });

  it('selects the correct plural category and substitutes # with the number', () => {
    const msg = '{count, plural, one {# character remaining} other {# characters remaining}}';
    expect(formatMessage(msg, { count: 1 }, 'en')).toBe('1 character remaining');
    expect(formatMessage(msg, { count: 5 }, 'en')).toBe('5 characters remaining');
    expect(formatMessage(msg, { count: 0 }, 'en')).toBe('0 characters remaining');
  });

  it('honours exact =N matches before CLDR categories', () => {
    const msg = '{n, plural, =0 {none left} one {# left} other {# left}}';
    expect(formatMessage(msg, { n: 0 }, 'en')).toBe('none left');
    expect(formatMessage(msg, { n: 1 }, 'en')).toBe('1 left');
  });

  it('applies locale-specific plural rules', () => {
    // Polish uses a distinct "few"/"many" split; 1 is "one", 2 is "few".
    const msg = '{n, plural, one {jeden} few {kilka} many {wiele} other {inne}}';
    expect(formatMessage(msg, { n: 1 }, 'pl')).toBe('jeden');
    expect(formatMessage(msg, { n: 3 }, 'pl')).toBe('kilka');
  });

  it('supports select and nested placeholders', () => {
    const msg = '{kind, select, evidence {Evidence: {label}} other {Note: {label}}}';
    expect(formatMessage(msg, { kind: 'evidence', label: 'gauge data' }, 'en')).toBe(
      'Evidence: gauge data',
    );
    expect(formatMessage(msg, { kind: 'ask', label: 'why?' }, 'en')).toBe('Note: why?');
  });

  it('formats the substituted number per locale', () => {
    const msg = '{n, plural, other {# items}}';
    expect(formatMessage(msg, { n: 1234 }, 'en-US')).toBe('1,234 items');
    expect(formatMessage(msg, { n: 1234 }, 'de-DE')).toBe('1.234 items');
  });
});
