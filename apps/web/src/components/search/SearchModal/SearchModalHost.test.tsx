// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The lazy modal host: nothing renders while the store flag is off (the modal
// chunk stays un-imported until first open), the REAL SearchModal mounts once
// the flag flips, and closing through the dialog writes the store back.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../i18n/I18nProvider.js';
import { useUIStore } from '../../../stores/index.js';
import { SearchModalHost } from './SearchModalHost.js';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

const searchContent = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/search-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/search-api.js')>()),
  searchContent,
}));

function renderHost() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="en">
      <QueryClientProvider client={client}>
        <SearchModalHost />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  act(() => useUIStore.setState({ searchOpen: false }));
});

describe('SearchModalHost (lazy mount)', () => {
  it('renders nothing while closed, mounts the modal on open, unmounts on close', async () => {
    renderHost();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => useUIStore.getState().openSearch());
    // Lazy chunk: the dialog appears once the dynamic import resolves.
    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeInTheDocument();

    act(() => useUIStore.getState().closeSearch());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('the dialog close button writes the store flag back', async () => {
    renderHost();
    act(() => useUIStore.getState().openSearch());
    await screen.findByRole('dialog', { name: 'Search' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close search' }));
    expect(useUIStore.getState().searchOpen).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
