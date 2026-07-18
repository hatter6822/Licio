// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { type CatalogRegistry, catalogs, loadCatalog } from './catalog.js';

describe('loadCatalog', () => {
  it('lazily loads a registered catalog exposed as an ESM default export', async () => {
    const registry: CatalogRegistry = {
      es: () => Promise.resolve({ default: { 'common.close': 'Cerrar' } }),
    };
    expect(await loadCatalog('es', registry)).toEqual({ 'common.close': 'Cerrar' });
  });

  it('supports a catalog module that is a bare object (no default export)', async () => {
    const registry: CatalogRegistry = {
      de: () => Promise.resolve({ 'common.close': 'Schließen' }),
    };
    expect(await loadCatalog('de', registry)).toEqual({ 'common.close': 'Schließen' });
  });

  it('falls back to the base language for a regional locale', async () => {
    const registry: CatalogRegistry = {
      es: () => Promise.resolve({ default: { greeting: 'Hola' } }),
    };
    expect(await loadCatalog('es-MX', registry)).toEqual({ greeting: 'Hola' });
  });

  it('returns an empty catalog for an unregistered locale (inline English fallback)', async () => {
    expect(await loadCatalog('zz', {})).toEqual({});
  });

  it('only invokes the loader for the requested locale (true lazy loading)', async () => {
    let esLoaded = false;
    let frLoaded = false;
    const registry: CatalogRegistry = {
      es: () => {
        esLoaded = true;
        return Promise.resolve({ default: {} });
      },
      fr: () => {
        frLoaded = true;
        return Promise.resolve({ default: {} });
      },
    };
    await loadCatalog('es', registry);
    expect(esLoaded).toBe(true);
    expect(frLoaded).toBe(false); // the French chunk was never fetched
  });

  it('ships the German catalog (the WS-N.1.2b disabled-state completeness locale)', async () => {
    expect(Object.keys(catalogs)).toEqual(['de']);
    const messages = await loadCatalog('de');
    // The disabled-state keys resolve through the REAL registry, base-language
    // fallback included (`de-AT` → `de`).
    expect(messages['disabled.production_payments.title']).toBeTruthy();
    expect(await loadCatalog('de-AT')).toEqual(messages);
    // An unregistered locale still falls back to the inline English defaults.
    expect(await loadCatalog('fr')).toEqual({});
  });
});
