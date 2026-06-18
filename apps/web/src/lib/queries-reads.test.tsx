// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_NOTIFICATION_PREFERENCES, DEFAULT_USER_SETTINGS } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,
    fetchFeed: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    fetchStory: vi.fn().mockResolvedValue({ story_id: 's' }),
    fetchThread: vi.fn().mockResolvedValue({ thread_id: 't' }),
    fetchRooms: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    fetchRoom: vi.fn().mockResolvedValue({ room_id: 'r' }),
    fetchStoryComments: vi.fn().mockResolvedValue({
      comments: [],
      next_cursor: null,
      overview: { comment_count: 0, sources_count: 0, corrections_count: 0 },
      summary: null,
    }),
    fetchSettings: vi.fn().mockResolvedValue(DEFAULT_USER_SETTINGS),
    fetchSignalLedger: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    fetchNotificationPreferences: vi.fn().mockResolvedValue(DEFAULT_NOTIFICATION_PREFERENCES),
  };
});

const queries = await import('./queries.js');

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('read hooks', () => {
  it('useFeedQuery fetches and validates the feed', async () => {
    const { result } = renderHook(() => queries.useFeedQuery('chronological'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ items: [], nextCursor: null });
  });

  it('detail + collection hooks all resolve', async () => {
    const hooks: Array<() => { isSuccess: boolean }> = [
      () => queries.useStoryQuery('s'),
      () => queries.useThreadQuery('t'),
      () => queries.useStoryCommentsQuery('11111111-1111-4111-8111-111111111111'),
      () => queries.useRoomsQuery(),
      () => queries.useRoomQuery('r'),
      () => queries.useSettingsQuery(),
      () => queries.useSignalLedgerQuery(),
      () => queries.useNotificationPreferencesQuery(),
    ];
    for (const hook of hooks) {
      const { result } = renderHook(hook, { wrapper: wrapper() });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    }
  });
});
