// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Front-page pagination (WS-I.2.5 seen-aware cursor + WS-B.2.8b explicit gate):
// the ranked feed flattens the infinite pages, and a SECOND page loads ONLY when
// the reader presses the DiminishingReturnsPrompt — never from scrolling (§13.6).
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontPage } from './front-page.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a href="#test" className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useRouterState: (opts: { select: (s: unknown) => unknown }) =>
    opts.select({ location: { pathname: '/' } }),
}));

const feed = vi.hoisted(() => vi.fn());
vi.mock('../../lib/queries.js', () => ({
  useFeedQuery: () => feed(),
  useUpdateDurablePrivacyMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../stores/index.js', () => ({
  useUIStore: (sel: (s: { feedMode: string; setFeedMode: () => void }) => unknown) =>
    sel({ feedMode: 'balanced', setFeedMode: vi.fn() }),
  useAuthStore: (sel: (s: { status: string }) => unknown) => sel({ status: 'anonymous' }),
}));

function feedItem(id: string) {
  return {
    story_id: id,
    title: `Story ${id}`,
    source: 'Community submission',
    origin: 'independent',
    visibility: 'public',
    reading_minutes: 1,
    rating_label: 'getting-attention',
    distribution_reason: 'Shown chronologically.',
    context_chips: [],
    safety_state: 'ok',
    exposure_label: null,
    more_on_this_story: [],
    context_card: null,
    topic_ids: [],
  };
}

function infiniteFeed(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      pages: [{ items: [feedItem('a'), feedItem('b')], nextCursor: 'cursor-1' }],
      pageParams: [null],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => feed.mockReset());
afterEach(() => vi.clearAllMocks());

describe('FrontPage pagination (WS-B.2.8b explicit continuation)', () => {
  it('renders the flattened feed items', () => {
    feed.mockReturnValue(infiniteFeed());
    render(<FrontPage />);
    expect(screen.getByText('Story a')).toBeInTheDocument();
    expect(screen.getByText('Story b')).toBeInTheDocument();
  });

  it('shows the DiminishingReturnsPrompt when another page exists and loads it on press', async () => {
    const fetchNextPage = vi.fn();
    feed.mockReturnValue(infiniteFeed({ fetchNextPage }));
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<FrontPage />);
    const button = screen.getByRole('button', { name: /show lower-confidence stories/i });
    expect(button).toBeInTheDocument();
    await userEvent.setup().click(button);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('does NOT show the prompt when there is no next page', () => {
    feed.mockReturnValue(
      infiniteFeed({
        data: { pages: [{ items: [feedItem('a')], nextCursor: null }], pageParams: [null] },
        hasNextPage: false,
      }),
    );
    render(<FrontPage />);
    expect(
      screen.queryByRole('button', { name: /show lower-confidence stories/i }),
    ).not.toBeInTheDocument();
  });

  it('does not re-trigger a fetch while the next page is already loading', async () => {
    const fetchNextPage = vi.fn();
    feed.mockReturnValue(infiniteFeed({ fetchNextPage, isFetchingNextPage: true }));
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<FrontPage />);
    await userEvent.setup().click(screen.getByRole('button', { name: /loading/i }));
    expect(fetchNextPage).not.toHaveBeenCalled();
  });
});
