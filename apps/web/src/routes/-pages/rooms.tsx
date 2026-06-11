// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rooms (WS-C.1.1a/b). The /rooms tab lists topic/local rooms and community
// lenses; the detail route shows a room. Room governance is a flag-gated
// sub-route that renders RestrictedState when `governanceEnabled` is off
// (fail-closed, WS-C.1.1d) — the URL stays shareable but inert.
import { Link, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { RestrictedState } from '../../components/ui/RestrictedState/index.js';
import { useT } from '../../i18n/index.js';
import { useRoomQuery, useRoomsQuery } from '../../lib/queries.js';
import { track } from '../../lib/telemetry.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { selectGovernanceEnabled, useFeatureFlagStore } from '../../stores/index.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

export function RoomsPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.rooms', 'Rooms'));
  const rooms = useRoomsQuery();
  return (
    <PageScaffold
      title={t('nav.rooms', 'Rooms')}
      query={rooms}
      isEmpty={(data) => data.items.length === 0}
      emptyTitle={t('rooms.empty.title', 'No rooms yet')}
      emptyDescription={t(
        'rooms.empty.description',
        'Topic rooms and community lenses appear here.',
      )}
    >
      {(data) => (
        <ul className="flex flex-col gap-2">
          {data.items.map((room) => (
            <li key={room.room_id}>
              <Link
                to="/rooms/$roomId"
                params={{ roomId: room.room_id }}
                className="block rounded-lg border border-line p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <span className="font-medium text-ink">{room.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageScaffold>
  );
}

export function RoomDetailPage(): React.ReactElement {
  const t = useT();
  const { roomId } = useParams({ from: '/rooms_/$roomId' });
  usePageFocus(t('room.title', 'Room'));
  const room = useRoomQuery(roomId);

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
    <PageScaffold title={room.data?.name ?? t('room.title', 'Room')} query={room}>
      {(data) => (
        <div className="flex flex-col gap-3">
          {data.description ? <p className="text-ink-muted">{data.description}</p> : null}
          {data.governance !== null ? (
            <Link
              to="/rooms/$roomId/governance"
              params={{ roomId }}
              className="text-primary-on-soft underline"
            >
              {t('room.governance.link', 'Room governance')}
            </Link>
          ) : null}
        </div>
      )}
    </PageScaffold>
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
