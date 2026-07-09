// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story detail page (WS-C.1.1b). The page deliberately does NOT surface the
// per-item distribution reason, the source/provenance line, or an "inspect
// signals" link: source provenance is a feed-card concern, and readers inspect
// their OWN reading signals from their profile (`/profile/signal-ledger`). This
// suite covers the WS-G.3.3 inline comment section — it embeds when the story
// carries a thread and is omitted otherwise — rendered inside a real
// (memory-history) router so route resolution is exercised for real.
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
import { render, screen } from '@testing-library/react';
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
  dispute_status: 'none',
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
    fetchStoryComments: vi.fn().mockResolvedValue({
      comments: [],
      next_cursor: null,
      overview: { comment_count: 0, sources_count: 0, corrections_count: 0 },
      summary: null,
    }),
  };
});

const { StoryDetailPage } = await import('./stories.js');
const { fetchStory } = await import('../../lib/api.js');

describe('StoryDetailPage conversation link (WS-G.3.3)', () => {
  const THREAD_ID = '44444444-4444-4444-8444-444444444444';

  function renderWithThreadRoute() {
    const rootRoute = createRootRoute({ component: Outlet });
    const storyRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/stories/$storyId',
      component: StoryDetailPage,
    });
    const threadRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/threads/$threadId',
      component: () => <h1>Thread</h1>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([storyRoute, threadRoute]),
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

  it('embeds the comment section when thread_id is present', async () => {
    vi.mocked(fetchStory).mockResolvedValueOnce({ ...STORY, thread_id: THREAD_ID });
    renderWithThreadRoute();
    expect(await screen.findByRole('region', { name: 'Conversation' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toBeInTheDocument();
  });

  it('omits the comment section when the story has no thread', async () => {
    vi.mocked(fetchStory).mockResolvedValueOnce({ ...STORY, thread_id: null });
    renderWithThreadRoute();
    // The story content has loaded…
    expect(await screen.findByText(STORY.body_summary)).toBeInTheDocument();
    // …but there is no embedded conversation affordance.
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument();
  });
});
