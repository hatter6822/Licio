// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rooms (WS-C.1.1a/b). The /rooms tab lists topic/local rooms and community
// lenses; the detail route shows a room. The WS-U room-governance surface opens
// in a modal ON the room page (deep-linkable via `?governance=<tab>`); the legacy
// `/rooms/:id/governance` route redirects here rather than showing an inert stub.
import type { RoomDetail } from '@licio/shared';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { DiminishingReturnsPrompt } from '../../components/feed/DiminishingReturnsPrompt/DiminishingReturnsPrompt.js';
import { RoomGovernanceDialog } from '../../components/governance/RoomGovernanceDialog.js';
import { RoomCreateForm } from '../../components/rooms/RoomCreateForm/index.js';
import { RoomLensButton } from '../../components/rooms/RoomLensControl/index.js';
import { RoomMembership } from '../../components/rooms/RoomMembership/index.js';
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

export function RoomDetailPage(): React.ReactElement {
  const t = useT();
  const { roomId } = useParams({ from: '/rooms_/$roomId' });
  usePageFocus(t('room.title', 'Room'));
  const room = useRoomQuery(roomId);
  const navigate = useNavigate();
  // Return to wherever the room was opened from (the rooms list, a link, a
  // profile); a cold-loaded deep link falls back (replacing) to the rooms list.
  const goBack = useGoBack(() => void navigate({ to: '/rooms', replace: true }));

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
    <PageScaffold title={room.data?.name ?? t('room.title', 'Room')} onBack={goBack} query={room}>
      {(data) => <RoomDetailBody roomId={roomId} room={data} />}
    </PageScaffold>
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
  // Tier two: public rooms are readable by all; private rooms need ACTIVE
  // membership OR a steward role — the server bar (roomContentVisibleToUser)
  // allows stewards, and a freshly-created private room makes its creator a
  // steward WITHOUT an active subscription, so `joined` alone would wrongly
  // show that steward the join UI and never load the feed.
  const contentVisible = !isPrivate || room.joined || room.is_steward === true;
  const feed = useRoomFeedQuery(roomId, contentVisible);
  const roomFeedItems = feed.data?.pages.flatMap((page) => page.items) ?? [];
  // WS-Q.6.2 — the steward settings UI is part of the flag-gated room controls.
  const binaryVisibilityUi = useFeatureFlagStore(selectContentSurface).binary_visibility_ui;
  // WS-U §24.6 — shares GovernedByPanel's cached query (same key) purely to keep
  // at-a-glance transparency in the collapsed disclosure's summary: when an AI
  // agent governs the room, the summary says so even before it is expanded.
  const governedBy = useGovernedByQuery(roomId, contentVisible);
  const agentActive = governedBy.data?.active === true;
  // WS-U §24.6 — the governance surface opens in a focused modal. Its trigger is a
  // COMPACT button that shares the membership action row (passed to RoomMembership
  // as `trailing`), so the room's CONTENT leads and the two controls no longer
  // stack as two full-width blocks. The "AI agent active" badge keeps at-a-glance
  // transparency without opening the modal. A `?governance=<tab>` deep link (the
  // legacy /governance route redirects here) opens the modal to that tab.
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
  const governanceButton = contentVisible ? (
    <Button variant="secondary" onClick={() => setGovernanceOpen(true)} aria-haspopup="dialog">
      <Icon name="check-badge" className="size-4 text-ink-muted" />
      {t('room.governance.button', 'Governance')}
      {agentActive ? (
        <span className="inline-flex items-center rounded-full bg-info-soft px-2 py-0.5 font-medium text-info-on-soft text-xs">
          {t('room.governance.agentActive', 'AI agent active')}
        </span>
      ) : null}
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Tier-one shell: name (in the header), visibility badge, description. */}
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
      {/* WS-Q.5.3a + WS-U §24.6 + WS-G.2.2 — the compact room action bar: the
          membership button (Sign in / Join / Leave), then the POSTING-lens button
          (WS-G.2.2 — a member's sole control for the interpretation they post
          through), then the governance-modal button all share ONE row (both are
          passed as `trailing`, lens BEFORE governance), placed ABOVE the feed so
          no control is buried under a long list of story cards. The lens button
          renders nothing unless the reader is a member of a room with lenses. */}
      <RoomMembership
        roomId={roomId}
        room={room}
        trailing={
          <>
            <RoomLensButton roomId={roomId} room={room} />
            {governanceButton}
          </>
        }
      />

      {room.governance !== null ? (
        <Link
          to="/rooms/$roomId/governance"
          params={{ roomId }}
          className="text-primary-on-soft text-sm underline"
        >
          {t('room.governance.link', 'Room governance')}
        </Link>
      ) : null}

      {/* WS-U §24.6/§16.6 — the governance modal (opened by the compact button
          above). Tabs separate the "governed by" transparency view, the steward's
          model powers + member vote, and the steward-only settings. */}
      {contentVisible ? (
        <RoomGovernanceDialog
          open={governanceOpen}
          onClose={() => setGovernanceOpen(false)}
          roomId={roomId}
          room={room}
          showSettings={room.is_steward === true && binaryVisibilityUi}
          {...(governanceParam ? { defaultTab: governanceParam } : {})}
        />
      ) : null}

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
