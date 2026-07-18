// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-topic repeats control on a story card (WS-H.2.3c): a bottom-right icon
// button opens a compact sheet whose radio options write the MERGED durable
// preference map (changing one topic never wipes another's preference). The
// control is hidden until the current map is loaded and for anonymous readers.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../../lib/query-keys.js';
import { useAuthStore } from '../../../stores/auth.js';
import { TopicRepeatsButton } from './TopicRepeatsButton.js';

const fetchPrivacySettings = vi.hoisted(() => vi.fn());
const patchPrivacySettings = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/privacy-api.js', () => ({ fetchPrivacySettings, patchPrivacySettings }));

const TRIGGER = 'Adjust how often this topic repeats';

const SETTINGS = {
  privacy_settings: {},
  personalization_settings: {
    topic_repeat_preference: { water: 'fewer_repeats', transit: 'show_all' },
    feed_mode: 'best',
  },
};

function renderControl(topicId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TopicRepeatsButton topicId={topicId} />
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

describe('TopicRepeatsButton (WS-H.2.3c)', () => {
  it('renders nothing for anonymous readers', () => {
    renderControl('water');
    expect(screen.queryByRole('button', { name: TRIGGER })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: TRIGGER })).not.toBeInTheDocument();
    release(SETTINGS);
    await waitFor(() => expect(screen.getByRole('button', { name: TRIGGER })).toBeInTheDocument());
  });

  it('opens on the saved value and writes the MERGED map', async () => {
    signIn();
    fetchPrivacySettings.mockResolvedValue(SETTINGS);
    patchPrivacySettings.mockResolvedValue(SETTINGS);
    renderControl('water');
    await userEvent.click(await screen.findByRole('button', { name: TRIGGER }));
    // The saved value is pre-selected in the sheet.
    expect(await screen.findByRole('radio', { name: 'Show fewer repeats' })).toBeChecked();
    // Choosing a different option writes the merged map.
    await userEvent.click(screen.getByRole('radio', { name: 'Show all updates' }));
    expect(patchPrivacySettings.mock.calls[0]?.[0]).toEqual({
      personalization_settings: {
        // The OTHER topic's preference survives the single-topic change.
        topic_repeat_preference: { water: 'show_all', transit: 'show_all' },
      },
    });
  });

  it('optimistically writes the merged map to the cache so a sibling button merges against it', async () => {
    signIn();
    fetchPrivacySettings.mockResolvedValue(SETTINGS);
    // The PATCH stays in flight, so ONLY the optimistic write touches the cache
    // (no refetch reverts it) — the deterministic proof of the merge mechanism.
    patchPrivacySettings.mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TopicRepeatsButton topicId="zoning" />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: TRIGGER }));
    await userEvent.click(await screen.findByRole('radio', { name: 'Show fewer repeats' }));
    const cached = client.getQueryData(queryKeys.durablePrivacySettings()) as typeof SETTINGS;
    // The OTHER topics survive and `zoning` is added — a sibling button reading
    // the cache now sees this change, so it cannot clobber it.
    expect(cached.personalization_settings.topic_repeat_preference).toEqual({
      water: 'fewer_repeats',
      transit: 'show_all',
      zoning: 'fewer_repeats',
    });
  });

  it('unsaved topics default to balanced', async () => {
    signIn();
    fetchPrivacySettings.mockResolvedValue(SETTINGS);
    renderControl('zoning');
    await userEvent.click(await screen.findByRole('button', { name: TRIGGER }));
    expect(await screen.findByRole('radio', { name: 'Balanced' })).toBeChecked();
  });
});
