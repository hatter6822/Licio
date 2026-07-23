// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rooms (WS-C.1.1a/b). The /rooms tab lists topic/local rooms and community
// lenses; the detail route shows a room. The WS-U room-governance surface opens
// in a modal ON the room page (deep-linkable via `?governance=<tab>`); the legacy
// `/rooms/:id/governance` route redirects here rather than showing an inert stub.
//
// The room banner carries NAVIGATION ONLY — the back button at the
// inline-start and, symmetrically opposite it, the two circular actions this
// page owns: room-scoped search (WS-Q.2.5b) and the governance modal
// (WS-U §24.6). The room NAME is unbounded, so it leads the page body as the
// <h1> instead of squeezing those controls out of the bar.
import type { RoomDetail } from '@licio/shared';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { DiminishingReturnsPrompt } from '../../components/feed/DiminishingReturnsPrompt/DiminishingReturnsPrompt.js';
import { GovernanceButton } from '../../components/governance/GovernanceButton.js';
import { RoomGovernanceDialog } from '../../components/governance/RoomGovernanceDialog.js';
import { RoomCreateForm } from '../../components/rooms/RoomCreateForm/index.js';
import {
  RoomLensButton,
  roomLensButtonApplies,
} from '../../components/rooms/RoomLensControl/index.js';
import { RoomMembership } from '../../components/rooms/RoomMembership/index.js';
import { SearchButton } from '../../components/search/SearchButton/index.js';
import { StoryFeedLink } from '../../components/story/StoryFeedLink/index.js';
import { GovernanceModeBadge } from '../../components/treasury/GovernanceModeBadge.js';
import { Button } from '../../components/ui/Button/index.js';
import { Dialog } from '../../components/ui/Dialog/index.js';
import { Icon } from '../../components/ui/Icon/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { RestrictedState } from '../../components/ui/RestrictedState/index.js';
import { useGoBack } from '../../hooks/useGoBack.js';
import { useT } from '../../i18n/index.js';
import { cn } from '../../lib/cn.js';
import {
  useGovernedByQuery,
  useRoomFeedQuery,
  useRoomQuery,
  useRoomsQuery,
} from '../../lib/queries.js';
import { raisedInteractive, raisedSurface } from '../../lib/surfaces.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { selectContentSurface, useFeatureFlagStore } from '../../stores/index.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

