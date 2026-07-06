// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.3a/b — the room detail surface: a non-member of a private room sees
// ONLY the tier-one shell (badge + join affordance + honest-limits notice) and
// NO content; a member sees the room feed with the in-room chip on room_only
// items (public items carry no chip).
import type { FeedItem, RoomDetail } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth.js';
import { checkA11y } from '../../test/axe.js';
import { RoomDetailBody } from './rooms.js';

const searchMock = vi.hoisted(() => vi.fn((): Record<string, unknown> => ({})));
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
  useSearch: () => searchMock(),
}));

const roomFeed = vi.hoisted(() => vi.fn());
const joinRoom = vi.hoisted(() => vi.fn());
const leaveRoom = vi.hoisted(() => vi.fn());
vi.mock('../../lib/queries.js', () => ({
  useRoomFeedQuery: (_roomId: string, enabled: boolean) => roomFeed(enabled),
  useJoinRoomMutation: () => ({ mutate: joinRoom, isPending: false }),
  useLeaveRoomMutation: () => ({ mutate: leaveRoom, isPending: false }),
  // WS-G.2.2: the room action row now renders the posting-lens button (its own
  // set-lens mutation). It renders null for these fixtures (lenses: []), but the
  // hook still runs, so the mock must define it.
  useSetRoomLensMutation: () => ({ mutate: () => {}, isPending: false }),
  // WS-U: the room page now renders the "governed by" panel (its own query).
  useGovernedByQuery: () => ({
    isLoading: false,
    isError: false,
    data: { active: false, frozen: false, model_id: null, granted: [], recent_actions: [] },
  }),
  // WS-U: the steward model manager renders null for a non-steward with no
  // models, so an empty registry + null seat keeps these cases unchanged.
  useStewardSeatQuery: () => ({ data: { seat: null } }),
  useGovernanceModelsQuery: () => ({
    isLoading: false,
    isError: false,
    data: { steward_user_id: null, models: [] },
  }),
  useRatificationQuery: () => ({ isLoading: false, isError: false, data: { vote: null } }),
  useProposeModelMutation: () => ({ mutate: () => {}, isPending: false }),
  useOpenRatificationMutation: () => ({ mutate: () => {}, isPending: false }),
  useCastBallotMutation: () => ({ mutate: () => {}, isPending: false }),
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
    my_lens_id: null,
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
    topic_ids: [],
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

beforeEach(() => {
  // RoomMembership shows the join/leave affordance only to a signed-in reader (an
  // anonymous one is prompted to sign in); these cases test signed-in members.
  useAuthStore.setState({ status: 'authenticated', user: { id: 'u1' } } as never);
  searchMock.mockReturnValue({});
});
afterEach(() => {
  roomFeed.mockReset();
  joinRoom.mockReset();
  leaveRoom.mockReset();
  useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
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
      // Infinite-query shape (pages), with the explicit-continuation controls.
      data: {
        pages: [
          {
            items: [
              feedItem({ story_id: 's-pub', title: 'Public item', visibility: 'public' }),
              feedItem({ story_id: 's-room', title: 'In-room item', visibility: 'room_only' }),
            ],
            nextCursor: null,
          },
        ],
        pageParams: [null],
      },
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    });
    renderBody(baseRoom({ visibility: 'private', joined: true }));
    expect(roomFeed).toHaveBeenCalledWith(true); // content bar passed
    // Exactly one in-room chip (the room_only item); the public item has none.
    expect(screen.getAllByText('In room')).toHaveLength(1);
    expect(screen.getByText('Public item')).toBeInTheDocument();
    expect(screen.getByText('In-room item')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
  });

  it('opens the governance surface in a modal from the compact chrome row (WS-U)', () => {
    roomFeed.mockReturnValue({ isPending: false, data: undefined });
    // A public room a member can read → the governance chrome row renders.
    renderBody(baseRoom({ visibility: 'public', joined: true }));

    // The governance surface opens from a single compact button (shares the
    // membership action row); the modal is closed until the reader opens it.
    const trigger = screen.getByRole('button', { name: /^governance$/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: /governance, transparency & settings/i });
    expect(dialog).toBeInTheDocument();
    // Tabs separate the three concerns; Overview is the default and shows the
    // "governed by" transparency view (mocked as the platform baseline).
    expect(screen.getByRole('tablist', { name: /room governance sections/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /how it's governed/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText(/platform moderation baseline/i)).toBeInTheDocument();
    // A non-steward with the flag off sees no Settings tab.
    expect(screen.queryByRole('tab', { name: /^settings$/i })).not.toBeInTheDocument();
  });

  it('auto-opens the governance modal from the ?governance deep link (WS-U)', () => {
    roomFeed.mockReturnValue({ isPending: false, data: undefined });
    // The legacy /rooms/:id/governance route redirects here with ?governance=…;
    // the modal opens on render to the deep-linked tab.
    searchMock.mockReturnValue({ governance: 'models' });
    renderBody(baseRoom({ visibility: 'public', joined: true }));

    expect(
      screen.getByRole('dialog', { name: /governance, transparency & settings/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /models & voting/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('opens the modal when the ?governance param appears while already mounted (WS-U)', () => {
    roomFeed.mockReturnValue({ isPending: false, data: undefined });
    // Reader is already on the room page with the modal closed…
    searchMock.mockReturnValue({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const room = baseRoom({ visibility: 'public', joined: true });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <RoomDetailBody roomId="r1" room={room} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // …then follows the legacy /governance link, which redirects to change only the
    // search param on this already-mounted component; the modal must open.
    searchMock.mockReturnValue({ governance: 'overview' });
    rerender(
      <QueryClientProvider client={client}>
        <RoomDetailBody roomId="r1" room={room} />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole('dialog', { name: /governance, transparency & settings/i }),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations (tier-one shell + member feed)', async () => {
    roomFeed.mockReturnValue({ isPending: false, data: undefined });
    const shell = renderBody(baseRoom({ visibility: 'private', joined: false }));
    expect(await checkA11y(shell.container)).toHaveNoViolations();
    shell.unmount();

    roomFeed.mockReturnValue({
      isPending: false,
      data: {
        pages: [
          {
            items: [
              feedItem({ story_id: 's-room', title: 'In-room item', visibility: 'room_only' }),
            ],
            nextCursor: null,
          },
        ],
        pageParams: [null],
      },
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    });
    const feed = renderBody(baseRoom({ visibility: 'private', joined: true }));
    expect(await checkA11y(feed.container)).toHaveNoViolations();
  });
});
