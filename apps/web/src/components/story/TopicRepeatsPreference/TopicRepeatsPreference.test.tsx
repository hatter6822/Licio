// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-topic repeats preference (WS-H.2.3c): the control initializes from
// the SAVED durable preference, and — the load-bearing property — writes
// the MERGED map so changing one topic can never wipe another topic's
// stored preference (the server PATCH replaces the map wholesale). Hidden
// until the current map is loaded (a blind write would be destructive) and
// for anonymous readers.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../../stores/auth.js';
import { TopicRepeatsPreference } from './TopicRepeatsPreference.js';

const fetchPrivacySettings = vi.hoisted(() => vi.fn());
const patchPrivacySettings = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/privacy-api.js', () => ({ fetchPrivacySettings, patchPrivacySettings }));

const SETTINGS = {
  privacy_settings: {},
  personalization_settings: {
    topic_repeat_preference: { water: 'fewer_repeats', transit: 'show_all' },
    feed_mode: 'balanced',
  },
};

function renderControl(topicId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TopicRepeatsPreference topicId={topicId} />
    </QueryClientProvider>,
  );
}

function signIn(): void {
  useAuthStore.setState({
    status: 'authenticated',
    user: { id: 'u1', handle: 'tester', displayName: 'Tester' },
  } as never);
}

afterEach(() => {
  useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
  fetchPrivacySettings.mockReset();
  patchPrivacySettings.mockReset();
});

describe('TopicRepeatsPreference (WS-H.2.3c)', () => {
  it('renders nothing for anonymous readers', () => {
    renderControl('water');
    expect(screen.queryByText('Repeats on this topic')).not.toBeInTheDocument();
  });

  it('hides until the current map is loaded (a blind write would wipe it)', async () => {
    signIn();
    let release: (value: typeof SETTINGS) => void = () => {};
    fetchPrivacySettings.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderControl('water');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    release(SETTINGS);
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
  });

  it('initializes from the saved preference and writes the MERGED map', async () => {
    signIn();
    fetchPrivacySettings.mockResolvedValue(SETTINGS);
    patchPrivacySettings.mockResolvedValue(SETTINGS);
    renderControl('water');
    const select = await screen.findByRole('combobox');
    // Saved value, not the default.
    expect(select).toHaveValue('fewer_repeats');
    await userEvent.selectOptions(select, 'show_all');
    // (mutate passes a TanStack context second argument; assert the payload.)
    expect(patchPrivacySettings.mock.calls[0]?.[0]).toEqual({
      personalization_settings: {
        // The OTHER topic's preference survives the single-topic change.
        topic_repeat_preference: { water: 'show_all', transit: 'show_all' },
      },
    });
  });

  it('unsaved topics default to balanced', async () => {
    signIn();
    fetchPrivacySettings.mockResolvedValue(SETTINGS);
    renderControl('zoning');
    expect(await screen.findByRole('combobox')).toHaveValue('balanced');
  });
});
