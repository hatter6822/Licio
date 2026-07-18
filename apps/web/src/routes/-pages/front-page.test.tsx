// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Front-page pagination (WS-I.2.5 seen-aware cursor + WS-B.2.8b explicit gate):
// the ranked feed flattens the infinite pages, and a SECOND page loads ONLY when
// the reader presses the DiminishingReturnsPrompt — never from scrolling (§13.6).
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontPage } from './front-page.js';

const search = vi.hoisted(() => vi.fn<() => Record<string, unknown>>(() => ({})));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a href="#test" className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => search(),
  useRouterState: (opts: { select: (s: unknown) => unknown }) =>
    opts.select({ location: { pathname: '/' } }),
}));

const feed = vi.hoisted(() => vi.fn());
vi.mock('../../lib/queries.js', () => ({
  useFeedQuery: () => feed(),
  useUpdateDurablePrivacyMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

// dampenFeed is the PHI personalization pass; the H2 tests assert it runs only
// in the personalized mode (`best`). The default mock is a pass-through (the real
// multipliers are empty anyway); the "dampens in best" test overrides it to DROP
// an item so a dampened render is observable. Mock the loop tracker so real
// multipliers never interfere.
const dampenFeed = vi.hoisted(() => vi.fn((items: unknown[]) => items));
vi.mock('../../signals/topic-dampening.js', () => ({ dampenFeed }));
vi.mock('../../signals/topic-loops.js', () => ({
  getTopicLoopTracker: () => ({ topicMultipliers: () => new Map() }),
}));

vi.mock('../../stores/index.js', () => ({
  useUIStore: (sel: (s: { feedMode: string; setFeedMode: () => void }) => unknown) =>
    sel({ feedMode: 'best', setFeedMode: vi.fn() }),
  useAuthStore: (sel: (s: { status: string }) => unknown) => sel({ status: 'anonymous' }),
}));

function feedItem(id: string) {
  return {
    story_id: id,
    title: `Story ${id}`,
    source: 'Community submission',
    visibility: 'public',
    reading_minutes: 1,
    sources_count: 0,
    corrections: { active: 0, validated: 0, incorrect: 0 },
    context_chips: [],
    safety_state: 'ok',
    more_on_this_story: [],
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

beforeEach(() => {
  feed.mockReset();
  search.mockReturnValue({});
  dampenFeed.mockClear();
});
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

describe('FrontPage PHI dampening honors the reader-chosen mode (H2)', () => {
  it('dampens in the personalized mode (best)', () => {
    search.mockReturnValue({}); // ⇒ savedMode 'best'
    dampenFeed.mockImplementationOnce((items: unknown[]) => items.slice(0, 1));
    feed.mockReturnValue(infiniteFeed());
    render(<FrontPage />);
    expect(dampenFeed).toHaveBeenCalledTimes(1);
    // The mocked dampenFeed drops the second item ⇒ 'b' is thinned out.
    expect(screen.getByText('Story a')).toBeInTheDocument();
    expect(screen.queryByText('Story b')).not.toBeInTheDocument();
  });

  it('does NOT dampen in the `new` mode (a complete server timeline)', () => {
    search.mockReturnValue({ mode: 'new' });
    feed.mockReturnValue(infiniteFeed());
    render(<FrontPage />);
    expect(dampenFeed).not.toHaveBeenCalled();
    // Both items survive — nothing is dropped from the cursor chain locally.
    expect(screen.getByText('Story a')).toBeInTheDocument();
    expect(screen.getByText('Story b')).toBeInTheDocument();
  });

  it('does NOT dampen in an explicit metric sort (`rising` — a complete ordering)', () => {
    search.mockReturnValue({ mode: 'rising' });
    feed.mockReturnValue(infiniteFeed());
    render(<FrontPage />);
    expect(dampenFeed).not.toHaveBeenCalled();
    expect(screen.getByText('Story a')).toBeInTheDocument();
    expect(screen.getByText('Story b')).toBeInTheDocument();
  });
});
