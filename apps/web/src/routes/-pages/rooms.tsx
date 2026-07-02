// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rooms (WS-C.1.1a/b). The /rooms tab lists topic/local rooms and community
// lenses; the detail route shows a room. Room governance is a flag-gated
// sub-route that renders RestrictedState when `governanceEnabled` is off
// (fail-closed, WS-C.1.1d) — the URL stays shareable but inert.
import type { RoomDetail } from '@licio/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ProgressiveDisclosure } from '../../components/cognitive/ProgressiveDisclosure/index.js';
import { GovernedByPanel } from '../../components/governance/GovernedByPanel.js';
import { StewardModelManager } from '../../components/governance/StewardModelManager.js';
import { RoomCreateForm } from '../../components/rooms/RoomCreateForm/index.js';
import { RoomMembership } from '../../components/rooms/RoomMembership/index.js';
import { RoomSettingsForm } from '../../components/rooms/RoomSettingsForm/index.js';
import { StoryFeedLink } from '../../components/story/StoryFeedLink/index.js';
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
import { track } from '../../lib/telemetry.js';
import { isValidUuidParam } from '../../routing/guards.js';
import {
  selectContentSurface,
  selectGovernanceEnabled,
  useFeatureFlagStore,
} from '../../stores/index.js';
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
  // WS-Q.6.2 — the steward settings UI is part of the flag-gated room controls.
  const binaryVisibilityUi = useFeatureFlagStore(selectContentSurface).binary_visibility_ui;
  // WS-U §24.6 — shares GovernedByPanel's cached query (same key) purely to keep
  // at-a-glance transparency in the collapsed disclosure's summary: when an AI
  // agent governs the room, the summary says so even before it is expanded.
  const governedBy = useGovernedByQuery(roomId, contentVisible);
  const agentActive = governedBy.data?.active === true;

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
      </div>
      {room.description ? <p className="text-ink-muted">{room.description}</p> : null}

      {/* Membership affordance (WS-Q.5.3a + WS-U §16.6): join to become a member —
          the gate room governance voting enforces. Public rooms join immediately;
          private rooms by request/invite. Handles every state (incl. leave) and
          is independent of content visibility (a public room reads without it). */}
      <RoomMembership roomId={roomId} room={room} />

      {room.governance !== null ? (
        <Link
          to="/rooms/$roomId/governance"
          params={{ roomId }}
          className="text-primary-on-soft underline"
        >
          {t('room.governance.link', 'Room governance')}
        </Link>
      ) : null}

      {/* Tier two: the room feed is the PRIMARY content, so it leads (in-room chip
          on every room_only item). The governance/steward chrome collapses below. */}
      {contentVisible ? (
        feed.isPending ? (
          <p className="text-ink-muted text-sm">{t('room.feed.loading', 'Loading room…')}</p>
        ) : feed.data && feed.data.items.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {feed.data.items.map((item) => (
              <StoryFeedLink key={item.story_id} item={item} />
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted text-sm">
            {t('room.feed.empty', 'No posts in this room yet.')}
          </p>
        )
      ) : null}

      {/* WS-U §24.6/§16.6 — governance, transparency & steward controls. Collapsed
          by default (WS-B.2.13 progressive disclosure) so the room's CONTENT leads;
          the "governed by" transparency view, the steward's model powers, and the
          steward-only settings are all one tap away. The summary keeps at-a-glance
          transparency: when an AI agent governs the room, it says so unexpanded. */}
      {contentVisible ? (
        <ProgressiveDisclosure
          summary={
            <span className="inline-flex flex-wrap items-center gap-2">
              {t('room.governance.disclosure', 'Governance, transparency & settings')}
              {agentActive ? (
                <span className="inline-flex items-center rounded-full bg-info-soft px-2 py-0.5 font-medium text-info-on-soft text-xs">
                  {t('room.governance.agentActive', 'AI agent active')}
                </span>
              ) : null}
            </span>
          }
        >
          <div className="flex flex-col gap-4">
            {/* WS-Q.5.3c — steward-only room settings (join/posting) + the audited
                public⇄private visibility cascade (gated by the rollout flag). */}
            {room.is_steward && binaryVisibilityUi ? (
              <RoomSettingsForm roomId={roomId} room={room} />
            ) : null}

            {/* WS-U §24.6 — the in-room "governed by" transparency view (active
                agent, granted powers, recent actions, member-downloadable model). */}
            <GovernedByPanel roomId={roomId} />

            {/* WS-U §16.6 — the elected steward's two powers (propose a model +
                prompt; record the community's ratified decision) + the proposal
                registry. The member ratification vote is gated on membership: an
                active subscription (`joined`) OR a room steward role (`is_steward`),
                matching the backend `isRoomMember` gate so an unsubscribed room
                steward can still vote. */}
            <StewardModelManager
              roomId={roomId}
              joined={room.joined}
              isRoomSteward={room.is_steward === true}
            />
          </div>
        </ProgressiveDisclosure>
      ) : null}
    </div>
  );
}

export function RoomGovernancePage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('room.governance.title', 'Room governance'));
  const governanceEnabled = useFeatureFlagStore(selectGovernanceEnabled);
  // Observe reaching the flag-gated governance page (route PATTERN only, no PII).
  useEffect(() => {
    track({ name: 'route_guard', metric: 'restricted', bucket: '/rooms/$roomId/governance' });
  }, []);

  return (
    <>
      <PageHeader title={t('room.governance.title', 'Room governance')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <RestrictedState
          title={t('room.governance.unavailable', 'Governance unavailable')}
          reason={
            governanceEnabled
              ? t('room.governance.soon', 'Room governance is not yet available here.')
              : t('room.governance.disabled', 'Governance features are not enabled.')
          }
        />
      </div>
    </>
  );
}
