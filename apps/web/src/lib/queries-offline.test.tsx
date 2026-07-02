// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import type { SignalLedgerEntry } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheSignalLedger, saveStory } from '../offline/read-through.js';
import { savedStories, signalLedger } from '../offline/store.js';

// Simulate offline for the network reads under test; the offline read-through
// should serve the IndexedDB snapshot instead of surfacing the error.
const emitContentSaved = vi.hoisted(() => vi.fn());
vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,
    fetchSignalLedger: vi.fn().mockRejectedValue(new Error('offline')),
    emitContentSaved,
  };
});

const queries = await import('./queries.js');
const { useAuthStore } = await import('../stores/auth.js');
const { getSignalProcessor } = await import('../signals/runtime.js');

/** The collection policy an authenticated, personalization-ON reader has. */
const COLLECTING_ON = { collect: true, privacyLevel: 'standard' as const, identifier: 'user-1' };
const COLLECTING_OFF = {
  collect: false,
  privacyLevel: 'standard' as const,
  identifier: 'privacy-bucket',
};

const ENTRY: SignalLedgerEntry = {
  item_id: '22222222-2222-4222-8222-222222222222',
  story_title: 'Cached story',
  recorded_at: '2026-06-09T13:00:00.000Z',
  active_dwell_bucket: 'short',
  source_opened: false,
  context_opened: false,
  reply_depth_bucket: 'shallow',
  return_visit_count_bucket: 'none',
  cap_reached: false,
};

const SAVED_STORY = {
  story_id: '11111111-1111-4111-8111-111111111111',
  title: 'Saved offline',
  source: 'example.org',
  origin: 'independent' as const,
  url: 'https://example.org/a',
  reading_minutes: 3,
  rating_label: 'well-sourced' as const,
  exposure_label: null,
  more_on_this_story: [],
  context_card: null,
  distribution_reason: 'reason',
  context_chips: [],
  safety_state: 'ok' as const,
  body_summary: 'summary',
  thread_id: null,
  topic_ids: [],
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(async () => {
  await Promise.all([signalLedger.clear(), savedStories.clear()]);
  // Reset the singleton processor's collection policy between tests so save-signal
  // emission is governed only by what each test sets (the default is collect off).
  getSignalProcessor().setCollectionPolicy(COLLECTING_OFF);
});

describe('offline read-through hooks', () => {
  it('useSignalLedgerQuery falls back to the cached ledger when offline', async () => {
    await cacheSignalLedger([ENTRY]);
    const { result } = renderHook(() => queries.useSignalLedgerQuery(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items).toEqual([ENTRY]);
  });

  it('useSignalLedgerQuery surfaces the error when nothing is cached', async () => {
    const { result } = renderHook(() => queries.useSignalLedgerQuery(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('useSavedStoriesQuery lists stories saved for offline reading', async () => {
    await saveStory(SAVED_STORY);
    const { result } = renderHook(() => queries.useSavedStoriesQuery(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.storyId).toBe(SAVED_STORY.story_id);
  });

  it('emits the §5.3 content.saved signal on SAVE when authenticated, never on unsave', async () => {
    emitContentSaved.mockReset().mockResolvedValue(undefined);
    useAuthStore.setState({
      status: 'authenticated',
      user: { id: 'user-1', account_state: 'active' } as never,
    });
    getSignalProcessor().setCollectionPolicy(COLLECTING_ON);
    const { result } = renderHook(() => queries.useToggleSavedStoryMutation(), {
      wrapper: wrapper(),
    });
    result.current.mutate({ action: 'save', story: SAVED_STORY });
    await waitFor(() =>
      expect(emitContentSaved).toHaveBeenCalledWith(SAVED_STORY.story_id, 'user-1'),
    );
    // Unsave never emits the signal.
    emitContentSaved.mockClear();
    result.current.mutate({ action: 'unsave', storyId: SAVED_STORY.story_id });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(emitContentSaved).not.toHaveBeenCalled();
  });

  it('does NOT emit the save signal when the session is not authenticated', async () => {
    emitContentSaved.mockReset().mockResolvedValue(undefined);
    useAuthStore.setState({ status: 'unauthenticated', user: null });
    const { result } = renderHook(() => queries.useToggleSavedStoryMutation(), {
      wrapper: wrapper(),
    });
    result.current.mutate({ action: 'save', story: SAVED_STORY });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(emitContentSaved).not.toHaveBeenCalled(); // private local save only
  });

  it('does NOT emit the save signal when collection/personalization is disabled', async () => {
    // Authenticated but personalization OFF ⇒ the same client gate the signal
    // processor uses must suppress the emit, so an opted-out save never crosses
    // the network boundary (WS-C.4.1d) — not merely gets discarded server-side.
    emitContentSaved.mockReset().mockResolvedValue(undefined);
    useAuthStore.setState({
      status: 'authenticated',
      user: { id: 'user-1', account_state: 'active' } as never,
    });
    getSignalProcessor().setCollectionPolicy(COLLECTING_OFF);
    const { result } = renderHook(() => queries.useToggleSavedStoryMutation(), {
      wrapper: wrapper(),
    });
    result.current.mutate({ action: 'save', story: SAVED_STORY });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(emitContentSaved).not.toHaveBeenCalled();
  });
});
