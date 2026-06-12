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
vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,
    fetchSignalLedger: vi.fn().mockRejectedValue(new Error('offline')),
  };
});

const queries = await import('./queries.js');

const ENTRY: SignalLedgerEntry = {
  item_id: '22222222-2222-4222-8222-222222222222',
  story_title: 'Cached story',
  recorded_at: '2026-06-09T13:00:00.000Z',
  active_dwell_bucket: 'short',
  source_opened: false,
  context_opened: false,
  branch_depth_bucket: 'shallow',
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
});
