// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUpdateSettingsMutation } from './queries.js';
import { queryKeys } from './query-keys.js';

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return { ...actual, updateSettings: vi.fn() };
});
const api = await import('./api.js');
const mockedUpdate = vi.mocked(api.updateSettings);

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useUpdateSettingsMutation (optimistic + rollback)', () => {
  it('applies the optimistic update, then rolls back on error', async () => {
    const client = makeClient();
    client.setQueryData<UserSettings>(queryKeys.settings(), DEFAULT_USER_SETTINGS);

    // Keep the mutation pending so we can observe the optimistic cache state.
    let reject: (reason: unknown) => void = () => undefined;
    mockedUpdate.mockImplementation(
      () =>
        new Promise<UserSettings>((_resolve, rej) => {
          reject = rej;
        }),
    );

    const { result } = renderHook(() => useUpdateSettingsMutation(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ feed_mode: 'new' });
    });

    await waitFor(() => {
      expect(client.getQueryData<UserSettings>(queryKeys.settings())?.feed_mode).toBe('new');
    });

    act(() => {
      reject(new Error('network down'));
    });

    await waitFor(() => {
      expect(client.getQueryData<UserSettings>(queryKeys.settings())?.feed_mode).toBe('best');
    });
    expect(result.current.isError).toBe(true);
  });

  it('commits the optimistic update on success', async () => {
    const client = makeClient();
    client.setQueryData<UserSettings>(queryKeys.settings(), DEFAULT_USER_SETTINGS);
    mockedUpdate.mockResolvedValueOnce({ ...DEFAULT_USER_SETTINGS, feed_mode: 'sources' });

    const { result } = renderHook(() => useUpdateSettingsMutation(), { wrapper: wrapper(client) });
    act(() => {
      result.current.mutate({ feed_mode: 'sources' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData<UserSettings>(queryKeys.settings())?.feed_mode).toBe('sources');
  });
});
