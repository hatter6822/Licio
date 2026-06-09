// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Localization context (WS-B.2.14). Provides the active locale, text direction,
// and a `t()` translator. All user-facing copy flows through `t(key, default)`:
// a per-locale override in `messages` wins, otherwise the component's default
// English is used — so copy is centralized and translatable while components
// remain self-contained. `dir`/`lang` are reflected onto <html> for RTL and
// WCAG 3.1.1 (Language of Page).
import { type ReactNode, createContext, useContext, useEffect, useMemo } from 'react';
import { formatMessage } from './message.js';
import { isPseudoLocale, pseudoFormat } from './pseudo.js';

export type Direction = 'ltr' | 'rtl';

/** Per-locale message overrides: message key → translated string. */
export type Messages = Record<string, string>;

export interface I18nContextValue {
  locale: string;
  dir: Direction;
  /**
   * Translate `key`, falling back to `defaultMessage`. `{name}` placeholders in
   * the resolved string are replaced from `params`.
   */
  t: (key: string, defaultMessage: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** RTL scripts per BCP-47 language subtag. */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ckb']);

export function resolveDirection(locale: string): Direction {
  const language = locale.toLowerCase().split('-')[0] ?? '';
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

export interface I18nProviderProps {
  locale?: string;
  /** Explicit direction; inferred from `locale` when omitted. */
  dir?: Direction;
  messages?: Messages;
  children: ReactNode;
}

export function I18nProvider({
  locale = 'en',
  dir,
  messages = {},
  children,
}: I18nProviderProps): React.ReactElement {
  const direction = dir ?? resolveDirection(locale);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const prevLang = root.lang;
    const prevDir = root.dir;
    root.lang = locale;
    root.dir = direction;
    return () => {
      root.lang = prevLang;
      root.dir = prevDir;
    };
  }, [locale, direction]);

  const value = useMemo<I18nContextValue>(() => {
    const pseudo = isPseudoLocale(locale);
    return {
      locale,
      dir: direction,
      // A catalog override wins; otherwise the component's inline English default
      // is used. Under the pseudo-locale every resolved string is transformed, so
      // gaps in localization (and layout that breaks on longer text) are visible.
      t: (key, defaultMessage, params) => {
        const template = messages[key] ?? defaultMessage;
        return pseudo
          ? pseudoFormat(template, params, locale)
          : formatMessage(template, params, locale);
      },
    };
  }, [locale, direction, messages]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Access the i18n context. Outside a provider it degrades to English/LTR with a
 * pass-through translator, so components (and their tests) work standalone.
 */
export function useI18n(): I18nContextValue {
  return (
    useContext(I18nContext) ?? {
      locale: 'en',
      dir: 'ltr',
      t: (_key, defaultMessage, params) => formatMessage(defaultMessage, params, 'en'),
    }
  );
}

/** Convenience hook returning just the translator. */
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}
