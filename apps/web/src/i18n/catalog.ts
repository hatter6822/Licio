// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Message-catalog loading (WS-B.2.14). Real, human-reviewed locale catalogs are
// loaded lazily via dynamic `import()` so they never weigh down the initial
// bundle — only the active locale's strings are fetched. WS-C resolves the
// catalog for the user's locale and passes it to `<I18nProvider messages>`.
//
// No real catalog ships yet (the app's copy lives as inline English defaults and
// is proven end-to-end by the pseudo-locale, `pseudo.ts`). This module is the
// drop-in seam: register a locale here and ship `catalogs/<locale>.ts` to
// localize, with no other code change. The registry is injectable so the loader
// is fully testable without shipping placeholder translations.
import type { Messages } from './I18nProvider.js';

/** A lazily-loaded catalog module: either a default export or a bare object. */
export type CatalogModule = Messages | { default: Messages };
export type CatalogLoader = () => Promise<CatalogModule>;
export type CatalogRegistry = Record<string, CatalogLoader>;

/**
 * Locale → lazy catalog loader. Add real locales here as they are translated.
 * The pseudo-locale (`en-XA`) is intentionally absent — it is generated at
 * runtime and needs no catalog.
 *
 * `de` ships the complete WS-N.1.2b disabled-state message set (the
 * non-English completeness requirement for the jurisdiction UX).
 */
export const catalogs: CatalogRegistry = {
  de: () => import('./catalogs/de.js'),
};

/** Primary language subtag of a BCP-47 locale (`es-MX` → `es`). */
function baseLanguage(locale: string): string {
  return locale.toLowerCase().split('-')[0] ?? locale;
}

/**
 * Resolve the message catalog for `locale`, falling back to the base language
 * (`es-MX` → `es`) and then to an empty catalog (which makes the provider use
 * the components' inline English defaults). Unwraps an ESM default export.
 */
export async function loadCatalog(
  locale: string,
  registry: CatalogRegistry = catalogs,
): Promise<Messages> {
  const loader = registry[locale] ?? registry[baseLanguage(locale)];
  if (!loader) return {};
  const module = await loader();
  const maybeDefault = (module as { default?: Messages }).default;
  return maybeDefault && typeof maybeDefault === 'object' ? maybeDefault : (module as Messages);
}
