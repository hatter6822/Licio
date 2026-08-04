// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the Private P2P rooms surface.  A private room is hosted ONLY on
// members' devices, so this page reads the local `PrivateRoomSession` store (no
// server fetch) and the crypto/protocol core loads lazily through the session
// manager's dynamic import — the route stays out of the initial bundle's crypto
// weight.  `/private` lists this device's rooms + the creation wizard;
// `/private/$roomId` renders one room.
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { CreatePrivateRoomWizard } from '../../components/private-rooms/CreatePrivateRoomWizard/index.js';
import { PrivateRoomDirectory } from '../../components/private-rooms/PrivateRoomDirectory/index.js';
import { PrivateRoomView } from '../../components/private-rooms/PrivateRoomView/index.js';
import { Button } from '../../components/ui/Button/index.js';
import { Card } from '../../components/ui/Card/index.js';
import { EmptyState } from '../../components/ui/EmptyState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useGoBack } from '../../hooks/useGoBack.js';
import { useT } from '../../i18n/index.js';
import type { RoomSummary } from '../../private-p2p/room-manager.js';
import { PrivateRoomSession } from '../../private-p2p/room-manager.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { usePageFocus } from './usePageFocus.js';

export function PrivateRoomsPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('privateRoom.list.title', 'Private rooms'));
  const navigate = useNavigate();
  // Retrace history to wherever the list was opened from (usually the profile
  // menu); a cold-loaded deep link falls back (replacing) to the profile hub.
  const goBack = useGoBack(() => void navigate({ to: '/profile', replace: true }));
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  const refresh = useCallback(() => {
    void PrivateRoomSession.list().then(setRooms);
  }, []);
  useEffect(() => refresh(), [refresh]);

  return (
    <>
      <PageHeader
        title={t('privateRoom.list.title', 'Private rooms')}
        onBack={goBack}
        actions={
          <Button type="button" variant="primary" onClick={() => setShowWizard((s) => !s)}>
            {showWizard
              ? t('privateRoom.list.cancel', 'Cancel')
              : t('privateRoom.list.new', 'New room')}
          </Button>
        }
      />
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
        {showWizard ? (
          <Card>
            <CreatePrivateRoomWizard
              onCreated={(roomId) => {
                setShowWizard(false);
                refresh();
                void navigate({ to: '/private/$roomId', params: { roomId } });
              }}
              // The room can exist while the wizard stays open to report a
              // directory failure — refresh then too, or dismissing that warning
              // leaves a real room missing from this list until a reload.
              onRoomPersisted={() => refresh()}
            />
          </Card>
        ) : null}

        {rooms !== null && rooms.length === 0 && !showWizard ? (
          <EmptyState
            icon="circle-info"
            title={t('privateRoom.list.empty', 'No private rooms on this device')}
            description={t(
              'privateRoom.list.emptyDesc',
              'Create one, or restore a room from a member backup.',
            )}
          />
        ) : null}

        <ul className="flex flex-col gap-2">
          {(rooms ?? []).map((room) => (
            <li key={room.roomId}>
              <Card>
                <Link
                  to="/private/$roomId"
                  params={{ roomId: room.roomId }}
                  className="font-semibold"
                >
                  {room.name}
                </Link>
                <p className="text-ink-muted text-xs">{room.createdAtBucket}</p>
              </Card>
            </li>
          ))}
        </ul>

        {/* §4.2 — rooms that chose to publish a name.  Below this device's own
            rooms, and visibly separate from them: these are not rooms you are
            in, and the only thing the directory can do is tell you they exist. */}
        <div className="border-line border-t pt-4">
          <PrivateRoomDirectory />
        </div>
      </div>
    </>
  );
}

export function PrivateRoomDetailPage(): React.ReactElement {
  const t = useT();
  const { roomId } = useParams({ from: '/private_/$roomId' });
  usePageFocus(t('privateRoom.view.title', 'Private room'));
  const navigate = useNavigate();
  // Retrace history back to wherever this room was opened from (usually the
  // private-rooms list); a cold-loaded deep link falls back (replacing) to it.
  const goBack = useGoBack(() => void navigate({ to: '/private', replace: true }));

  return (
    <>
      <PageHeader title={t('privateRoom.view.title', 'Private room')} onBack={goBack} />
      <div className="mx-auto w-full max-w-2xl p-4">
        {isValidUuidParam(roomId) ? (
          <PrivateRoomView roomId={roomId} />
        ) : (
          <EmptyState
            title={t('privateRoom.view.badId', 'Unknown room')}
            description={t('privateRoom.view.badIdDesc', 'That room link is not valid.')}
          />
        )}
      </div>
    </>
  );
}
