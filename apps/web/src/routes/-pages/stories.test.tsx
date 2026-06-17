// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story detail page (WS-C.1.1b + the WS-I.2.6b explanation surface): the
// served distribution reason renders verbatim, and the "Inspect your reading
// signals" link resolves to the reader's OWN Signal Ledger (SPEC §13.5 —
// explanations are inspectable; the ledger shows the exact bucketed signals
// behind them). Rendered inside a real (memory-history) router so the link
// target is proven to RESOLVE, not just to exist as an href.
import 'fake-indexeddb/auto';
import type { StoryDetail } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const STORY: StoryDetail = {
  story_id: '33333333-3333-4333-8333-333333333333',
  title: 'Regional water board publishes the full testing dataset',
  source: 'Public Records Office',
  origin: 'official',
  url: 'https://example.org/water-testing-dataset',
  reading_minutes: 6,
  rating_label: 'well-sourced',
  exposure_label: null,
  more_on_this_story: [],
  context_card: null,
  distribution_reason:
    'Rising because readers opened the source and added 2 independent evidence cards.',
  context_chips: [],
  safety_state: 'ok',
  body_summary: 'The board released raw and processed results alongside the methodology.',
  thread_id: null,
  topic_ids: ['water-quality'],
};

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api.js')>();
  return {
    ...actual,
    fetchStory: vi.fn().mockResolvedValue(STORY),
    fetchStoryInterpretations: vi.fn().mockRejectedValue(new Error('not computed')),
    fetchIndependentSources: vi.fn().mockRejectedValue(new Error('not computed')),
  };
});

const { StoryDetailPage } = await import('./stories.js');
const { fetchStory } = await import('../../lib/api.js');

function renderStoryPage() {
  const rootRoute = createRootRoute({ component: Outlet });
  const storyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/stories/$storyId',
    component: StoryDetailPage,
  });
  const ledgerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/profile/signal-ledger',
    component: () => <h1>Signal Ledger</h1>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([storyRoute, ledgerRoute]),
    history: createMemoryHistory({ initialEntries: [`/stories/${STORY.story_id}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return router;
}

describe('StoryDetailPage explanation surface (WS-I.2.6b / §13.5)', () => {
  it('renders the served distribution reason verbatim', async () => {
    renderStoryPage();
    expect(await screen.findByText(STORY.distribution_reason)).toBeInTheDocument();
  });

  it('links "Inspect your reading signals" to the Signal Ledger — and it resolves', async () => {
    const router = renderStoryPage();
    const link = await screen.findByRole('link', { name: 'Inspect your reading signals' });
    expect(link).toHaveAttribute('href', '/profile/signal-ledger');
    await userEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe('/profile/signal-ledger'));
    expect(await screen.findByRole('heading', { name: 'Signal Ledger' })).toBeInTheDocument();
  });
});

describe('StoryDetailPage conversation link (WS-G.3.3)', () => {
  const THREAD_ID = '44444444-4444-4444-8444-444444444444';

  function renderWithThreadRoute() {
    const rootRoute = createRootRoute({ component: Outlet });
    const storyRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/stories/$storyId',
      component: StoryDetailPage,
    });
    const ledgerRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/profile/signal-ledger',
      component: () => <h1>Signal Ledger</h1>,
    });
    const threadRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/threads/$threadId',
      component: () => <h1>Thread</h1>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([storyRoute, ledgerRoute, threadRoute]),
      history: createMemoryHistory({ initialEntries: [`/stories/${STORY.story_id}`] }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    return router;
  }

  it('shows "View the conversation" and navigates to the thread when thread_id is present', async () => {
    vi.mocked(fetchStory).mockResolvedValueOnce({ ...STORY, thread_id: THREAD_ID });
    const router = renderWithThreadRoute();
    const link = await screen.findByRole('link', { name: 'View the conversation' });
    await userEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/threads/${THREAD_ID}`));
    expect(await screen.findByRole('heading', { name: 'Thread' })).toBeInTheDocument();
  });

  it('omits the conversation link when the story has no thread', async () => {
    vi.mocked(fetchStory).mockResolvedValueOnce({ ...STORY, thread_id: null });
    renderWithThreadRoute();
    // The story content has loaded…
    expect(await screen.findByText(STORY.distribution_reason)).toBeInTheDocument();
    // …but there is no conversation affordance.
    expect(screen.queryByRole('link', { name: 'View the conversation' })).not.toBeInTheDocument();
  });
});