export function RoomsPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.rooms', 'Rooms'));
  const navigate = useNavigate();
  const rooms = useRoomsQuery();
  // WS-Q.6.2 — the new room controls appear only when the rollout flag is on.
  const binaryVisibilityUi = useFeatureFlagStore(selectContentSurface).binary_visibility_ui;
  const [showCreate, setShowCreate] = useState(false);
  return (
    <>
      <PageScaffold
        title={t('nav.rooms', 'Rooms')}
        actions={
          binaryVisibilityUi ? (
            <Button variant="secondary" onClick={() => setShowCreate(true)}>
              {t('rooms.create.open', 'Create a room')}
            </Button>
          ) : undefined
        }
        query={rooms}
        isEmpty={(data) => data.items.length === 0}
        emptyTitle={t('rooms.empty.title', 'No rooms yet')}
        emptyDescription={t(
          'rooms.empty.description',
          'Topic rooms and community lenses appear here.',
        )}
      >
        {(data) => (
          <ul className="flex flex-col gap-4">
            {data.items.map((room) => (
              <li key={room.room_id}>
                <Link
                  to="/rooms/$roomId"
                  params={{ roomId: room.room_id }}
                  className={cn(
                    'flex items-center justify-between gap-3 p-4',
                    raisedSurface,
                    raisedInteractive,
                  )}
                >
                  <span className="font-medium text-ink">{room.name}</span>
                  <span className="flex items-center gap-2 text-ink-muted">
                    {/* Private rooms are discoverable at tier one (existence is
                      universal); counts are public-only (no oracle). */}
                    {room.visibility === 'private' ? (
                      <span className="inline-flex items-center rounded-full bg-surface-strong px-2 py-0.5 font-medium text-ink-muted text-xs">
                        {t('room.badge.private', 'Private room')}
                      </span>
                    ) : null}
                    <Icon name="chevron-right" className="size-5" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageScaffold>
      {/* Create-a-room lives in a modal (portaled to <body>) so it opens from the
          header action over ANY list state — including the empty state, where the
          scaffold renders its EmptyState instead of children. */}
      {binaryVisibilityUi ? (
        <Dialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          title={t('rooms.create.title', 'Create a room')}
        >
          <RoomCreateForm
            onCreated={(roomId) => {
              setShowCreate(false);
              void navigate({ to: '/rooms/$roomId', params: { roomId } });
            }}
          />
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * WS-Q.5.3a tier-two bar, client mirror. Public rooms are readable by all;
 * private rooms need ACTIVE membership OR a steward role — the server bar
 * (roomContentVisibleToUser) allows stewards, and a freshly-created private
 * room makes its creator a steward WITHOUT an active subscription, so `joined`
 * alone would wrongly show that steward the join UI and never load the feed.
 * ONE function, so the banner (which decides whether to offer scoped search +
 * governance) and the body (which decides whether to load the feed) can never
 * disagree about what this reader may see.
 */
export function roomContentVisible(room: RoomDetail): boolean {
  return room.visibility !== 'private' || room.joined || room.is_steward === true;
}

export function RoomDetailPage(): React.ReactElement {
  const t = useT();
  const { roomId } = useParams({ from: '/rooms_/$roomId' });
  usePageFocus(t('room.title', 'Room'));
  const room = useRoomQuery(roomId);
  const navigate = useNavigate();
  // Return to wherever the room was opened from (the rooms list, a link, a
  // profile); a cold-loaded deep link falls back (replacing) to the rooms list.
  const goBack = useGoBack(() => void navigate({ to: '/rooms', replace: true }));
  // WS-Q.6.2 — the steward-only settings tab is part of the flag-gated controls.
  const binaryVisibilityUi = useFeatureFlagStore(selectContentSurface).binary_visibility_ui;
  // WS-U §24.6 — the governance surface opens in a focused modal whose trigger
  // is the banner's circular button (right-justified beside scoped search,
  // symmetrically opposite the back button). The full-width "Governance" button
  // that used to sit in the membership action row is gone: governance is a
  // room-wide context, not an action on the content below it. A
  // `?governance=<tab>` deep link (the legacy /rooms/:id/governance route
  // redirects here) opens the modal to that tab.
  const governanceParam = useSearch({ from: '/rooms_/$roomId' }).governance;
  const [governanceOpen, setGovernanceOpen] = useState(() => governanceParam != null);
  // Open the modal when the deep-link param appears — INCLUDING a param change
  // while this component is already mounted (the legacy /governance route redirects
  // to `?governance=…`; a reader already on the room page keeps this component, so
  // the mount-time initializer above would otherwise miss it and the modal would
  // stay closed despite the advertised deep link).
  useEffect(() => {
    if (governanceParam != null) setGovernanceOpen(true);
  }, [governanceParam]);
  const data = room.data;
  const contentVisible = data !== undefined && roomContentVisible(data);
  // WS-U §24.6 — shares GovernedByPanel's cached query (same key) purely so the
  // banner button can mark an active in-room AI agent at a glance, without
  // opening the modal.
  const governedBy = useGovernedByQuery(roomId, contentVisible);
  const roomName = data?.name ?? t('room.title', 'Room');

  if (!isValidUuidParam(roomId)) {
    return (
      <>
        <PageHeader title={t('room.title', 'Room')} />
        <div className="mx-auto w-full max-w-2xl p-4">
          <RestrictedState
            title={t('room.invalid.title', 'This link is not valid')}
            reason={t('room.invalid.reason', 'The room address is malformed.')}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageScaffold
        title={roomName}
        // Room names are unbounded — the <h1> leads the page body and the
        // banner carries navigation only (WS-B.1.5).
        titlePlacement="body"
        onBack={goBack}
        actions={
          <>
            {/* Search is gated on the tier-two bar: outside it there is no room
                content to search. Governance gates itself — it is the SIGN-IN
                affordance for a signed-out reader (bar or no bar), and nothing
                for a signed-in reader who cannot yet read the room. */}
            {contentVisible ? (
              <SearchButton scope={{ kind: 'room', roomId, label: roomName }} />
            ) : null}
            <GovernanceButton
              onOpen={() => setGovernanceOpen(true)}
              agentActive={governedBy.data?.active === true}
              signInRedirect={`/rooms/${roomId}`}
              reachable={contentVisible}
            />
          </>
        }
        query={room}
      >
        {(loaded) => <RoomDetailBody roomId={roomId} room={loaded} />}
      </PageScaffold>
      {/* WS-U §24.6/§16.6 — the governance modal (opened by the banner button
          above). Tabs separate the "governed by" transparency view, the member
          model candidacy + vote (with the steward's validation powers), and the
          steward-only settings. Rendered here, beside the scaffold, because its
          trigger now lives in the banner rather than in the page body — and
          only while OPEN, so its subtree costs nothing while a reader browses. */}
      {contentVisible && data !== undefined && governanceOpen ? (
        <RoomGovernanceDialog
          open
          onClose={() => setGovernanceOpen(false)}
          roomId={roomId}
          room={data}
          showSettings={data.is_steward === true && binaryVisibilityUi}
          {...(governanceParam ? { defaultTab: governanceParam } : {})}
        />
      ) : null}
    </>
  );
}

/** WS-Q.5.3a/b — tier-one shell (always) + the content bar; the room feed (with
 *  the in-room chip) renders only once the reader passes the tier-two bar. */
export function RoomDetailBody({
  roomId,
  room,
}: {
  roomId: string;
  room: RoomDetail;
}): React.ReactElement {
  const t = useT();
  const isPrivate = room.visibility === 'private';
  const contentVisible = roomContentVisible(room);
  const feed = useRoomFeedQuery(roomId, contentVisible);
  const roomFeedItems = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Tier-one shell: name (the page <h1>, above), visibility badge,
          description. */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 font-medium text-xs',
            isPrivate ? 'bg-surface-strong text-ink' : 'bg-surface text-ink-muted',
          )}
        >
          {isPrivate
            ? t('room.badge.private', 'Private room')
            : t('room.badge.public', 'Public room')}
        </span>
        {/* WS-M.1.1c — the server-derived governance-mode indicator: always
            visible once the room leaves `ordinary` (a real-asset room must
            never look like a plain room), announced on change. */}
        {room.governance_mode !== 'ordinary' ? (
          <GovernanceModeBadge mode={room.governance_mode} />
        ) : null}
      </div>
      {room.description ? <p className="text-ink-muted">{room.description}</p> : null}

      {/* Membership affordance (WS-Q.5.3a + WS-U §16.6): join to become a member —
          the gate room governance voting enforces. Public rooms join immediately;
          private rooms by request/invite. Handles every state (incl. leave) and
          is independent of content visibility (a public room reads without it). */}
      {/* WS-Q.5.3a + WS-G.2.2 — the compact room action bar: the membership
          button (Sign in / Join / Leave) and the POSTING-lens button (WS-G.2.2 —
          a member's sole control for the interpretation they post through) share
          ONE row, placed ABOVE the feed so neither is buried under a long list of
          story cards. The lens button renders nothing unless the reader is a
          member of a room with lenses. Governance is NOT here: it is a room-wide
          context, so it lives in the banner (WS-U §24.6) beside scoped search. */}
      <RoomMembership
        roomId={roomId}
        room={room}
        {...(roomLensButtonApplies(room)
          ? { trailing: <RoomLensButton roomId={roomId} room={room} /> }
          : {})}
      />

      {/* The governance surface is reached through the banner's circular button
          (RoomDetailPage owns both it and the modal). A separate
          `/rooms/:id/governance` text link was removed: it duplicated that
          control for members and was a silent no-op for non-members (the modal
          is content-visibility-gated, so the legacy redirect only changed the
          URL). The legacy route itself still 301s to `?governance=` for
          bookmarked URLs. */}

      {/* Tier two: the room feed is the PRIMARY content, so it leads (in-room chip
          on every room_only item). */}
      {contentVisible ? (
        feed.isPending ? (
          <p className="text-ink-muted text-sm">{t('room.feed.loading', 'Loading room…')}</p>
        ) : roomFeedItems.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {roomFeedItems.map((item) => (
              <StoryFeedLink key={item.story_id} item={item} />
            ))}
            {/* Explicit continuation gate (never scroll-triggered, §13.6). */}
            {feed.hasNextPage ? (
              <li>
                <DiminishingReturnsPrompt
                  onContinue={() => {
                    if (!feed.isFetchingNextPage) void feed.fetchNextPage();
                  }}
                  {...(feed.isFetchingNextPage
                    ? { continueLabel: t('feed.loadingMore', 'Loading…') }
                    : {})}
                />
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="text-ink-muted text-sm">
            {t('room.feed.empty', 'No posts in this room yet.')}
          </p>
        )
      ) : null}
    </div>
  );
}
