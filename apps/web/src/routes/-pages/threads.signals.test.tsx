// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression: the thread detail page must treat the THREAD as the attended item
// and record branch traversal as a sub-signal — it must NOT re-open the active
// item on every branch switch, nor upload attention per navigation. The old code
// keyed the active-item effect on `[threadId, branch]`, so each branch tap fired
// `setActiveStory(null) → flush()` (a POST /v1/attention/aggregates); a handful of
// taps tripped the per-user ingestion rate limit and the UI logged 429s. Uploads
// are interval-batched (WS-C.4.4), never per interaction.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  threadId: '55555555-5555-4555-8555-555555555555',
  branch: 'overview',
  processor: {
    setActiveStory: vi.fn(),
    recordBranchVisit: vi.fn(),
    flush: vi.fn(),
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ threadId: h.threadId }),
  useSearch: () => ({ branch: h.branch }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children?: ReactNode }) => <a href="#test">{children}</a>,
}));
vi.mock('./usePageFocus.js', () => ({ usePageFocus: () => {} }));
vi.mock('../../lib/queries.js', () => ({
  useThreadsQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  // Loading keeps the render minimal (no branch panel); the signal effects, which
  // live above the conditional return, still run on mount/update/unmount.
  useThreadQuery: () => ({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() }),
  useThreadBranchQuery: () => ({
    data: undefined,
    isLoading: true,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../offline/read-through.js', () => ({
  readThreadSnapshot: () => Promise.resolve(undefined),
}));
vi.mock('../../signals/runtime.js', () => ({ getSignalProcessor: () => h.processor }));

const { ThreadDetailPage } = await import('./threads.js');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadDetailPage />
    </QueryClientProvider>,
  );
}

describe('ThreadDetailPage attention wiring (no per-branch upload)', () => {
  beforeEach(() => {
    h.branch = 'overview';
    h.processor.setActiveStory.mockClear();
    h.processor.recordBranchVisit.mockClear();
    h.processor.flush.mockClear();
  });

  it('activates the thread once, records the initial branch, and does not upload', () => {
    renderPage();
    expect(h.processor.setActiveStory).toHaveBeenCalledTimes(1);
    expect(h.processor.setActiveStory).toHaveBeenCalledWith(h.threadId);
    expect(h.processor.recordBranchVisit).toHaveBeenCalledWith(h.threadId, 'overview');
    expect(h.processor.flush).not.toHaveBeenCalled();
  });

  it('records every branch switch without re-opening the item or uploading', () => {
    const { rerender } = renderPage();
    // Switch through the remaining branches — the flood path. Each must record a
    // distinct-branch visit, but the active item must not churn and nothing may
    // upload, no matter how rapidly the reader taps.
    for (const branch of ['questions', 'evidence', 'challenges', 'lenses', 'chronology']) {
      h.branch = branch;
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <ThreadDetailPage />
        </QueryClientProvider>,
      );
      expect(h.processor.recordBranchVisit).toHaveBeenCalledWith(h.threadId, branch);
    }
    // Exactly one activation (the mount) across all five switches; never deactivated
    // mid-thread; never an eager per-navigation upload.
    expect(h.processor.setActiveStory).toHaveBeenCalledTimes(1);
    expect(h.processor.setActiveStory).not.toHaveBeenCalledWith(null);
    expect(h.processor.flush).not.toHaveBeenCalled();
  });

  it('captures the aggregate on leaving the thread, still without an eager upload', () => {
    const { unmount } = renderPage();
    h.processor.setActiveStory.mockClear();
    unmount();
    // Leaving is the "done attending" boundary: deactivate (which snapshots the
    // §22.1 aggregate into the buffer). Upload remains the interval's job.
    expect(h.processor.setActiveStory).toHaveBeenCalledWith(null);
    expect(h.processor.flush).not.toHaveBeenCalled();
  });
});
