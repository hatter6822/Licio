// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useT } from './I18nProvider.js';
import { LocalizedI18nProvider, resolvePreferredLocale } from './LocalizedI18nProvider.js';

function Probe(): React.ReactElement {
  const t = useT();
  // A key that the shipped German catalog (de.ts) translates.
  return <span>{t('disabled.region.unknown', 'Your region')}</span>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolvePreferredLocale', () => {
  it('returns navigator.language when present', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE');
    expect(resolvePreferredLocale()).toBe('de-DE');
  });
});

describe('LocalizedI18nProvider (WS-B.2.14 / WS-N.1.2b)', () => {
  it('renders the English default immediately, then swaps in the loaded catalog', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE');
    render(
      <LocalizedI18nProvider>
        <Probe />
      </LocalizedI18nProvider>,
    );
    // First paint uses the inline English default (catalog not yet resolved).
    expect(screen.getByText('Your region')).toBeInTheDocument();
    // Once the de catalog loads, the German string replaces it.
    await waitFor(() => expect(screen.getByText('Ihre Region')).toBeInTheDocument());
  });

  it('falls back to English inline defaults for a locale with no catalog', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR');
    render(
      <LocalizedI18nProvider>
        <Probe />
      </LocalizedI18nProvider>,
    );
    await waitFor(() => expect(screen.getByText('Your region')).toBeInTheDocument());
  });
});
