// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The APP-level i18n wrapper (WS-B.2.14 / WS-N.1.2b). Resolves the user's locale
// from `navigator.language` and lazily loads its message catalog, then renders
// the pure `I18nProvider`. Without this, the app mounted `<I18nProvider>` with no
// locale/messages — hard-pinned to English, and the shipped German catalog (the
// WS-N.1.2b disabled-state completeness set) was unreachable.
//
// First paint is never blocked: until the catalog resolves — and for any locale
// with no catalog — the provider falls back to the components' inline English
// defaults, and a catalog-load failure degrades to English rather than throwing.
import { type ReactNode, useEffect, useState } from 'react';
import { loadCatalog } from './catalog.js';
import { I18nProvider, type Messages } from './I18nProvider.js';

/** The browser's preferred BCP-47 locale, or 'en' where unavailable (SSR/tests). */
export function resolvePreferredLocale(): string {
  if (typeof navigator === 'undefined') return 'en';
  const lang = navigator.language?.trim();
  return lang && lang.length > 0 ? lang : 'en';
}

export function LocalizedI18nProvider({ children }: { children: ReactNode }): React.ReactElement {
  // Locale is fixed for the session (a language change is a reload); loading it
  // once in state keeps the render deterministic.
  const [locale] = useState(resolvePreferredLocale);
  const [messages, setMessages] = useState<Messages>({});

  useEffect(() => {
    let active = true;
    void loadCatalog(locale)
      .then((resolved) => {
        if (active) setMessages(resolved);
      })
      .catch(() => undefined); // a failed catalog load degrades to English defaults
    return () => {
      active = false;
    };
  }, [locale]);

  return (
    <I18nProvider locale={locale} messages={messages}>
      {children}
    </I18nProvider>
  );
}
