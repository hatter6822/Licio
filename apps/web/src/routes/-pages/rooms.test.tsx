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
import { useUIStore } from '../../stores/ui.js';
import { checkA11y } from '../../test/axe.js';
import { RoomDetailBody, RoomDetailPage } from './rooms.js';

const ROOM_ID = '77777777-7777-4777-8777-777777777777';

const searchMock = vi.hoisted(() => vi.fn((): Record<string, unknown> => ({})));
const historyBack = vi.hoisted(() => vi.fn());
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
  useParams: () => ({ roomId: ROOM_ID }),
  useSearch: () => searchMock(),
  useNavigate: () => vi.fn(),
  // useGoBack (the banner's back button) retraces history.
  useCanGoBack: () => true,
  useRouter: () => ({ history: { back: historyBack } }),
}));
// The route-change focus/announcement hook reaches the router transition
// lifecycle; the banner's own behaviour is what these cases exercise.
vi.mock('./usePageFocus.js', () => ({ usePageFocus: vi.fn() }));

const roomFeed = vi.hoisted(() => vi.fn());
const joinRoom = vi.hoisted(() => vi.fn());
const leaveRoom = vi.hoisted(() => vi.fn());
const roomQuery = vi.hoisted(() => vi.fn());
vi.mock('../../lib/queries.js', () => ({
  useRoomFeedQuery: (_roomId: string, enabled: boolean) => roomFeed(enabled),
  // RoomDetailPage's own read (the banner + the governance modal both need the
  // loaded room); the body-only cases never reach it.
  useRoomQuery: () => roomQuery(),
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
    room_id: ROOM_ID,
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
    reading_minutes: 3,
    sources_count: 0,
    corrections: { active: 0, validated: 0, incorrect: 0 },
    context_chips: [],
    safety_state: 'ok',
    more_on_this_story: [],
    topic_ids: [],
    ...over,
  } as FeedItem;
}

function renderBody(room: RoomDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RoomDetailBody roomId={ROOM_ID} room={room} />
    </QueryClientProvider>,
  );
}

/** The whole route: banner (back + the two circular actions) + body + the
 *  governance modal the banner opens. */
function renderPage(room: RoomDetail) {
  roomQuery.mockReturnValue({
    data: room,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RoomDetailPage />
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

  it('opens the governance surface in a modal from the banner button (WS-U)', () => {
    roomFeed.mockReturnValue({ isPending: false, data: undefined });
    // A public room a member can read → both banner actions render.
    renderPage(baseRoom({ visibility: 'public', joined: true }));

    // The governance surface opens from the banner's circular button; the modal
    // is closed until the reader opens it (the modal subtree is not mounted).
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
    renderPage(baseRoom({ visibility: 'public', joined: true }));

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
    const room = baseRoom({ visibility: 'public', joined: true });
    roomQuery.mockReturnValue({ data: room, isLoading: false, isError: false, refetch: vi.fn() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <RoomDetailPage />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // …then follows the legacy /governance link, which redirects to change only the
    // search param on this already-mounted component; the modal must open.
    searchMock.mockReturnValue({ governance: 'overview' });
    rerender(
      <QueryClientProvider client={client}>
        <RoomDetailPage />
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

// WS-B.1.5 + WS-Q.2.5b + WS-U §24.6 — the room banner carries navigation only:
// back at the inline-start, room-scoped search and governance at the
// inline-end, and the (unbounded) room NAME as the page <h1> in the body.
describe('RoomDetailPage banner', () => {
  beforeEach(() => {
    roomFeed.mockReturnValue({ isPending: false, data: undefined });
  });

  it('puts the room name in the body <h1>, not the bar, and offers both actions', () => {
    renderPage(baseRoom({ visibility: 'public', joined: true, name: 'Hydrology' }));
    const heading = screen.getByRole('heading', { level: 1, name: 'Hydrology' });
    // The <h1> is the WS-B.1.6 focus target and must NOT be hidden the way a
    // titleReplacement heading is — it is the visible page title now.
    expect(heading.className.split(/\s+/)).not.toContain('sr-only');
    // The bar itself no longer carries the name.
    expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search this room' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Governance' })).toBeInTheDocument();
  });

  it('scopes the search modal to this room', async () => {
    renderPage(baseRoom({ visibility: 'public', joined: true, name: 'Hydrology' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search this room' }));
    const { searchOpen, searchScope } = useUIStore.getState();
    expect(searchOpen).toBe(true);
    expect(searchScope).toEqual({ kind: 'room', roomId: ROOM_ID, label: 'Hydrology' });
    useUIStore.getState().closeSearch();
  });

  it('offers neither action below the tier-two bar (signed-in private-room non-member)', () => {
    renderPage(baseRoom({ visibility: 'private', joined: false }));
    expect(screen.queryByRole('button', { name: 'Search this room' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /governance/i })).not.toBeInTheDocument();
  });

  it('gives an ANONYMOUS reader the sign-in circle in the governance slot', () => {
    useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
    renderPage(baseRoom({ visibility: 'public', joined: false }));
    // One slot, blue while signed out: the governance trigger is not rendered…
    expect(screen.queryByRole('button', { name: /governance/i })).not.toBeInTheDocument();
    const signIn = screen.getByRole('link', { name: /sign in/i });
    expect(signIn.className.split(/\s+/)).toContain('bg-primary');
    // …and it is the ONLY sign-in affordance: the membership row's full-width
    // primary button AND its "Sign in to join this room." caption are both gone,
    // so the instruction is not repeated below the room description.
    expect(screen.getAllByRole('link', { name: /sign in/i })).toHaveLength(1);
    expect(screen.queryByText(/sign in to join this room/i)).not.toBeInTheDocument();
  });

  it('keeps the sign-in circle even below the tier-two bar (that is how you get past it)', () => {
    useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
    renderPage(baseRoom({ visibility: 'private', joined: false }));
    expect(screen.queryByRole('button', { name: 'Search this room' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
  });

  it('has no accessibility violations with the banner actions rendered', async () => {
    const page = renderPage(baseRoom({ visibility: 'public', joined: true }));
    expect(await checkA11y(page.container)).toHaveNoViolations();
  });
});
