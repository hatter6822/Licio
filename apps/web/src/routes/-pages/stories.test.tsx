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
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../../stores/ui.js';

const STORY: StoryDetail = {
  story_id: '33333333-3333-4333-8333-333333333333',
  title: 'Regional water board publishes the full testing dataset',
  source: 'Public Records Office',
  url: 'https://example.org/water-testing-dataset',
  reading_minutes: 6,
  sources_count: 2,
  corrections: { active: 0, validated: 0, incorrect: 0 },
  more_on_this_story: [],
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

  // The story is ONE card — headline, summary, source — and for a link story
  // the card itself is the control that opens the in-app reader. The old
  // full-width "Read source" button is gone with it.
  it('makes the article card the affordance that opens the source', async () => {
    vi.mocked(fetchStory).mockResolvedValueOnce({ ...STORY, thread_id: null });
    renderWithThreadRoute();
    const card = await screen.findByRole('button', {
      name: `Read the source for ${STORY.title}`,
    });
    // The heading and the summary live INSIDE that card, not as loose sections.
    const article = card.closest('article') as HTMLElement;
    expect(within(article).getByRole('heading', { level: 1, name: STORY.title })).toBeVisible();
    expect(within(article).getByText(STORY.body_summary)).toBeVisible();
    // No wide text button duplicating what the card now does.
    expect(screen.queryByRole('button', { name: 'Read source' })).not.toBeInTheDocument();
  });

  it('reduces the action row to named icon-only controls', async () => {
    vi.mocked(fetchStory).mockResolvedValueOnce({ ...STORY, thread_id: THREAD_ID });
    renderWithThreadRoute();
    // Each icon control keeps a real accessible NAME (icon-only is a visual
    // economy, never an unlabelled control) …
    for (const name of ['Correct this story', 'Save for offline', 'Share', 'Report this story']) {
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
    }
    // … and carries no visible text label beside the glyph.
    expect((await screen.findByRole('button', { name: 'Share' })).textContent).toBe('');
    // The save control is a toggle, so its state is exposed as pressed-ness.
    expect(screen.getByRole('button', { name: 'Save for offline' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('keeps EXACTLY one <h1> once the card renders its own headline', async () => {
    vi.mocked(fetchStory).mockResolvedValueOnce({ ...STORY, thread_id: null });
    renderWithThreadRoute();
    await screen.findByText(STORY.body_summary);
    // The scaffold withdraws its own body title on the content frame rather
    // than leaving a duplicate that would steal the WS-B.1.6 route-change
    // focus and announce the page twice. (The scaffold's heading on the
    // loading/error frames is covered in PageScaffold.test.tsx, where the
    // query state is driven directly instead of raced against the router.)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  // WS-B.1.5 + WS-T.7.3 — the banner carries navigation only: back at the
  // inline-start, story-scoped search at the inline-end, and the (unbounded)
  // story TITLE as the page <h1> in the body.
  it('puts the story title in the body <h1> and scopes the banner search to it', async () => {
    vi.mocked(fetchStory).mockResolvedValueOnce({ ...STORY, thread_id: null });
    renderWithThreadRoute();
    const heading = await screen.findByRole('heading', { level: 1, name: STORY.title });
    expect(heading.className.split(/\s+/)).not.toContain('sr-only');

    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }));
    // The conversation leads (the default); the home room follows once its
    // read resolves, and the dialog appends "All of Licio".
    expect(useUIStore.getState().searchScopes[0]).toEqual({
      kind: 'story',
      storyId: STORY.story_id,
      label: STORY.title,
    });
    useUIStore.getState().closeSearch();
  });
});
