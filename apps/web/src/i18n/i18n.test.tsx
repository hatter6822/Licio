// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider, useI18n, useT } from './I18nProvider.js';
import { formatList, formatNumber, formatReadingEstimate, resolveDirection } from './index.js';

describe('resolveDirection', () => {
  it('returns rtl for RTL languages and ltr otherwise', () => {
    expect(resolveDirection('ar')).toBe('rtl');
    expect(resolveDirection('he-IL')).toBe('rtl');
    expect(resolveDirection('fa')).toBe('rtl');
    expect(resolveDirection('en')).toBe('ltr');
    expect(resolveDirection('en-US')).toBe('ltr');
    expect(resolveDirection('fr')).toBe('ltr');
  });
});

describe('I18nProvider + t()', () => {
  const wrapper =
    (props: { locale?: string; messages?: Record<string, string> }) =>
    ({ children }: { children: ReactNode }) => <I18nProvider {...props}>{children}</I18nProvider>;

  it('falls back to the default message and interpolates params', () => {
    const { result } = renderHook(() => useT(), { wrapper: wrapper({}) });
    expect(result.current('greeting', 'Hello, {name}', { name: 'Ada' })).toBe('Hello, Ada');
  });

  it('prefers a per-locale override when present', () => {
    const { result } = renderHook(() => useT(), {
      wrapper: wrapper({ locale: 'es', messages: { 'common.close': 'Cerrar' } }),
    });
    expect(result.current('common.close', 'Close')).toBe('Cerrar');
  });

  it('degrades to a pass-through translator with no provider', () => {
    const { result } = renderHook(() => useI18n());
    expect(result.current.locale).toBe('en');
    expect(result.current.dir).toBe('ltr');
    expect(result.current.t('x', 'Default {n}', { n: 2 })).toBe('Default 2');
  });

  it('reflects locale and direction onto <html>', () => {
    render(
      <I18nProvider locale="ar">
        <span>محتوى</span>
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByText('محتوى')).toBeInTheDocument();
  });
});

describe('Intl formatters', () => {
  it('formats numbers per locale', () => {
    expect(formatNumber(1234.5, 'en-US')).toBe('1,234.5');
    expect(formatNumber(1000, 'de-DE')).toBe('1.000');
  });

  it('formats conjunction lists', () => {
    expect(formatList(['lenses', 'sources', 'context'], 'en-US')).toContain('and');
  });

  it('rounds reading estimates to at least one minute and uses the template', () => {
    expect(formatReadingEstimate(0.2, 'en-US', (m) => `${m} min read`)).toBe('1 min read');
    expect(formatReadingEstimate(7.6, 'en-US', (m) => `${m} min read`)).toBe('8 min read');
  });
});
