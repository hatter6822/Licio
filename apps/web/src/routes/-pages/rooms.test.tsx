// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.3a/b — the room detail surface: a non-member of a private room sees
// ONLY the tier-one shell (badge + join affordance + honest-limits notice) and
// NO content; a member sees the room feed with the in-room chip on room_only
// items (public items carry no chip).
import type { FeedItem, RoomDetail } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import { RoomDetailBody } from './rooms.js';

vi.mock('@tanstack/react-router', () => ({
  // Forward className + aria-label so StoryFeedLink's stretched overlay link
  // keeps an accessible name in the test DOM (axe link-name).
  Link: ({
    children,
    className,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode;
    className?: string;
    'aria-label'?: string;
  }) => (
    <a href="#test" className={className} aria-label={ariaLabel}>
      {children}
    </a>
  ),
  useParams: () => ({ roomId: 'r1' }),
}));

const roomFeed = vi.hoisted(() => vi.fn());
const joinRoom = vi.hoisted(() => vi.fn());
vi.mock('../../lib/queries.js', () => ({
  useRoomFeedQuery: (_roomId: string, enabled: boolean) => roomFeed(enabled),
  useJoinRoomMutation: () => ({ mutate: joinRoom, isPending: false }),
  // WS-U: the room page now renders the "governed by" panel (its own query).
  useGovernedByQuery: () => ({
    isLoading: false,
    isError: false,
    data: { active: false, model_id: null, granted: [], recent_actions: [] },
  }),
}));

function baseRoom(over: Partial<RoomDetail>): RoomDetail {
  return {
    room_id: 'r1',
    name: 'Hydrology',
    slug: 'hydrology',
    room_type: 'global_topic',
    visibility: 'private',
    join_model: 'request_approval',
    posting_policy: 'all_members',
    description: 'Members-only water talk.',
    thread_count: 0,
    member_count: 3,
    latest_activity_at: null,
    governance_mode: 'ordinary',
    joined: false,
    created_at: '2026-01-01T00:00:00.000Z',
    lenses: [],
    stewards: [],
    governance: null,
    charter_summary: null,
    join_pending: false,
    can_post: false,
    ...over,
  };
}

function feedItem(over: Partial<FeedItem>): FeedItem {
  return {
    story_id: 's1',
    title: 'River levels',
    source: 'Delta Observer',
    origin: 'independent',
    reading_minutes: 3,
    rating_label: 'well-sourced',
    distribution_reason: 'Recent in this room',
    context_chips: [],
    safety_state: 'ok',
    exposure_label: null,
    more_on_this_story: [],
    context_card: null,
    ...over,
  } as FeedItem;
}

function renderBody(room: RoomDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RoomDetailBody roomId="r1" room={room} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  roomFeed.mockReset();
  joinRoom.mockReset();
});

describe('RoomDetailBody (WS-Q.5.3a/b)', () => {
  it('shows only the tier-one shell + join affordance for a private-room non-member', () => {
    roomFeed.mockReturnValue({ isPending: false, data: undefined });
    renderBody(baseRoom({ visibility: 'private', joined: false }));
    expect(screen.getByText('Private room')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /request to join/i })).toBeInTheDocument();
    expect(screen.getByText(/private from the public/i)).toBeInTheDocument();
    // The room feed is NOT fetched for a non-member (enabled=false).
    expect(roomFeed).toHaveBeenCalledWith(false);
  });

  it('shows a pending state for an applicant', () => {
    roomFeed.mockReturnValue({ isPending: false, data: undefined });
    renderBody(baseRoom({ joined: false, join_pending: true }));
    expect(screen.getByText(/pending a steward decision/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request to join/i })).not.toBeInTheDocument();
  });

  it('renders the feed with the in-room chip on room_only items for a member', () => {
    roomFeed.mockReturnValue({
      isPending: false,
      data: {
        items: [
          feedItem({ story_id: 's-pub', title: 'Public item', visibility: 'public' }),
          feedItem({ story_id: 's-room', title: 'In-room item', visibility: 'room_only' }),
        ],
        nextCursor: null,
      },
    });
    renderBody(baseRoom({ visibility: 'private', joined: true }));
    expect(roomFeed).toHaveBeenCalledWith(true); // content bar passed
    // Exactly one in-room chip (the room_only item); the public item has none.
    expect(screen.getAllByText('In room')).toHaveLength(1);
    expect(screen.getByText('Public item')).toBeInTheDocument();
    expect(screen.getByText('In-room item')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
  });

  it('has no accessibility violations (tier-one shell + member feed)', async () => {
    roomFeed.mockReturnValue({ isPending: false, data: undefined });
    const shell = renderBody(baseRoom({ visibility: 'private', joined: false }));
    expect(await checkA11y(shell.container)).toHaveNoViolations();
    shell.unmount();

    roomFeed.mockReturnValue({
      isPending: false,
      data: {
        items: [feedItem({ story_id: 's-room', title: 'In-room item', visibility: 'room_only' })],
        nextCursor: null,
      },
    });
    const feed = renderBody(baseRoom({ visibility: 'private', joined: true }));
    expect(await checkA11y(feed.container)).toHaveNoViolations();
  });
});
