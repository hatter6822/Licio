// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { cn, defaultMaxWidth } from './cn.js';

describe('cn', () => {
  it('joins truthy values and drops the falsy ones', () => {
    expect(cn('a', false, undefined, null, 'b')).toBe('a b');
  });
});

describe('defaultMaxWidth', () => {
  it('keeps the default when the caller sets no width', () => {
    expect(defaultMaxWidth('max-w-xl', undefined)).toBe('max-w-xl');
    expect(defaultMaxWidth('max-w-xl', 'flex flex-col gap-2')).toBe('max-w-xl');
  });

  it('drops the default the moment the caller sets its own width', () => {
    expect(defaultMaxWidth('max-w-xl', 'max-w-3xl')).toBe('');
    expect(defaultMaxWidth('max-w-xl', 'p-4 max-w-3xl gap-2')).toBe('');
    // Variant-prefixed overrides count too — the caller owns the width there.
    expect(defaultMaxWidth('max-w-xl', 'md:max-w-4xl')).toBe('');
  });

  it('is not fooled by a class that merely CONTAINS the token', () => {
    expect(defaultMaxWidth('max-w-xl', 'grid-cols-max-w-2')).toBe('max-w-xl');
  });
});
